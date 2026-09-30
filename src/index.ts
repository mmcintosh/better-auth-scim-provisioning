// better-auth-scim-provisioning: keep users in the apps they use, over SCIM 2.0. A user created,
// changed, banned or deleted in Better Auth (or added to or removed from an organization) is queued
// for each target, and delivered in the background; a scheduled run retries what failed.
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import * as z from "zod";
import { type Adapter, JOB_MODEL, LINK_MODEL, outbox } from "./outbox";
import type { ScimProvisioningOptions } from "./types";

export { defaultScimUser, splitName } from "./mapping";
export { SCIM_USER_SCHEMA, ScimError, type ScimUser } from "./scim-client";
export type { ProvisionedUser, ScimProvisioningOptions, ScimTarget } from "./types";

const optionsSchema = z.object({
  targets: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, - and _ (1-64)"),
        url: z.url({ protocol: /^https?$/ }).refine((u) => u.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(u), "must be https (http only for localhost)"),
        token: z.string().min(1),
        include: z.function().optional(),
        organizationId: z.string().min(1).optional(),
        mapUser: z.function().optional(),
        deprovision: z.enum(["deactivate", "delete"]).optional(),
        timeoutMs: z.number().int().min(100).max(120_000).optional(),
        fetch: z.function().optional(),
      }),
    )
    .refine((t) => new Set(t.map((x) => x.id)).size === t.length, "target ids must be unique"),
  retry: z.object({ maxAttempts: z.number().int().min(1).max(50).optional(), baseDelayMs: z.number().int().min(0).optional() }).optional(),
});

/** A member row (organization plugin) in an endpoint's result: `{ member }`, or the member itself. */
function membersIn(returned: unknown): { userId: string; organizationId: string }[] {
  const isMember = (m: unknown): m is { userId: string; organizationId: string } =>
    !!m && typeof m === "object" && typeof (m as { userId?: unknown }).userId === "string" && typeof (m as { organizationId?: unknown }).organizationId === "string" && "role" in m;
  if (isMember(returned)) return [returned];
  const wrapped = (returned as { member?: unknown } | null)?.member;
  return isMember(wrapped) ? [wrapped] : [];
}

export function scimProvisioning(options: ScimProvisioningOptions) {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) throw new Error(`[scim] invalid options: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);

  let box: ReturnType<typeof outbox> | undefined;
  let background: (p: Promise<unknown>) => void = (p) => void p.catch(() => {});

  /** Queue (target, user) and try to deliver it right away, in the background. */
  async function changed(userId: string, targetIds = options.targets.map((t) => t.id)) {
    if (!box) return;
    const b = box;
    for (const targetId of targetIds) {
      await b.enqueue(targetId, userId);
      background(b.runFor(targetId, userId));
    }
  }

  return {
    id: "scim-provisioning",
    schema: {
      [JOB_MODEL]: {
        fields: {
          key: { type: "string", required: true, unique: true },
          targetId: { type: "string", required: true },
          userId: { type: "string", required: true, index: true },
          version: { type: "number", required: true },
          attempts: { type: "number", required: true },
          nextAttemptAt: { type: "date", required: true, index: true },
          lockedUntil: { type: "date", required: true },
          failed: { type: "boolean", required: true },
          lastError: { type: "string", required: false },
          createdAt: { type: "date", required: true },
          updatedAt: { type: "date", required: true },
        },
      },
      [LINK_MODEL]: {
        fields: {
          key: { type: "string", required: true, unique: true },
          targetId: { type: "string", required: true },
          userId: { type: "string", required: true, index: true },
          remoteId: { type: "string", required: true },
          userName: { type: "string", required: true },
          active: { type: "boolean", required: true },
          syncedAt: { type: "date", required: true },
        },
      },
    },
    init(ctx) {
      box = outbox(options, ctx.adapter as unknown as Adapter, ctx.logger);
      background = (p) => ctx.runInBackground(p.catch((e) => ctx.logger.error("[scim] delivery failed", e)));
      const onUser = async (user: { id: string }) => {
        try {
          await changed(user.id);
        } catch (e) {
          // Never fail the user's own write over provisioning: the next reconcile catches up.
          ctx.logger.error(`[scim] could not queue user ${user.id}`, e);
        }
      };
      return {
        options: {
          databaseHooks: {
            user: {
              create: { after: onUser },
              update: { after: onUser },
              delete: { after: onUser },
            },
          },
        },
      };
    },
    hooks: {
      after: [
        {
          // Membership changes go through the organization plugin's own adapter calls, which
          // Better Auth's database hooks don't see, and its server-side addMember has no path. So
          // look at what an organization call returns: a member row means that user's membership
          // changed. Queue them for the targets of that organization.
          matcher: () => options.targets.some((t) => t.organizationId),
          handler: createAuthMiddleware(async (ctx) => {
            const returned = (ctx.context as { returned?: unknown }).returned;
            if (!returned || returned instanceof Error || !box) return;
            const b = box;
            const queue = async (userId: string, targetIds: string[]) => {
              try {
                await changed(userId, targetIds);
              } catch (e) {
                ctx.context.logger.error(`[scim] could not queue user ${userId}`, e);
              }
            };
            for (const m of membersIn(returned)) {
              await queue(m.userId, options.targets.filter((t) => t.organizationId === m.organizationId).map((t) => t.id));
            }
            // A deleted organization takes its members with it: deprovision everyone linked
            // through its targets.
            if (ctx.path === "/organization/delete") {
              const orgId = (ctx.body as { organizationId?: unknown } | undefined)?.organizationId;
              for (const t of options.targets.filter((x) => typeof orgId === "string" && x.organizationId === orgId)) {
                for (const userId of await b.linkedUsers(t.id)) await queue(userId, [t.id]);
              }
            }
          }),
        },
      ],
    },
    endpoints: {
      /** Deliver what's due (retries included). Call it from a scheduled job, e.g. every minute. */
      scimProvisioningRun: createAuthEndpoint.serverOnly({ method: "POST", body: z.object({ limit: z.number().int().min(1).max(500).optional() }).optional() }, async (ctx) => {
        if (!box) throw new Error("[scim] not initialised");
        return ctx.json(await box.runDue(ctx.body?.limit ?? 50));
      }),
      /**
       * Queue every user for every target (or one): after adding a target, or to repair drift.
       * Delivery then happens through scimProvisioningRun.
       */
      scimProvisioningReconcile: createAuthEndpoint.serverOnly({ method: "POST", body: z.object({ targetId: z.string().optional() }).optional() }, async (ctx) => {
        if (!box) throw new Error("[scim] not initialised");
        const targetIds = ctx.body?.targetId ? [ctx.body.targetId] : options.targets.map((t) => t.id);
        let queued = 0;
        for (let offset = 0; ; offset += 500) {
          const users = (await ctx.context.adapter.findMany({ model: "user", limit: 500, offset, sortBy: { field: "id", direction: "asc" } })) as { id: string }[];
          for (const u of users) {
            for (const t of targetIds) {
              await box.enqueue(t, u.id);
              queued++;
            }
          }
          if (users.length < 500) break;
        }
        return ctx.json({ queued });
      }),
    },
  } satisfies BetterAuthPlugin;
}
