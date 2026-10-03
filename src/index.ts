// better-auth-scim-provisioning: keep users in the apps they use, over SCIM 2.0. A user created,
// changed, banned or deleted in Better Auth (or added to or removed from an organization) is queued
// for each target, and delivered in the background; a scheduled run retries what failed.
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import * as z from "zod";
import { type Adapter, GROUP_LINK_MODEL, IN_BATCH, JOB_MODEL, LINK_MODEL, outbox } from "./outbox";
import type { ScimProvisioningOptions } from "./types";

export { defaultScimUser, splitName } from "./mapping";
export { SCIM_USER_SCHEMA, ScimError, type ScimUser } from "./scim-client";
export type { ScimAuth } from "./credentials";
export { type CheckOptions, type CheckResult, checkScimTarget } from "./doctor";
export type { ProvisionedUser, ScimProvisioningOptions, ScimTarget } from "./types";

/**
 * A SCIM base URL: https, or http to a loopback address; no credentials, query or fragment, which
 * would send the token elsewhere or break every path built on it (S2-13).
 */
function targetUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.username || u.password || u.search || u.hash || value.includes("?") || value.includes("#")) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

const optionsSchema = z.object({
  targets: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, - and _ (1-64)"),
        url: z.string().refine(targetUrl, "must be an https URL (http only for localhost), without credentials, query or fragment"),
        token: z.string().min(1).optional(),
        auth: z
          .discriminatedUnion("type", [
            z.object({ type: z.literal("bearer"), token: z.string().min(1) }),
            z.object({ type: z.literal("basic"), username: z.string().min(1), password: z.string().min(1) }),
            z.object({ type: z.literal("header"), name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), value: z.string().min(1) }),
            z.object({
              type: z.literal("oauth2"),
              tokenUrl: z.string().refine(targetUrl, "must be an https URL (http only for localhost), without credentials, query or fragment"),
              clientId: z.string().min(1),
              clientSecret: z.string().min(1),
              scope: z.string().optional(),
              clientAuth: z.enum(["body", "basic"]).optional(),
              params: z.record(z.string(), z.string()).optional(),
            }),
          ])
          .optional(),
        include: z.function().optional(),
        requireVerifiedEmail: z.boolean().optional(),
        organizationId: z.string().min(1).optional(),
        mapUser: z.function().optional(),
        deprovision: z.enum(["deactivate", "delete"]).optional(),
        update: z.enum(["put", "patch"]).optional(),
        groups: z.union([z.boolean(), z.function()]).optional(),
        groupName: z.function().optional(),
        timeoutMs: z.number().int().min(100).max(120_000).optional(),
        fetch: z.function().optional(),
      }).refine((t) => (t.token === undefined) !== (t.auth === undefined), "give either token or auth"),
    )
    .refine((t) => new Set(t.map((x) => x.id)).size === t.length, "target ids must be unique"),
  retry: z.object({ maxAttempts: z.number().int().min(1).max(50).optional(), baseDelayMs: z.number().int().min(0).optional() }).optional(),
  concurrency: z.number().int().min(1).max(32).optional(),
});

/**
 * The organization plugin's endpoints that change a membership. Server-side `addMember` has no
 * path, so a path-less call is taken too. Reads (getActiveMember, …) also return member rows and
 * are called on page loads: they must not provision (S1-2).
 */
const MEMBERSHIP_WRITES = new Set([
  "/organization/add-member",
  "/organization/remove-member",
  "/organization/update-member-role",
  "/organization/accept-invitation",
  "/organization/leave",
  "/organization/delete",
]);

/** Endpoints that change an organization itself (its group's name, or its existence). */
const ORGANIZATION_WRITES = new Set(["/organization/create", "/organization/update", "/organization/delete"]);

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

  /**
   * Queue (target, user) and try to deliver it right away, in the background; then, for targets
   * with groups, the user's organizations' groups, so a new user shows up in them at once.
   */
  async function changed(userId: string, targetIds = options.targets.map((t) => t.id)) {
    if (!box) return;
    const b = box;
    for (const targetId of targetIds) {
      await b.enqueue(targetId, userId);
      const target = options.targets.find((t) => t.id === targetId);
      background(
        (async () => {
          await b.runFor(targetId, userId);
          if (target?.groups) for (const org of await b.groupsOf(target, userId)) await b.runFor(targetId, org, "group");
        })(),
      );
    }
  }

  /** Queue an organization's group at every target that has it, and deliver it in the background. */
  async function groupChanged(organizationId: string) {
    if (!box) return;
    const b = box;
    for (const t of options.targets.filter((x) => x.groups && (!x.organizationId || x.organizationId === organizationId))) {
      await b.enqueue(t.id, organizationId, { kind: "group" });
      background(b.runFor(t.id, organizationId, "group"));
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
          lastStatus: { type: "number", required: false },
          kind: { type: "string", required: false },
          createdAt: { type: "date", required: true },
          updatedAt: { type: "date", required: true },
        },
      },
      [LINK_MODEL]: {
        fields: {
          key: { type: "string", required: true, unique: true },
          targetId: { type: "string", required: true, index: true },
          userId: { type: "string", required: true, index: true },
          remoteId: { type: "string", required: true, index: true },
          userName: { type: "string", required: true },
          externalId: { type: "string", required: false },
          active: { type: "boolean", required: true },
          syncedAt: { type: "date", required: true },
        },
      },
      [GROUP_LINK_MODEL]: {
        fields: {
          key: { type: "string", required: true, unique: true },
          targetId: { type: "string", required: true, index: true },
          organizationId: { type: "string", required: true },
          remoteId: { type: "string", required: true, index: true },
          displayName: { type: "string", required: true },
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
          // Better Auth's database hooks don't see. So after a membership write, look at what it
          // returned: a member row names the user whose membership changed. Queue them for the
          // targets of that organization.
          matcher: (ctx) =>
            options.targets.some((t) => t.organizationId || t.groups) && (ctx.path === undefined || MEMBERSHIP_WRITES.has(ctx.path) || ORGANIZATION_WRITES.has(ctx.path)),
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
            const members = membersIn(returned);
            for (const m of members) {
              await queue(m.userId, options.targets.filter((t) => t.organizationId === m.organizationId).map((t) => t.id));
            }
            // Groups: the organization whose membership, name or existence changed.
            if (options.targets.some((t) => t.groups)) {
              const orgIds = new Set(members.map((m) => m.organizationId));
              const own = (returned as { id?: unknown } | null)?.id;
              if (ctx.path === "/organization/create" || ctx.path === "/organization/update") if (typeof own === "string") orgIds.add(own);
              const bodyOrg = (ctx.body as { organizationId?: unknown } | undefined)?.organizationId;
              if (ctx.path === "/organization/delete" && typeof bodyOrg === "string") orgIds.add(bodyOrg);
              for (const orgId of orgIds) {
                try {
                  await groupChanged(orgId);
                } catch (e) {
                  ctx.context.logger.error(`[scim] could not queue the group of organization ${orgId}`, e);
                }
              }
            }
            // A deleted organization takes its members with it: deprovision everyone linked
            // through its targets. In the background, one user at a time: never in the way of
            // the request, and never a burst at the app (S2-6, S2-10). Whatever doesn't finish
            // is left queued for the scheduled run, or found by the next reconcile.
            const orgId = (ctx.body as { organizationId?: unknown } | undefined)?.organizationId;
            const orgTargets = options.targets.filter((t) => ctx.path === "/organization/delete" && typeof orgId === "string" && t.organizationId === orgId);
            if (orgTargets.length) {
              background(
                (async () => {
                  const queued: [string, string][] = [];
                  for (const t of orgTargets) {
                    for await (const userId of b.allLinkedUsers(t.id)) {
                      try {
                        await b.enqueue(t.id, userId);
                        queued.push([t.id, userId]);
                      } catch (e) {
                        ctx.context.logger.error(`[scim] could not queue user ${userId}`, e);
                      }
                    }
                  }
                  for (const [targetId, userId] of queued) await b.runFor(targetId, userId);
                })(),
              );
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
       * Queue every user for every target (or one), and every user still linked at a target who no
       * longer exists (deleted users whose deprovisioning was lost, S1-5): after adding or fixing a
       * target, or to repair drift. Delivery then happens through scimProvisioningRun. With
       * `limit`, one page at a time: call again with `after: next` until `next` is null (S2-6).
       */
      scimProvisioningReconcile: createAuthEndpoint.serverOnly(
        {
          method: "POST",
          body: z.object({ targetId: z.string().optional(), after: z.string().optional(), limit: z.number().int().min(1).max(10_000).optional() }).optional(),
        },
        async (ctx) => {
          if (!box) throw new Error("[scim] not initialised");
          const b = box;
          const all = options.targets.map((t) => t.id);
          const targetId = ctx.body?.targetId;
          if (targetId !== undefined && !all.includes(targetId)) throw new APIError("BAD_REQUEST", { message: `[scim] unknown target ${targetId}` });
          const targetIds = targetId ? [targetId] : all;
          let budget = ctx.body?.limit ?? Number.POSITIVE_INFINITY;
          let queued = 0;
          // The cursor: "u:<last user id>" while walking users, then "l:<target>:<last user id>"
          // while walking each target's links.
          const cursor = ctx.body?.after ?? "u:";
          const page = () => Math.min(500, budget);

          if (cursor.startsWith("u:")) {
            let last = cursor.slice(2) || null;
            for (;;) {
              const size = page();
              const users = (await ctx.context.adapter.findMany({
                model: "user",
                where: last === null ? [] : [{ field: "id", value: last, operator: "gt" }],
                limit: size,
                sortBy: { field: "id", direction: "asc" },
              })) as { id: string }[];
              for (const u of users) {
                for (const t of targetIds) await b.enqueue(t, u.id, { now: true });
                queued += targetIds.length;
                last = u.id;
              }
              budget -= users.length;
              if (users.length < size) break;
              if (budget <= 0) return ctx.json({ queued, next: `u:${last}` });
            }
          }

          const [, fromTarget = targetIds[0], fromUser = ""] = cursor.startsWith("l:") ? (/^l:([^:]*):(.*)$/.exec(cursor) ?? []) : [];
          for (const t of targetIds.slice(Math.max(0, targetIds.indexOf(fromTarget as string)))) {
            let last: string | null = t === fromTarget && fromUser ? fromUser : null;
            for (;;) {
              if (budget <= 0) return ctx.json({ queued, next: `l:${t}:${last ?? ""}` });
              const size = page();
              const linked = await b.linkedUsers(t, last, size);
              if (linked.length) {
                // D1 allows 100 bound parameters per query: look the ids up in batches.
                const existing = new Set<string>();
                for (let i = 0; i < linked.length; i += IN_BATCH) {
                  const ids = linked.slice(i, i + IN_BATCH);
                  const found = (await ctx.context.adapter.findMany({ model: "user", where: [{ field: "id", value: ids, operator: "in" }], limit: ids.length })) as { id: string }[];
                  for (const u of found) existing.add(u.id);
                }
                for (const userId of linked) {
                  if (!existing.has(userId)) {
                    await b.enqueue(t, userId, { now: true });
                    queued++;
                  }
                  last = userId;
                }
              }
              budget -= linked.length;
              if (linked.length < size) break;
              if (budget <= 0) return ctx.json({ queued, next: `l:${t}:${last}` });
            }
          }
          // Groups: every organization at targets with groups, and every linked group whose
          // organization is gone (removed at the app).
          for (const t of options.targets.filter((x) => targetIds.includes(x.id) && x.groups)) {
            const orgIds = new Set<string>();
            for (let after: string | null = null; ; ) {
              const orgs = (await ctx.context.adapter.findMany({ model: "organization", where: after === null ? [] : [{ field: "id", value: after, operator: "gt" }], limit: 500, sortBy: { field: "id", direction: "asc" } })) as { id: string }[];
              for (const o of orgs) if (!t.organizationId || t.organizationId === o.id) orgIds.add(o.id);
              if (orgs.length < 500) break;
              after = (orgs[orgs.length - 1] as { id: string }).id;
            }
            for (const orgId of await b.linkedGroups(t.id)) orgIds.add(orgId);
            for (const orgId of orgIds) {
              await b.enqueue(t.id, orgId, { kind: "group", now: true });
              queued++;
            }
          }
          return ctx.json({ queued, next: null as string | null });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
