// The target registry's API: organizations' administrators connect, change, check and remove
// their organization's targets; the host's administrators (`registry.canManage`) any organization's.
// Every route needs a fresh session (checked against the database), of a user who isn't banned
// or impersonated, decided on memberships as the database has them now, never the session's
// active organization. Credentials go in and never come out: a target shows only their kind, and
// they're never sent anywhere new (a change of where a target sends needs them given again).
// The routes are always there (so they're typed for every app); without `registry` they're 404.
import type { GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, sensitiveSessionMiddleware } from "better-auth/api";
import * as z from "zod";
import { type Adapter, clientFor, GROUP_LINK_MODEL, JOB_MODEL, LINK_MODEL } from "./outbox";
import {
  assemble,
  credentialsKind,
  guardedFetch,
  type SealKey,
  seal,
  type StoredCredentials,
  type StoredSettings,
  storedCredentialsSchema,
  storedProblems,
  storedSettingsSchema,
  TARGET_MODEL,
  type TargetRow,
  unseal,
} from "./registry";
import { ScimError } from "./scim-client";
import type { Target, TargetRegistryOptions } from "./types";

const MAX_CONFIG_BYTES = 16 * 1024;

/** What the endpoints need from the plugin's instance. */
export interface RegistryHost {
  /** Undefined without `registry`: every route answers 404. */
  options: TargetRegistryOptions | undefined;
  /** Ids of the targets in code: a stored one never takes one, in any case. */
  codeIds: string[];
  /** Problems with a whole target, as the plugin's option checks see them. */
  targetProblems(target: Target): string[];
  /** This instance's outbox, for a target's organization. */
  instance(ctx: GenericEndpointContext):
    | {
        resync(organizationId: string, targetId: string): Promise<void>;
        status(targetId: string): Promise<{ queued: number; waiting: number; stuck: number; failed: number; accounts: number; groups: number }>;
        failures(targetId: string): Promise<{ kind: string; subjectId: string; failed: boolean; status: number | null; nextAttemptAt: string }[]>;
      }
    | undefined;
}

/** A stored target as the API shows it: no credentials, and a webhook URL without its path or query (Slack's and Azure's carry secrets). */
export interface StoredTargetView {
  id: string;
  organizationId: string;
  type: string;
  enabled: boolean;
  settings: StoredSettings;
  credentials: { kind: ReturnType<typeof credentialsKind> | "unreadable" };
  createdAt: Date | string;
  updatedAt: Date | string;
}

const refuse = (status: "FORBIDDEN" | "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT", message: string, issues?: string[]) =>
  new APIError(status, { message: `[scim] ${message}`, ...(issues ? { issues } : {}) });

/** What's shown of a URL: all of a SCIM base URL; of a webhook's, the origin only. */
const shownUrl = (type: string, url: string | undefined) => {
  if (url === undefined || type !== "webhook") return url;
  try {
    const u = new URL(url);
    return u.pathname === "/" && !u.search ? u.origin : `${u.origin}/…`;
  } catch {
    return "…";
  }
};

const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
const isBanned = (user: Record<string, unknown>) => {
  if (!truthy(user.banned)) return false;
  const exp = user.banExpires;
  if (exp === null || exp === undefined) return true;
  const t = new Date(exp as string | number | Date).getTime();
  return Number.isNaN(t) || t > Date.now();
};

/** The settings that say where a target sends (and as whom): changing one needs the credentials given again. */
const destination = (s: StoredSettings) => JSON.stringify([s.url ?? null, s.google?.clientEmail ?? null, s.google?.adminEmail ?? null]);

interface Actor {
  userId: string;
  /** A host administrator: every organization. */
  host: boolean;
  /** Otherwise, the organizations it administers. */
  organizations: ReadonlySet<string>;
}
const may = (actor: Actor, organizationId: string) => actor.host || actor.organizations.has(organizationId);

async function actorOf(ctx: GenericEndpointContext, options: TargetRegistryOptions | undefined): Promise<Actor> {
  if (!options) throw refuse("NOT_FOUND", "the target registry isn't enabled (registry option)");
  const s = (ctx.context as { session?: { user: { id: string }; session: Record<string, unknown> } }).session;
  if (!s) throw refuse("FORBIDDEN", "sign in to manage targets");
  // An administrator acting as someone else doesn't manage targets as them.
  if (s.session.impersonatedBy) throw refuse("FORBIDDEN", "not while impersonating");
  const user = (await ctx.context.internalAdapter.findUserById(s.user.id)) as (Record<string, unknown> & { id: string }) | null;
  if (!user || isBanned(user)) throw refuse("FORBIDDEN", "not allowed");
  let host = false;
  if (options.canManage) {
    try {
      host = (await options.canManage({ user, session: s.session })) === true;
    } catch (e) {
      ctx.context.logger.error("[scim] registry.canManage threw", e);
    }
  }
  const roles = options.organizationRoles ?? ["owner", "admin"];
  const organizations = new Set<string>();
  if (!host && roles.length) {
    const adapter = ctx.context.adapter as unknown as Adapter;
    for (let offset = 0; ; offset += 1000) {
      const page = (await adapter.findMany({ model: "member", where: [{ field: "userId", value: user.id }], limit: 1000, offset, sortBy: { field: "id", direction: "asc" } })) as { userId: string; organizationId: string; role?: string | null }[];
      // Exact match: a case-insensitive collation mustn't widen it. Better Auth stores several roles comma-separated.
      for (const m of page) if (m.userId === user.id && String(m.role ?? "").split(",").some((r) => roles.includes(r.trim()))) organizations.add(m.organizationId);
      if (page.length < 1000) break;
    }
  }
  if (!host && organizations.size === 0) throw refuse("FORBIDDEN", "not allowed");
  return { userId: user.id, host, organizations };
}

/** What a check found, in broad terms only: never the app's own words, which would make this a way to read internal services. */
function checkResult(e: unknown): { ok: false; problem: string; status?: number } {
  const status = e instanceof ScimError ? e.status : null;
  if (status === null) return { ok: false, problem: e instanceof ScimError ? "no answer (the host can't be reached, or didn't answer in time)" : "the request couldn't be made" };
  const problem =
    status === 401 || status === 403
      ? "the credentials were refused"
      : status === 404
        ? "not found: check the URL"
        : status >= 300 && status < 400
          ? "redirected: use the final URL"
          : status === 429
            ? "rate limited: try again later"
            : status >= 500
              ? "the app had an error"
              : "the app refused the request";
  return { ok: false, problem, status };
}

export function registryEndpoints(host: RegistryHost, key: (ctx: GenericEndpointContext) => SealKey) {
  const adapterOf = (ctx: GenericEndpointContext) => ctx.context.adapter as unknown as Adapter;
  const audit = (ctx: GenericEndpointContext, actor: Actor, what: string) => ctx.context.logger.info(`[scim] registry: user ${actor.userId}${actor.host ? " (host administrator)" : ""} ${what}`);
  const instance = (ctx: GenericEndpointContext) => {
    const i = host.instance(ctx);
    if (!i) throw new Error("[scim] not initialised");
    return i;
  };

  /** The row with this id, if the actor may see it; otherwise 404, so others' targets aren't confirmed to exist. */
  async function rowFor(ctx: GenericEndpointContext, actor: Actor, id: string): Promise<TargetRow> {
    const rows = (await adapterOf(ctx).findMany({ model: TARGET_MODEL, where: [{ field: "targetId", value: id }], limit: 2 })) as TargetRow[];
    const row = rows.find((r) => r.targetId === id);
    if (!row || !may(actor, row.organizationId)) throw refuse("NOT_FOUND", `no target ${id}`);
    return row;
  }

  const settingsOf = (row: TargetRow): StoredSettings => {
    try {
      return storedSettingsSchema.parse(JSON.parse(row.config));
    } catch {
      return {};
    }
  };

  function view(row: TargetRow, credentials: StoredCredentials | null): StoredTargetView {
    const settings = settingsOf(row);
    return {
      id: row.targetId,
      organizationId: row.organizationId,
      type: row.type,
      enabled: truthy(row.enabled),
      settings: { ...settings, ...(settings.url !== undefined ? { url: shownUrl(row.type, settings.url) } : {}) },
      credentials: { kind: credentials ? credentialsKind(credentials) : "unreadable" },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  const readable = async (ctx: GenericEndpointContext, row: TargetRow) => unseal(key(ctx), row).catch(() => null);

  /** Settings and credentials checked as a whole target; throws 400 with every problem. */
  function check(ids: { targetId: string; organizationId: string }, rawSettings: unknown, rawCredentials: unknown) {
    if (JSON.stringify(rawSettings ?? {}).length > MAX_CONFIG_BYTES) throw refuse("BAD_REQUEST", "settings are too large");
    const settings = storedSettingsSchema.safeParse(rawSettings ?? {});
    const credentials = storedCredentialsSchema.safeParse(rawCredentials);
    const issues = [
      ...(settings.success ? [] : settings.error.issues.map((i) => `settings${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.message}`)),
      ...(credentials.success ? [] : ["credentials: give token, auth, secret or privateKey (see the docs for each type), within their size limits"]),
    ];
    if (settings.success && credentials.success) {
      issues.push(...storedProblems(settings.data, credentials.data, host.options?.allowHosts));
      if (!issues.length) issues.push(...host.targetProblems(assemble(ids, settings.data, credentials.data)));
    }
    if (issues.length) throw refuse("BAD_REQUEST", "invalid target", issues);
    return { settings: settings.data as StoredSettings, credentials: credentials.data as StoredCredentials };
  }

  const page = z.object({ organizationId: z.string().min(1).max(256).optional(), limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional() }).optional();

  return {
    /**
     * The targets stored for an organization (one you administer), or, for a host administrator
     * without `organizationId`, every one; `limit` (100) and `offset` for more.
     */
    scimProvisioningListTargets: createAuthEndpoint("/scim-provisioning/targets", { method: "GET", use: [sensitiveSessionMiddleware], query: page }, async (ctx) => {
      const actor = await actorOf(ctx, host.options);
      let organizationId = ctx.query?.organizationId;
      if (!actor.host && organizationId === undefined) {
        if (actor.organizations.size > 1) throw refuse("BAD_REQUEST", "organizationId: required (you administer several organizations)");
        organizationId = [...actor.organizations][0];
      }
      if (organizationId !== undefined && !may(actor, organizationId)) throw refuse("FORBIDDEN", "not allowed");
      const limit = ctx.query?.limit ?? 100;
      const rows = (await adapterOf(ctx).findMany({
        model: TARGET_MODEL,
        ...(organizationId !== undefined ? { where: [{ field: "organizationId", value: organizationId }] } : {}),
        limit: limit + 1,
        offset: ctx.query?.offset ?? 0,
        sortBy: { field: "targetId", direction: "asc" },
      })) as TargetRow[];
      const targets: StoredTargetView[] = [];
      for (const r of rows.slice(0, limit)) if (organizationId === undefined || r.organizationId === organizationId) targets.push(view(r, await readable(ctx, r)));
      return ctx.json({ targets, more: rows.length > limit });
    }),

    /** Connect an app (or Google Workspace domain, or webhook) to an organization. Its id is generated. */
    scimProvisioningCreateTarget: createAuthEndpoint(
      "/scim-provisioning/targets/create",
      {
        method: "POST",
        use: [sensitiveSessionMiddleware],
        body: z.strictObject({ organizationId: z.string().min(1).max(256), settings: z.unknown(), credentials: z.unknown(), enabled: z.boolean().optional() }),
      },
      async (ctx) => {
        const actor = await actorOf(ctx, host.options);
        const { organizationId } = ctx.body;
        if (!may(actor, organizationId)) throw refuse("FORBIDDEN", "not allowed");
        const adapter = adapterOf(ctx);
        const org = (await adapter.findOne({ model: "organization", where: [{ field: "id", value: organizationId }] })) as { id: string } | null;
        if (!org || org.id !== organizationId) throw refuse("BAD_REQUEST", `no organization ${organizationId}`);
        // Counted, then created: two creates at once can pass one over the cap; it's a guard against
        // runaway use, not a quota.
        const max = host.options?.maxTargetsPerOrganization ?? 10;
        const existing = ((await adapter.findMany({ model: TARGET_MODEL, where: [{ field: "organizationId", value: organizationId }], limit: max + 1 })) as TargetRow[]).filter((r) => r.organizationId === organizationId);
        if (existing.length >= max) throw refuse("CONFLICT", `an organization has at most ${max} targets`);
        let targetId = `t-${crypto.randomUUID()}`;
        while (host.codeIds.some((c) => c.toLowerCase() === targetId)) targetId = `t-${crypto.randomUUID()}`;
        const { settings, credentials } = check({ targetId, organizationId }, ctx.body.settings, ctx.body.credentials);
        const enabled = ctx.body.enabled ?? true;
        const now = new Date();
        const row = (await adapter.create({
          model: TARGET_MODEL,
          data: { targetId, organizationId, type: settings.type ?? "scim", config: JSON.stringify(settings), sealed: await seal(key(ctx), targetId, organizationId, credentials), enabled, createdAt: now, updatedAt: now },
        })) as TargetRow;
        audit(ctx, actor, `created target ${targetId} (${settings.type ?? "scim"}) for organization ${organizationId}`);
        // The organization's members and groups, queued now (a disabled target's wait).
        await instance(ctx).resync(organizationId, targetId);
        return ctx.json({ target: view(row, credentials) });
      },
    ),

    /**
     * Change a target: `settings` replaces its settings (its type stays), `credentials` its
     * credentials, `enabled` pauses or resumes it (a paused target's jobs wait). What isn't
     * given stays as it was, except that changing where it sends (its URL, or Google's
     * service account or admin) needs the credentials given again. Any change queues the
     * organization again, so it applies to everyone at once.
     */
    scimProvisioningUpdateTarget: createAuthEndpoint(
      "/scim-provisioning/targets/update",
      {
        method: "POST",
        use: [sensitiveSessionMiddleware],
        body: z.strictObject({ id: z.string().min(1).max(100), settings: z.unknown().optional(), credentials: z.unknown().optional(), enabled: z.boolean().optional() }),
      },
      async (ctx) => {
        const actor = await actorOf(ctx, host.options);
        const row = await rowFor(ctx, actor, ctx.body.id);
        const update: Record<string, unknown> = { updatedAt: new Date() };
        let current: StoredCredentials | null = null;
        if (ctx.body.settings !== undefined || ctx.body.credentials !== undefined) {
          const before = settingsOf(row);
          const settings = ctx.body.settings !== undefined ? ctx.body.settings : before;
          const type = (settings as { type?: unknown } | null)?.type ?? "scim";
          if (type !== row.type) throw refuse("BAD_REQUEST", `a target's type can't change (it's ${row.type}): remove it and connect a new one`);
          if (ctx.body.credentials === undefined) {
            const parsed = storedSettingsSchema.safeParse(settings);
            if (parsed.success && destination(parsed.data) !== destination(before)) throw refuse("BAD_REQUEST", "changing where a target sends (its URL, or Google's clientEmail or adminEmail) needs its credentials given again");
            current = await readable(ctx, row);
            if (!current) throw refuse("BAD_REQUEST", "its stored credentials can't be read (was the secret changed?): give credentials too");
          }
          const checked = check(row, settings, ctx.body.credentials ?? current);
          current = checked.credentials;
          update.config = JSON.stringify(checked.settings);
          if (ctx.body.credentials !== undefined) update.sealed = await seal(key(ctx), row.targetId, row.organizationId, checked.credentials);
        }
        if (ctx.body.enabled !== undefined) update.enabled = ctx.body.enabled;
        await adapterOf(ctx).update({ model: TARGET_MODEL, where: [{ field: "id", value: row.id }], update });
        const after = { ...row, ...update } as TargetRow;
        audit(ctx, actor, `updated target ${row.targetId} (${Object.keys(update).filter((k) => k !== "updatedAt").map((k) => (k === "sealed" ? "credentials" : k === "config" ? "settings" : k)).join(", ") || "nothing"})`);
        // New settings or credentials apply to everyone now, and what was waiting or failed goes
        // again. Only pausing changes nothing to send: later changes are queued, and wait.
        const pausedOnly = ctx.body.enabled === false && ctx.body.settings === undefined && ctx.body.credentials === undefined;
        if (!pausedOnly) await instance(ctx).resync(row.organizationId, row.targetId);
        return ctx.json({ target: view(after, current ?? (await readable(ctx, after))) });
      },
    ),

    /**
     * Remove a target, with its queued jobs and its record of the accounts and groups it made.
     * The accounts at the app stay as they are, and nothing tells the app any more: deactivate
     * them there if they should go.
     */
    scimProvisioningDeleteTarget: createAuthEndpoint(
      "/scim-provisioning/targets/delete",
      { method: "POST", use: [sensitiveSessionMiddleware], body: z.strictObject({ id: z.string().min(1).max(100) }) },
      async (ctx) => {
        const actor = await actorOf(ctx, host.options);
        const row = await rowFor(ctx, actor, ctx.body.id);
        const adapter = adapterOf(ctx);
        // The target first: deliveries look it up each time, so none starts after this. One
        // already under way can still record its account; that record is of a target that no
        // longer exists, and nothing reads it. Generated ids never differ from another target's
        // only in case, so these can't reach another's rows on a case-insensitive database.
        await adapter.deleteMany({ model: TARGET_MODEL, where: [{ field: "id", value: row.id }] });
        for (const model of [JOB_MODEL, LINK_MODEL, GROUP_LINK_MODEL]) await adapter.deleteMany({ model, where: [{ field: "targetId", value: row.targetId }] });
        audit(ctx, actor, `deleted target ${row.targetId} of organization ${row.organizationId}`);
        return ctx.json({ deleted: true });
      },
    ),

    /**
     * Try a target's URL and credentials without changing anything: a lookup of a user who
     * doesn't exist (SCIM; Google Workspace, in the admin's domain). Webhooks have no request
     * that changes nothing. Says what went wrong in broad terms only.
     */
    scimProvisioningCheckTarget: createAuthEndpoint(
      "/scim-provisioning/targets/check",
      { method: "POST", use: [sensitiveSessionMiddleware], body: z.strictObject({ id: z.string().min(1).max(100) }) },
      async (ctx) => {
        const actor = await actorOf(ctx, host.options);
        const row = await rowFor(ctx, actor, ctx.body.id);
        const credentials = await readable(ctx, row);
        if (!credentials) return ctx.json({ ok: false, problem: "its stored credentials can't be read (was the secret changed?): give them again" });
        const settings = settingsOf(row);
        // Through the same fetch as deliveries: the registry's own, or the resolving guard.
        const target = assemble(row, settings, credentials, host.options?.fetch ?? guardedFetch(host.options?.allowHosts));
        if (target.type === "webhook") return ctx.json({ ok: null, problem: "a webhook has no request that changes nothing: its first event is the check" });
        const domain = target.type === "google-workspace" ? (settings.google?.adminEmail.split("@")[1] ?? "example.invalid") : "example.invalid";
        try {
          await clientFor(target).findByUserName(`scim-provisioning-check-${crypto.randomUUID().slice(0, 8)}@${domain}`);
          return ctx.json({ ok: true });
        } catch (e) {
          return ctx.json(checkResult(e));
        }
      },
    ),

    /** A target's deliveries: what's queued, waiting, stuck and failed, and the latest failures (their status, not the app's words). */
    scimProvisioningTargetStatus: createAuthEndpoint(
      "/scim-provisioning/targets/status",
      { method: "POST", use: [sensitiveSessionMiddleware], body: z.strictObject({ id: z.string().min(1).max(100) }) },
      async (ctx) => {
        const actor = await actorOf(ctx, host.options);
        const row = await rowFor(ctx, actor, ctx.body.id);
        const i = instance(ctx);
        return ctx.json({ ...(await i.status(row.targetId)), failures: await i.failures(row.targetId) });
      },
    ),
  };
}
