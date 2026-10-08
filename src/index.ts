// better-auth-scim-provisioning: keep users in the apps they use, over SCIM 2.0. A user created,
// changed, banned or deleted in Better Auth (or added to or removed from an organization) is queued
// for each target, and delivered in the background; a scheduled run retries what failed.
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import * as z from "zod";
import { targetUrl } from "./scim-client";
import { type Adapter, GROUP_LINK_MODEL, type GroupRef, IN_BATCH, isPaused, JOB_MODEL, LINK_MODEL, outbox, staticTargets, type TargetSource } from "./outbox";
import { registrySource, secretText, TARGET_MODEL } from "./registry";
import { registryEndpoints } from "./registry-endpoints";
import type { ScimProvisioningOptions, Target } from "./types";

export { defaultScimUser, splitName } from "./mapping";
export { atlassian, awsIamIdentityCenter, cloudflareAccess, githubEnterprise, profiles, slack, slackUserName } from "./profiles";
export { SCIM_GROUP_SCHEMA, SCIM_USER_SCHEMA, ScimError, type ScimGroup, type ScimUser } from "./scim-client";
export type { ScimAuth } from "./credentials";
export { type CheckId, type CheckOptions, type CheckResult, checkScimTarget } from "./doctor";
export { verifyWebhookSignature, WEBHOOK_EVENT_HEADER, WEBHOOK_SCHEMA_VERSION, WEBHOOK_SIGNATURE_HEADER, type WebhookEvent, WebhookSignatureError, webhookSignature } from "./webhook";
export type { StoredTargetView } from "./registry-endpoints";
export type { DeliveryFailure, GoogleWorkspaceTarget, ProvisionedUser, ScimProvisioningOptions, ScimTarget, Target, TargetOptions, TargetRegistryOptions, WebhookTarget } from "./types";


const targetSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, - and _ (1-64)"),
  type: z.enum(["scim", "google-workspace", "webhook"]).optional(),
  secret: secretText(32).optional(),
  url: z.string().optional(),
  google: z
    .strictObject({
      clientEmail: z.string().min(1),
      privateKey: z.string().includes("PRIVATE KEY", { message: "must be the service account's PEM private key" }),
      adminEmail: z.string().min(1),
      orgUnitPath: z.string().startsWith("/").optional(),
      groupDomain: z.string().regex(/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, "a domain, such as example.com").optional(),
      groupEmail: z.function().optional(),
      tokenUrl: z.string().refine(targetUrl, "must be an https URL (http only for localhost)").optional(),
    })
    .optional(),
  token: secretText().optional(),
  auth: z
    .discriminatedUnion("type", [
      z.strictObject({ type: z.literal("bearer"), token: secretText() }),
      z.strictObject({ type: z.literal("basic"), username: secretText(), password: secretText() }),
      z.strictObject({ type: z.literal("header"), name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), value: secretText() }),
      z.strictObject({
        type: z.literal("oauth2"),
        tokenUrl: z.string().refine(targetUrl, "must be an https URL (http only for localhost), without credentials, query or fragment"),
        clientId: z.string().min(1),
        clientSecret: secretText(),
        scope: z.string().optional(),
        clientAuth: z.enum(["body", "basic"]).optional(),
        params: z.record(z.string(), z.string()).optional(),
      }),
    ])
    .optional(),
  include: z.function().optional(),
  requireVerifiedEmail: z.boolean().optional(),
  adopt: z.boolean().optional(),
  organizationId: z.string().min(1).optional(),
  mapUser: z.function().optional(),
  deprovision: z.enum(["deactivate", "delete"]).optional(),
  update: z.enum(["put", "patch"]).optional(),
  compat: z
    .strictObject({
      groupUpdate: z.enum(["put", "patch"]).optional(),
      groupMembers: z.enum(["group", "users-filter"]).optional(),
      maxGroupMembersPerRequest: z.number().int().min(1).max(100_000).optional(),
      groupRename: z.enum(["rename", "recreate"]).optional(),
    })
    .optional(),
  groups: z.union([z.boolean(), z.function()]).optional(),
  groupName: z.function().optional(),
  teamGroups: z.union([z.boolean(), z.function()]).optional(),
  teamGroupName: z.function().optional(),
  roleGroups: z.union([z.boolean(), z.array(z.string().min(1))]).optional(),
  roleGroupName: z.function().optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  fetch: z.function().optional(),
});

const optionsSchema = z.strictObject({
  targets: z
    .array(
      targetSchema
        .refine((t) => t.type === "google-workspace" || t.url !== undefined, { message: "url is required", path: ["url"] })
        .refine((t) => t.url === undefined || t.type === "webhook" || targetUrl(t.url), { message: "must be an https URL (http only for localhost), without credentials, query or fragment", path: ["url"] })
        .refine((t) => t.url === undefined || t.type !== "webhook" || targetUrl(t.url, { query: true }), { message: "must be an https URL (http only for localhost), without credentials or fragment", path: ["url"] })
        .refine((t) => t.type === "google-workspace" || t.type === "webhook" || (t.token === undefined) !== (t.auth === undefined), "give either token or auth")
        .refine((t) => t.type !== "webhook" || (t.secret !== undefined && t.token === undefined && t.auth === undefined && t.google === undefined), "a webhook target takes url and secret, not token, auth or google")
        .refine((t) => t.type === "webhook" || t.secret === undefined, "secret is for webhook targets")
        .refine((t) => t.type !== "google-workspace" || (t.google !== undefined && t.token === undefined && t.auth === undefined), "a google-workspace target takes google, not token or auth")
        .refine((t) => t.type === undefined || t.type === "scim" || t.update === undefined, { message: "update is for scim targets only", path: ["update"] })
        .refine((t) => t.type === undefined || t.type === "scim" || t.compat === undefined, { message: "compat is for scim targets only", path: ["compat"] }),
    )
    .refine((t) => new Set(t.map((x) => x.id)).size === t.length, "target ids must be unique"),
  retry: z.strictObject({ maxAttempts: z.number().int().min(1).max(50).optional(), baseDelayMs: z.number().int().min(0).optional() }).optional(),
  concurrency: z.number().int().min(1).max(32).optional(),
  onFailure: z.function().optional(),
  registry: z
    .strictObject({
      canManage: z.function().optional(),
      organizationRoles: z.array(z.string().min(1)).optional(),
      maxTargetsPerOrganization: z.number().int().min(1).max(1000).optional(),
      allowHosts: z.array(z.string().min(1)).optional(),
      fetch: z.function().optional(),
    })
    .optional(),
});

type SchemaDef = { type?: string; element?: unknown; innerType?: unknown; shape?: Record<string, unknown> };
const defOf = (node: unknown): SchemaDef | undefined => (node as { def?: SchemaDef } | undefined)?.def;
const unwrap = (node: unknown): unknown => (defOf(node)?.type === "optional" ? unwrap(defOf(node)?.innerType) : node);

/** Every key the options object at `path` accepts, for "did you mean" hints on unknown keys. */
function knownKeys(schema: unknown, path: PropertyKey[]): string[] {
  let node = unwrap(schema);
  for (const step of path) {
    const def = defOf(node);
    if (def?.type === "array") node = unwrap(def.element);
    else if (def?.shape && typeof step === "string") node = unwrap(def.shape[step]);
    else return [];
  }
  return Object.keys(defOf(node)?.shape ?? {});
}

/** Edit distance, ignoring case, for spelling hints. */
function distance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) next[j] = Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = next;
  }
  return row[y.length] ?? 0;
}

const TARGET_KEYS = new Set(Object.keys(targetSchema.def.shape));

/** One message per problem; an unknown key names its path and, where it's clear, what was meant. */
function describeIssue(issue: z.core.$ZodIssue): string[] {
  const at = (key: PropertyKey) => [...issue.path, key].join(".");
  if (issue.code !== "unrecognized_keys") return [`${issue.path.join(".")}: ${issue.message}`];
  return issue.keys.map((key) => {
    if (issue.path.length === 0 && TARGET_KEYS.has(key)) return `${at(key)}: unknown option; ${key} is an option of each target (targets[].${key})`;
    const close = (k: string) => distance(key, k) <= Math.max(2, Math.floor(k.length / 4)) || (key.length >= 4 && (k.toLowerCase().startsWith(key.toLowerCase()) || key.toLowerCase().startsWith(k.toLowerCase())));
    const near = knownKeys(optionsSchema, issue.path).filter(close).sort((x, y) => distance(key, x) - distance(key, y))[0];
    return `${at(key)}: unknown option${near ? `; did you mean ${near}?` : ""}`;
  });
}

/**
 * The organization plugin's endpoints that change a membership. Server-side `addMember` has no
 * path, so a path-less call is taken too. Reads (getActiveMember, …) also return member rows and
 * are called on page loads: they must not provision.
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

/** Endpoints that change a team or its members. */
const TEAM_WRITES = new Set(["/organization/create-team", "/organization/update-team", "/organization/remove-team", "/organization/add-team-member", "/organization/remove-team-member"]);

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
  if (!parsed.success) throw new Error(`[scim] invalid options: ${parsed.error.issues.flatMap(describeIssue).join("; ")}`);

  /**
   * Each Better Auth instance's queue and background work, by its database adapter: one plugin
   * object can serve several instances (per-tenant databases; Better Auth also builds a second
   * context from the same options to run migrations), and each must use its own database.
   */
  interface State {
    box: ReturnType<typeof outbox>;
    /** This instance's targets, looked up when used (in code, and with a registry, stored). */
    source: TargetSource;
    adapter: Adapter;
    background: (p: Promise<unknown>) => void;
    /** A user's groups at each target, noted just before they're deleted (see delete.before). */
    deleting: Map<string, { at: number; groups: Map<string, GroupRef[]> }>;
  }
  const states = new WeakMap<object, State>();
  const stateOf = (context: { adapter: unknown }) => states.get(context.adapter as object);

  /** Every row matching, a page at a time (an adapter returns 100 by default), exact matches only. */
  async function findAll<T extends Record<string, unknown>>(adapter: Adapter, model: string, where: { field: string; value: unknown; operator?: "in" }[], keep: (r: T) => boolean): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = (await adapter.findMany({ model, where, limit: 1000, offset, sortBy: { field: "id", direction: "asc" } })) as T[];
      out.push(...page.filter(keep));
      if (page.length < 1000) return out;
    }
  }

  /**
   * The targets each user's change concerns: the unscoped ones for everyone, and an
   * organization's only for its members and for users with an account there (to deactivate).
   * The others' deliveries would do nothing, and with a registry there's a target per organization.
   */
  async function relevantFor(s: State, userIds: readonly string[]): Promise<Map<string, Target[]>> {
    if (!s.source.scoped) {
      const all = await s.source.every();
      return new Map(userIds.map((u) => [u, all]));
    }
    const orgsOf = new Map<string, Set<string>>();
    const linkedOf = new Map<string, Set<string>>();
    const note = (m: Map<string, Set<string>>, k: string, v: string) => m.set(k, (m.get(k) ?? new Set()).add(v));
    // D1 allows 100 bound parameters per query.
    for (let i = 0; i < userIds.length; i += IN_BATCH) {
      const batch = userIds.slice(i, i + IN_BATCH);
      const where = [{ field: "userId", value: batch, operator: "in" as const }];
      for (const m of await findAll<{ userId: string; organizationId: string }>(s.adapter, "member", where, (r) => batch.includes(r.userId))) note(orgsOf, m.userId, m.organizationId);
      for (const l of await findAll<{ userId: string; targetId: string }>(s.adapter, LINK_MODEL, where, (r) => batch.includes(r.userId))) note(linkedOf, l.userId, l.targetId);
    }
    const byId = new Map((await s.source.forOrganizations([...new Set([...orgsOf.values()].flatMap((o) => [...o]))])).map((t) => [t.id, t]));
    // Accounts at targets of organizations they've left (or that are gone).
    for (const id of new Set([...linkedOf.values()].flatMap((l) => [...l]))) {
      if (byId.has(id)) continue;
      const t = await s.source.get(id);
      if (t) byId.set(id, t);
    }
    const targets = [...byId.values()];
    return new Map(userIds.map((u) => [u, targets.filter((t) => !t.organizationId || orgsOf.get(u)?.has(t.organizationId) || linkedOf.get(u)?.has(t.id))]));
  }

  /** The targets with these ids that exist. */
  async function targetsById(s: State, ids: readonly string[]): Promise<Target[]> {
    const out: Target[] = [];
    for (const id of ids) {
      const t = await s.source.get(id);
      if (t) out.push(t);
    }
    return out;
  }

  /**
   * Queue (target, user) and try to deliver it right away, in the background; then, for targets
   * with groups, the user's organizations' groups, so a new user shows up in them at once.
   * Returns how many targets it was queued at.
   */
  async function changed(s: State, userId: string, only?: Target[], formerGroups?: Map<string, GroupRef[]>): Promise<number> {
    const { box: b, background } = s;
    const targets = only ?? (await relevantFor(s, [userId])).get(userId) ?? [];
    for (const target of targets) {
      const targetId = target.id;
      await b.enqueue(targetId, userId);
      // A deleted user's groups, noted before the delete: queued, so they're updated even if this
      // delivery doesn't finish.
      const former = formerGroups?.get(targetId) ?? [];
      for (const ref of former) await b.enqueue(targetId, ref.id, { kind: ref.kind });
      if (isPaused(target)) continue;
      background(
        (async () => {
          await b.runFor(targetId, userId);
          if (b.hasGroups(target)) for (const ref of [...former, ...(await b.groupsOf(target, userId))]) await b.runFor(targetId, ref.id, ref.kind);
        })(),
      );
    }
    return targets.length;
  }

  /** Queue an organization's groups (its own, its teams', its roles') at its targets with groups, and deliver them in the background. */
  async function groupChanged(s: State, organizationId: string, only?: Target[]): Promise<number> {
    const { box: b, background } = s;
    let queued = 0;
    for (const t of (only ?? (await s.source.forOrganizations([organizationId]))).filter((x) => b.hasGroups(x))) {
      const refs = await b.groupsForOrganization(t, organizationId);
      for (const ref of refs) await b.enqueue(t.id, ref.id, { kind: ref.kind });
      queued += refs.length;
      if (!isPaused(t)) background((async () => { for (const ref of refs) await b.runFor(t.id, ref.id, ref.kind); })());
    }
    return queued;
  }

  /**
   * Queue a team's group at the targets with team groups of its organization (a removed team's
   * group is removed: for a team that's gone, the targets that have its group).
   */
  async function teamChanged(s: State, teamId: string, organizationId?: string) {
    const { box: b, background } = s;
    const team = (await s.adapter.findOne({ model: "team", where: [{ field: "id", value: teamId }] })) as { id: string; organizationId: string } | null;
    const org = team?.id === teamId ? team.organizationId : organizationId;
    const byId = new Map((await s.source.forOrganizations(org ? [org] : [])).map((t) => [t.id, t]));
    const links = await findAll<{ subjectId?: string | null; kind?: string | null; targetId: string }>(s.adapter, GROUP_LINK_MODEL, [{ field: "subjectId", value: teamId }], (l) => l.subjectId === teamId && l.kind === "team");
    for (const t of await targetsById(s, links.map((l) => l.targetId).filter((id) => !byId.has(id)))) byId.set(t.id, t);
    for (const t of [...byId.values()].filter((x) => x.teamGroups)) {
      await b.enqueue(t.id, teamId, { kind: "team" });
      if (!isPaused(t)) background(b.runFor(t.id, teamId, "team"));
    }
  }

  /** Set at init: whether the organization plugin has teams (a stored target's teamGroups needs them). */
  let teamsEnabled = false;

  /** A stored target, checked as the options check a target in code. */
  function targetProblems(target: Target): string[] {
    const parsed = optionsSchema.safeParse({ targets: [target] });
    const issues = parsed.success ? [] : parsed.error.issues.flatMap(describeIssue).map((i) => i.replace(/^targets\.0\.?/, "settings."));
    if (target.teamGroups && !teamsEnabled) issues.push("settings.teamGroups: needs the organization plugin's teams");
    return issues;
  }

  /** The first stored target after a removed one's id (stored targets come in id order, after the code ones), that `keep` accepts. */
  const storedAfter = (list: Target[], id: string, keep: (t: Target) => boolean) => list.find((t) => !options.targets.some((c) => c.id === t.id) && t.id > id && keep(t));

  /**
   * Queue everything a target of an organization should have: its members, the users with an
   * account there (to deactivate those who left), and its groups; and make the target's waiting
   * and failed jobs due (`resume`). Queued as one "resync" job, which the deliveries expand a page
   * at a time (the first pages now, in the background; the rest by the scheduled run): an
   * organization of thousands queued in the request would run past a Workers invocation's limits.
   */
  async function resync(s: State, targetId: string, o: { resume: boolean }) {
    const target = await s.source.get(targetId);
    if (!target) return;
    if (o.resume) await s.box.resume(targetId);
    await s.box.enqueue(targetId, "m:", { kind: "resync", now: true });
    if (isPaused(target)) return;
    s.background(
      (async () => {
        // A few batches now; what's left is the scheduled run's.
        for (let i = 0; i < 5; i++) {
          const t = await s.box.runDue(50, targetId);
          if (t.done + t.retry + t.failed === 0) break;
        }
      })(),
    );
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
          /** Taken over from an account made elsewhere: never deleted, only deactivated. */
          adopted: { type: "boolean", required: false },
          syncedAt: { type: "date", required: true },
        },
      },
      [GROUP_LINK_MODEL]: {
        fields: {
          key: { type: "string", required: true, unique: true },
          targetId: { type: "string", required: true, index: true },
          /** The organization the group belongs to (its own group's, or its team's or role's). */
          organizationId: { type: "string", required: true, index: true },
          /** "group" (an organization), "team" or "role"; empty in links written before 1.0. */
          kind: { type: "string", required: false },
          /** The organization's, team's or role's id; empty in links written before 1.0. */
          subjectId: { type: "string", required: false },
          remoteId: { type: "string", required: true, index: true },
          displayName: { type: "string", required: true },
          syncedAt: { type: "date", required: true },
        },
      },
      // Only with the registry: a table nobody uses would still have to be migrated.
      ...(options.registry
        ? {
            [TARGET_MODEL]: {
              fields: {
                targetId: { type: "string", required: true, unique: true },
                /** The organization the target belongs to: the only one it receives. */
                organizationId: { type: "string", required: true, index: true },
                type: { type: "string", required: true },
                /** Its settings, as JSON: data only. */
                config: { type: "string", required: true },
                /** Its credentials, encrypted with Better Auth's secret, bound to this target and organization. */
                sealed: { type: "string", required: true },
                enabled: { type: "boolean", required: true },
                createdAt: { type: "date", required: true },
                updatedAt: { type: "date", required: true },
              },
            },
          }
        : {}),
    },
    init(ctx) {
      // Options that need the organization plugin (or its teams) fail here, not on every delivery.
      const org = (ctx.options.plugins ?? []).find((p) => p.id === "organization") as { options?: { teams?: { enabled?: boolean } } } | undefined;
      for (const t of options.targets) {
        const needs = [t.organizationId && "organizationId", t.groups && "groups", t.roleGroups && "roleGroups", t.teamGroups && "teamGroups"].filter(Boolean);
        if (needs.length && !org) throw new Error(`[scim] target ${t.id}: ${needs.join(", ")} need Better Auth's organization plugin`);
        if (t.teamGroups && !org?.options?.teams?.enabled) throw new Error(`[scim] target ${t.id}: teamGroups needs the organization plugin's teams (organization({ teams: { enabled: true } }))`);
      }
      teamsEnabled = !!org?.options?.teams?.enabled;
      if (options.registry && !org) throw new Error("[scim] registry needs Better Auth's organization plugin: every stored target belongs to an organization");
      const source = options.registry
        ? registrySource(options.targets, ctx.adapter as unknown as Adapter, ctx.secretConfig, options.registry, ctx.logger)
        : staticTargets(options.targets);
      const s: State = {
        box: outbox(options, ctx.adapter as unknown as Adapter, ctx.logger, source),
        source,
        adapter: ctx.adapter as unknown as Adapter,
        background: (p) => ctx.runInBackground(p.catch((e) => ctx.logger.error("[scim] delivery failed", e))),
        deleting: new Map(),
      };
      states.set(ctx.adapter as object, s);
      const { box, deleting } = s;
      const onUser = async (user: { id: string }) => {
        try {
          await changed(s, user.id);
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
              delete: {
                // A user's groups at each target, noted just before the delete: SQL databases delete
                // the member rows with the user, so after it their groups can't be found, and the
                // user would stay in them at the app.
                before: async (user: { id: string }) => {
                  try {
                    const byTarget = new Map<string, GroupRef[]>();
                    for (const t of (await relevantFor(s, [user.id])).get(user.id) ?? []) if (box.hasGroups(t)) byTarget.set(t.id, await box.groupsOf(t, user.id));
                    // Taken by delete.after; a delete stopped after this (another hook, a rollback)
                    // leaves it behind, so old notes are dropped here.
                    for (const [id, note] of deleting) if (note.at < Date.now() - 60_000) deleting.delete(id);
                    deleting.set(user.id, { at: Date.now(), groups: byTarget });
                  } catch (e) {
                    // Never stop the delete: the next reconcile updates the groups.
                    ctx.logger.error(`[scim] could not note the groups of user ${user.id}`, e);
                  }
                },
                after: async (user: { id: string }) => {
                  const former = deleting.get(user.id)?.groups;
                  deleting.delete(user.id);
                  try {
                    await changed(s, user.id, undefined, former);
                  } catch (e) {
                    ctx.logger.error(`[scim] could not queue user ${user.id}`, e);
                  }
                },
              },
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
            // Stored targets come and go at runtime, and all belong to an organization.
            (!!options.registry || options.targets.some((t) => t.organizationId || t.groups || t.teamGroups || t.roleGroups)) &&
            (ctx.path === undefined || MEMBERSHIP_WRITES.has(ctx.path) || ORGANIZATION_WRITES.has(ctx.path) || TEAM_WRITES.has(ctx.path)),
          handler: createAuthMiddleware(async (ctx) => {
            const returned = (ctx.context as { returned?: unknown }).returned;
            const s = stateOf(ctx.context);
            if (!returned || returned instanceof Error || !s) return;
            const { box: b, background } = s;
            // Never fail the write over provisioning (it's done by now): log, and a reconcile catches up.
            const attempt = async (what: string, f: () => Promise<unknown>) => {
              try {
                await f();
              } catch (e) {
                ctx.context.logger.error(`[scim] could not queue ${what}`, e);
              }
            };
            const members = membersIn(returned);
            for (const m of members) {
              await attempt(`user ${m.userId}`, async () => changed(s, m.userId, (await s.source.forOrganizations([m.organizationId])).filter((t) => t.organizationId === m.organizationId)));
            }
            // Groups: the organization whose membership, roles, name or existence changed, and the
            // team that changed.
            const teamIds = new Set<string>();
            const teamOrg = (returned as { organizationId?: unknown } | null)?.organizationId;
            if (ctx.path && TEAM_WRITES.has(ctx.path)) {
              const r = returned as { id?: unknown; teamId?: unknown } | null;
              const body = ctx.body as { teamId?: unknown } | undefined;
              for (const id of [ctx.path.endsWith("-team") ? r?.id : undefined, r?.teamId, body?.teamId]) if (typeof id === "string") teamIds.add(id);
            }
            for (const teamId of teamIds) await attempt(`the group of team ${teamId}`, () => teamChanged(s, teamId, typeof teamOrg === "string" ? teamOrg : undefined));
            const orgIds = new Set(members.map((m) => m.organizationId));
            if (ctx.path && TEAM_WRITES.has(ctx.path) && typeof teamOrg === "string") orgIds.add(teamOrg);
            const own = (returned as { id?: unknown } | null)?.id;
            if (ctx.path === "/organization/create" || ctx.path === "/organization/update") if (typeof own === "string") orgIds.add(own);
            const bodyOrg = (ctx.body as { organizationId?: unknown } | undefined)?.organizationId;
            if (ctx.path === "/organization/delete" && typeof bodyOrg === "string") orgIds.add(bodyOrg);
            for (const orgId of orgIds) await attempt(`the group of organization ${orgId}`, () => groupChanged(s, orgId));
            // A deleted organization takes its members with it: deprovision everyone linked
            // through its targets (paused ones too: their jobs wait). They're queued before the
            // response, so none can be lost if the work after it is cut short (Workers ends it
            // with waitUntil's budget); the deliveries run in the background, one user at a time
            // (never a burst at the app), and whatever doesn't finish there is delivered by the
            // scheduled run.
            if (ctx.path !== "/organization/delete" || typeof bodyOrg !== "string") return;
            const queued: [string, string][] = [];
            await attempt(`the members of deleted organization ${bodyOrg} for deprovisioning; run a reconcile`, async () => {
              for (const t of (await s.source.forOrganizations([bodyOrg])).filter((x) => x.organizationId === bodyOrg)) {
                for await (const userId of b.allLinkedUsers(t.id)) {
                  await b.enqueue(t.id, userId);
                  if (!isPaused(t)) queued.push([t.id, userId]);
                }
              }
            });
            if (queued.length) background((async () => { for (const [targetId, userId] of queued) await b.runFor(targetId, userId); })());
          }),
        },
      ],
    },
    endpoints: {
      // Always there, so they're typed for every app; without `registry` they answer 404 (401 signed out).
      ...registryEndpoints(
        {
          options: options.registry,
          codeIds: options.targets.map((t) => t.id),
          targetProblems,
          instance: (ctx) => {
            const s = stateOf(ctx.context);
            if (!s) return undefined;
            return {
              resync: (targetId, o) => resync(s, targetId, o),
              status: async (targetId) => {
                const [counts] = await s.box.status([targetId]);
                const { id: _, ...rest } = counts as NonNullable<typeof counts>;
                return rest;
              },
              failures: async (targetId) =>
                (await s.box.failures({ targetId, limit: 20 })).items.map((f) => ({ kind: f.kind, subjectId: f.subjectId, failed: f.failed, status: f.lastStatus, nextAttemptAt: f.nextAttemptAt })),
            };
          },
        },
        (ctx) => ctx.context.secretConfig,
      ),
      /**
       * How provisioning stands, per target: jobs queued, stuck (an app error still retried past
       * `retry.maxAttempts`, every 6 hours) and failed (until the user changes or a reconcile),
       * and the accounts and groups at the app. With `userId`, that user's account and pending
       * job at each target.
       */
      scimProvisioningStatus: createAuthEndpoint.serverOnly(
        { method: "POST", body: z.strictObject({ userId: z.string().min(1).optional(), targetId: z.string().optional(), after: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }).optional() },
        async (ctx) => {
          const s = stateOf(ctx.context);
          if (!s) throw new Error("[scim] not initialised");
          const targetId = ctx.body?.targetId;
          let ids: string[];
          let next: string | null = null;
          if (targetId !== undefined) {
            if (!(await s.source.get(targetId))) throw new APIError("BAD_REQUEST", { message: `[scim] unknown target ${targetId}` });
            ids = [targetId];
          } else {
            // A page of targets (`limit`; then `after: next`): each costs a few queries, and with a
            // registry there can be one per organization, so it's 25 by default then.
            const every = await s.source.every();
            const all = every.map((t) => t.id);
            const cursor = ctx.body?.after;
            // A cursor's target removed since (an organization deleted it): on from the next one.
            const resumeAt = cursor === undefined ? undefined : all.includes(cursor) ? cursor : storedAfter(every, cursor, () => true)?.id;
            const from = cursor === undefined ? 0 : resumeAt === undefined ? all.length : all.indexOf(resumeAt) + (resumeAt === cursor ? 1 : 0);
            // Without a registry, every target unless `limit` asks for pages, as before 1.1.
            const limit = ctx.body?.limit ?? (options.registry ? 25 : all.length);
            ids = all.slice(from, from + limit);
            if (from + limit < all.length) next = ids[ids.length - 1] ?? null;
          }
          const userId = ctx.body?.userId;
          return ctx.json(userId ? { user: await s.box.userStatus(userId, ids), next } : { targets: await s.box.status(ids), next });
        },
      ),
      /**
       * Queue at every target, or one, and deliver in the background, for changes Better Auth's
       * endpoints don't show this plugin (memberships written by an SSO sync, inbound SCIM or your
       * own code): a user (and the groups they're in), and/or an organization's groups (its own,
       * its teams', its roles'). For someone removed from an organization, pass both: the user
       * isn't in that organization's groups any more, so only `organizationId` updates them.
       */
      scimProvisioningQueue: createAuthEndpoint.serverOnly(
        {
          method: "POST",
          body: z
            .strictObject({ userId: z.string().min(1).optional(), organizationId: z.string().min(1).optional(), targetId: z.string().optional() })
            .refine((b) => b.userId !== undefined || b.organizationId !== undefined, "give userId, organizationId, or both"),
        },
        async (ctx) => {
          const s = stateOf(ctx.context);
          if (!s) throw new Error("[scim] not initialised");
          const { userId, organizationId, targetId } = ctx.body;
          const one = targetId === undefined ? undefined : await s.source.get(targetId);
          if (one === null) throw new APIError("BAD_REQUEST", { message: `[scim] unknown target ${targetId}` });
          let queued = 0;
          // At every target the change concerns (an organization's: its members and those with an account there), or the one named.
          if (userId) queued += await changed(s, userId, one ? [one] : undefined);
          if (organizationId) queued += await groupChanged(s, organizationId, one ? [one] : undefined);
          return ctx.json({ queued });
        },
      ),
      /**
       * The jobs that need someone to look at them, a page at a time (`limit`, 100 by default;
       * then `after: next`): failed (until the user or group changes again, or a reconcile) and
       * stuck (an app error still retried past `retry.maxAttempts`, every 6 hours).
       */
      scimProvisioningFailures: createAuthEndpoint.serverOnly(
        { method: "POST", body: z.strictObject({ targetId: z.string().optional(), after: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }).optional() },
        async (ctx) => {
          const s = stateOf(ctx.context);
          if (!s) throw new Error("[scim] not initialised");
          const targetId = ctx.body?.targetId;
          if (targetId !== undefined && !(await s.source.get(targetId))) throw new APIError("BAD_REQUEST", { message: `[scim] unknown target ${targetId}` });
          return ctx.json(await s.box.failures({ targetId, after: ctx.body?.after, limit: ctx.body?.limit ?? 100 }));
        },
      ),
      /** Deliver what's due (retries included). Call it from a scheduled job, e.g. every minute. */
      scimProvisioningRun: createAuthEndpoint.serverOnly({ method: "POST", body: z.strictObject({ limit: z.number().int().min(1).max(500).optional() }).optional() }, async (ctx) => {
        const s = stateOf(ctx.context);
        if (!s) throw new Error("[scim] not initialised");
        return ctx.json(await s.box.runDue(ctx.body?.limit ?? 50));
      }),
      /**
       * Queue every user for every target (or one), and every user still linked at a target who no
       * longer exists (deleted users whose deprovisioning was lost): after adding or fixing a
       * target, or to repair drift. Delivery then happens through scimProvisioningRun. One page at
       * a time (`limit`, 500 by default): call again with `after: next` until `next` is null.
       */
      scimProvisioningReconcile: createAuthEndpoint.serverOnly(
        {
          method: "POST",
          body: z.strictObject({ targetId: z.string().optional(), after: z.string().optional(), limit: z.number().int().min(1).max(10_000).optional() }).optional(),
        },
        async (ctx) => {
          const s = stateOf(ctx.context);
          if (!s) throw new Error("[scim] not initialised");
          const b = s.box;
          const targetId = ctx.body?.targetId;
          const one = targetId === undefined ? undefined : await s.source.get(targetId);
          if (one === null) throw new APIError("BAD_REQUEST", { message: `[scim] unknown target ${targetId}` });
          const targetList = one ? [one] : await s.source.every();
          const all = targetList.map((t) => t.id);
          const targetIds = all;
          // A page at a time, 500 by default: all at once would run past a Workers invocation.
          let budget = ctx.body?.limit ?? 500;
          let queued = 0;
          // The cursor: "u:<last user id>" while walking users, then "l:<target>:<last user id>"
          // while walking each target's links, then the groups ("g:…", "G:…", below).
          let cursor = ctx.body?.after ?? "u:";
          const handedOut = /^(u:.*|([lgG]):([A-Za-z0-9_-]{1,64}):.*)$/.exec(cursor);
          if (!handedOut) throw new APIError("BAD_REQUEST", { message: "[scim] unknown cursor: pass `after` the `next` of a previous reconcile" });
          const gone = handedOut[3];
          if (gone !== undefined && !all.includes(gone)) {
            // Its target was removed since (an organization deleted it): go on from the next one.
            // Stored targets come in id order after the code ones, which can't be removed while running.
            const after = storedAfter(targetList, gone, handedOut[2] === "l" ? () => true : b.hasGroups);
            if (handedOut[2] === "l") cursor = after ? `l:${after.id}:` : "g::";
            else if (after) cursor = `g:${after.id}:`;
            else return ctx.json({ queued: 0, next: null as string | null });
          }
          const page = () => Math.min(500, budget);
          // A caller from 0.3 (no limit, no cursor) expected everything in one call: say it isn't.
          const stopped = (next: string) => {
            if (ctx.body?.limit === undefined && ctx.body?.after === undefined)
              ctx.context.logger.warn(`[scim] reconcile queued ${queued} and stopped at its default page of 500: call again with \`after: next\` until next is null`);
            return ctx.json({ queued, next });
          };

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
              // Each user at the targets that concern them: an organization's target only for its
              // members (and those with an account there, as the next phase covers too).
              const relevant = await relevantFor(s, users.map((u) => u.id));
              for (const u of users) {
                for (const t of relevant.get(u.id) ?? []) {
                  if (!targetIds.includes(t.id)) continue;
                  await b.enqueue(t.id, u.id, { now: true });
                  queued++;
                }
                last = u.id;
              }
              budget -= users.length;
              if (users.length < size) break;
              if (budget <= 0) return stopped(`u:${last}`);
            }
          }

          if (cursor.startsWith("u:") || cursor.startsWith("l:")) {
            const [, fromTarget = targetIds[0], fromUser = ""] = cursor.startsWith("l:") ? (/^l:([^:]*):(.*)$/.exec(cursor) ?? []) : [];
            for (const t of targetIds.slice(Math.max(0, targetIds.indexOf(fromTarget as string)))) {
              let last: string | null = t === fromTarget && fromUser ? fromUser : null;
              for (;;) {
                if (budget <= 0) return stopped(`l:${t}:${last ?? ""}`);
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
                // Each target costs at least one, however few links it has: with a registry there can be
                // one per organization, and `limit` must bound the call.
                budget -= Math.max(1, linked.length);
                if (linked.length < size) break;
                if (budget <= 0) return stopped(`l:${t}:${last}`);
              }
            }
          }

          // Groups: every organization at targets with groups ("g:<target>:<last organization id>"),
          // then every linked group, so those whose organization, team or role is gone are removed
          // ("G:<target>:<last link key>"). Paged like the rest: on Workers and D1, doing all of
          // it in one call ran past the per-call limits once there were a few hundred organizations.
          const groupTargets = targetList.filter((x) => targetIds.includes(x.id) && b.hasGroups(x)).map((x) => x.id);
          const [, phase = "g", fromGroupTarget = groupTargets[0], fromGroup = ""] = /^([gG]):([^:]*):(.*)$/.exec(cursor) ?? [];
          for (const t of groupTargets.slice(Math.max(0, groupTargets.indexOf(fromGroupTarget as string)))) {
            const target = targetList.find((x) => x.id === t);
            if (!target) continue;
            const resuming = t === fromGroupTarget;
            if ((!resuming || phase === "g") && target.organizationId) {
              // An organization's target: its own organization's groups, not a walk of every organization.
              if (budget <= 0) return stopped(`g:${t}:`);
              const refs = await b.groupsForOrganization(target, target.organizationId);
              for (const ref of refs) {
                await b.enqueue(t, ref.id, { kind: ref.kind, now: true });
                queued++;
              }
              budget -= Math.max(1, refs.length);
            } else if (!resuming || phase === "g") {
              let after: string | null = resuming && fromGroup ? fromGroup : null;
              for (;;) {
                if (budget <= 0) return stopped(`g:${t}:${after ?? ""}`);
                const size = page();
                const orgs = (await ctx.context.adapter.findMany({ model: "organization", where: after === null ? [] : [{ field: "id", value: after, operator: "gt" }], limit: size, sortBy: { field: "id", direction: "asc" } })) as { id: string }[];
                for (const o of orgs) {
                  for (const ref of await b.groupsForOrganization(target, o.id)) {
                    await b.enqueue(t, ref.id, { kind: ref.kind, now: true });
                    queued++;
                  }
                  after = o.id;
                }
                budget -= orgs.length;
                if (orgs.length < size) break;
              }
            }
            let afterKey: string | null = resuming && phase === "G" && fromGroup ? fromGroup : null;
            for (;;) {
              if (budget <= 0) return stopped(`G:${t}:${afterKey ?? ""}`);
              const size = page();
              const linked = await b.linkedGroups(t, afterKey, size);
              for (const l of linked) {
                await b.enqueue(t, l.ref.id, { kind: l.ref.kind, now: true });
                queued++;
                afterKey = l.key;
              }
              budget -= Math.max(1, linked.length);
              if (linked.length < size) break;
            }
          }
          return ctx.json({ queued, next: null as string | null });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
