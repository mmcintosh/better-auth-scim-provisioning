// The target registry's API: organizations' administrators connect, change, check and remove
// their organization's targets; the host's administrators (`registry.canManage`) any organization's.
// Every route needs a session re-read from the database (stateful deployments; a stateless one's
// signed cookie), of a user who isn't banned or impersonated, decided on memberships as the
// database has them now, never the session's active organization; changes need a fresh one too
// (signed in within Better Auth's `session.freshAge`, a day by default). Credentials go in and
// never come out: a target shows only their kind, and they're sealed for where it sends (a change
// of where needs them given again). The routes are always there (so they're typed for every
// app); without `registry` they're 404 (401 first, signed out).
import type { GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, sensitiveSessionMiddleware } from "better-auth/api";
import * as z from "zod";
import { type Adapter, clientFor, DECOMMISSION_MODEL, GROUP_LINK_MODEL, JOB_MODEL, LINK_MODEL, PURGE_CONFIRM_ABOVE } from "./outbox";
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
  destination,
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
  /** The user model's fields, set at init: what `enterprise: true` and `attributes: true` resolve to. */
  userFields(): ReadonlySet<string>;
  /** This instance's outbox, for a target's organization. */
  instance(ctx: GenericEndpointContext):
    | {
        resync(targetId: string, o: { resume: boolean }): Promise<void>;
        status(targetId: string): Promise<{ queued: number; waiting: number; stuck: number; failed: number; accounts: number; groups: number }>;
        failures(targetId: string): Promise<{ kind: string; subjectId: string; failed: boolean; status: number | null; nextAttemptAt: string }[]>;
        drift(targetId: string, after: string | null, limit: number): Promise<{ items: unknown[]; scanned: number; next: string | null }>;
        accounts(targetId: string, after: string | null, limit: number): Promise<{ items: { userId: string; userName: string; remoteId: string | null; active: boolean; adopted: boolean }[]; next: string | null }>;
        /** Deliver some of the target's due jobs now, in the background; the scheduled run does the rest. */
        kick(targetId: string): void;
        /** What a target still has at the app: accounts active there (for a purge, not adopted), and groups. */
        counts(targetId: string, phase?: "deactivate" | "purge"): Promise<{ accounts: number; groups: number }>;
        /** Undefined without the plugin's `decommission` option. */
        decommission:
          | {
              state(targetId: string): Promise<"running" | "complete" | "cancelled" | null>;
              status(targetId: string): Promise<unknown>;
              start(targetId: string, by: string): Promise<void>;
              purge(targetId: string, by: string): Promise<void>;
              row(targetId: string): Promise<{ phase: "deactivate" | "purge"; state: "running" | "complete" | "cancelled" } | null>;
              cancel(targetId: string, by: string): Promise<boolean>;
            }
          | undefined;
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

interface Actor {
  userId: string;
  /** A host administrator: every organization. */
  host: boolean;
  /** Otherwise, the organizations it administers. */
  organizations: ReadonlySet<string>;
}
const may = (actor: Actor, organizationId: string) => actor.host || actor.organizations.has(organizationId);

async function actorOf(ctx: GenericEndpointContext, options: TargetRegistryOptions | undefined, o: { change?: boolean; roles?: string[]; freshAge?: number } = {}): Promise<Actor> {
  if (!options) throw refuse("NOT_FOUND", "the target registry isn't enabled (registry option)");
  const s = (ctx.context as { session?: { user: { id: string }; session: Record<string, unknown> } }).session;
  if (!s) throw refuse("FORBIDDEN", "sign in to manage targets");
  // An administrator acting as someone else doesn't manage targets as them.
  if (s.session.impersonatedBy) throw refuse("FORBIDDEN", "not while impersonating");
  if (o.change) {
    // Fresh, as Better Auth asks for a password or email change: a session cookie stolen days ago
    // mustn't be able to point an organization's users at another app.
    const freshAge = o.freshAge ?? (ctx.context as { sessionConfig?: { freshAge?: number } }).sessionConfig?.freshAge ?? 60 * 60 * 24;
    const createdAt = new Date(s.session.createdAt as string | Date).getTime();
    if (freshAge !== 0 && !(Date.now() - createdAt < freshAge * 1000)) throw refuse("FORBIDDEN", "sign in again to change targets (the session isn't fresh)");
  }
  const user = (await ctx.context.internalAdapter.findUserById(s.user.id)) as ({ id: string; email: string; emailVerified: boolean } & Record<string, unknown>) | null;
  if (!user || isBanned(user)) throw refuse("FORBIDDEN", "not allowed");
  let host = false;
  if (options.canManage) {
    try {
      host = (await options.canManage({ user, session: s.session })) === true;
    } catch (e) {
      ctx.context.logger.error("[scim] registry.canManage threw", e);
    }
  }
  const roles = o.roles ?? options.organizationRoles ?? ["owner", "admin"];
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
  if (status === null) {
    if (!(e instanceof ScimError)) return { ok: false, problem: "the request couldn't be made" };
    // Retried errors are the app not answering; the rest are an answer that couldn't be used.
    return { ok: false, problem: e.retryable ? "no answer (the host can't be reached, or didn't answer in time)" : "the app's answer couldn't be used: check the URL, or pass a `next` this route handed out" };
  }
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
  // At warn, Better Auth's default level: who connected what, and where, must not be dropped.
  const audit = (ctx: GenericEndpointContext, actor: Actor, what: string) => ctx.context.logger.warn(`[scim] registry: user ${actor.userId}${actor.host ? " (host administrator)" : ""} ${what}`);
  const instance = (ctx: GenericEndpointContext) => {
    const i = host.instance(ctx);
    if (!i) throw new Error("[scim] not initialised");
    return i;
  };

  /**
   * Who may decommission: `registry.decommissionRoles` (owners, by default) among those who may
   * manage targets at all (organizationRoles), and the host's administrators; signed in within
   * `decommissionFreshAge` to change anything.
   */
  const decommissionActor = (ctx: GenericEndpointContext, change: boolean) => {
    const managing = host.options?.organizationRoles ?? ["owner", "admin"];
    const roles = (host.options?.decommissionRoles ?? ["owner"]).filter((r) => managing.includes(r));
    return actorOf(ctx, host.options, change ? { change: true, roles, freshAge: host.options?.decommissionFreshAge ?? 900 } : { roles });
  };

  /**
   * A target being decommissioned, or decommissioned: removing it (or pausing it) would undo or stop
   * that, so only those who may decommission may, freshly signed in.
   */
  async function guardRetiring(ctx: GenericEndpointContext, row: TargetRow, what: string) {
    const state = await instance(ctx).decommission?.state(row.targetId);
    if (state !== "running" && state !== "complete") return;
    const actor = await decommissionActor(ctx, true).catch(() => null);
    if (!actor || !may(actor, row.organizationId)) throw refuse("FORBIDDEN", `its decommission is ${state}: only those who may decommission it may ${what} it (registry.decommissionRoles)`);
  }

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
      issues.push(...storedProblems(settings.data, credentials.data, host.options?.allowHosts, host.options?.enterpriseFields, host.options?.attributeFields, host.userFields()));
      if (!issues.length) {
        // A profile refuses what its app can't do (githubEnterprise: deprovision "delete") by throwing.
        let whole: Target | null = null;
        try {
          whole = assemble(ids, settings.data, credentials.data);
        } catch (e) {
          issues.push(`settings: ${(e as Error).message.replace(/^\[scim\]\s*/, "")}`);
        }
        if (whole) issues.push(...host.targetProblems(whole));
      }
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
        const actor = await actorOf(ctx, host.options, { change: true });
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
          data: { targetId, organizationId, type: settings.type ?? "scim", config: JSON.stringify(settings), sealed: await seal(key(ctx), targetId, organizationId, credentials, settings), enabled, createdAt: now, updatedAt: now },
        })) as TargetRow;
        audit(ctx, actor, `created target ${targetId} (${settings.type ?? "scim"}, ${settings.url !== undefined ? new URL(settings.url).host : (settings.google?.adminEmail.split("@")[1] ?? "")}) for organization ${organizationId}`);
        // The organization's members and groups, queued (a disabled target's wait).
        await instance(ctx).resync(targetId, { resume: false });
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
        const actor = await actorOf(ctx, host.options, { change: true });
        const row = await rowFor(ctx, actor, ctx.body.id);
        const update: Record<string, unknown> = { updatedAt: new Date() };
        let current: StoredCredentials | null = null;
        const before = settingsOf(row);
        let after = before;
        if (ctx.body.settings !== undefined || ctx.body.credentials !== undefined) {
          const settings = ctx.body.settings !== undefined ? ctx.body.settings : before;
          const type = (settings as { type?: unknown } | null)?.type ?? "scim";
          if (type !== row.type) throw refuse("BAD_REQUEST", `a target's type can't change (it's ${row.type}): remove it and connect a new one`);
          const parsed = storedSettingsSchema.safeParse(settings);
          const moves = parsed.success && destination(parsed.data) !== destination(before);
          if (ctx.body.credentials === undefined) {
            if (moves) throw refuse("BAD_REQUEST", "changing where a target sends (its URL, or Google's clientEmail or adminEmail) needs its credentials given again");
            current = await readable(ctx, row);
            if (!current) throw refuse("BAD_REQUEST", "its stored credentials can't be read (was the secret changed?): give credentials too");
          }
          // Its accounts are at this app: a decommission under way, or done, stays with it.
          const decommission = moves ? await instance(ctx).decommission?.state(row.targetId) : null;
          if (decommission === "running" || decommission === "complete") throw refuse("BAD_REQUEST", "a target being decommissioned (or decommissioned) can't be pointed at another app: connect a new target for that");
          const checked = check(row, settings, ctx.body.credentials ?? current);
          current = checked.credentials;
          after = checked.settings;
          update.config = JSON.stringify(checked.settings);
          if (ctx.body.credentials !== undefined) update.sealed = await seal(key(ctx), row.targetId, row.organizationId, checked.credentials, checked.settings);
        }
        if (ctx.body.enabled === false && truthy(row.enabled)) await guardRetiring(ctx, row, "pause");
        if (ctx.body.enabled !== undefined) update.enabled = ctx.body.enabled;
        // Only over the row as read: two changes at once mustn't mix one's URL with the other's
        // credentials. The loser is told to try again.
        const written = await adapterOf(ctx).updateMany({
          model: TARGET_MODEL,
          where: [
            { field: "id", value: row.id },
            { field: "config", value: row.config },
            { field: "sealed", value: row.sealed },
          ],
          update,
        });
        if (written === 0) throw refuse("CONFLICT", "the target was changed meanwhile: read it again and retry");
        const saved = { ...row, ...update } as TargetRow;
        audit(ctx, actor, `updated target ${row.targetId} (${Object.keys(update).filter((k) => k !== "updatedAt").map((k) => (k === "sealed" ? "credentials" : k === "config" ? "settings" : k)).join(", ") || "nothing"})`);
        // What's to be sent changed (settings beyond the label, new credentials, enabled): queued
        // again for everyone, and what was waiting or failed goes again (new credentials or a
        // re-enabled target). Pausing, or renaming the label, sends nothing new.
        const { name: _a, ...sendsBefore } = before;
        const { name: _b, ...sendsAfter } = after;
        const settingsChanged = JSON.stringify(sendsBefore) !== JSON.stringify(sendsAfter);
        const resume = ctx.body.credentials !== undefined || (ctx.body.enabled === true && !truthy(row.enabled));
        if (settingsChanged || resume) await instance(ctx).resync(row.targetId, { resume });
        return ctx.json({ target: view(saved, current ?? (await readable(ctx, saved))) });
      },
    ),

    /**
     * Remove a target, with its queued jobs and its record of the accounts and groups it made.
     * The accounts at the app stay as they are, and nothing tells the app any more: decommission
     * it first if they should go. Says what it left there (`abandoned`: accounts still active,
     * groups). With `registry.deleteRequiresDecommission`, refused while accounts are still active,
     * unless `abandon: true` (an app that's gone).
     */
    scimProvisioningDeleteTarget: createAuthEndpoint(
      "/scim-provisioning/targets/delete",
      { method: "POST", use: [sensitiveSessionMiddleware], body: z.strictObject({ id: z.string().min(1).max(100), abandon: z.literal(true).optional() }) },
      async (ctx) => {
        const actor = await actorOf(ctx, host.options, { change: true });
        const row = await rowFor(ctx, actor, ctx.body.id);
        await guardRetiring(ctx, row, "remove");
        const adapter = adapterOf(ctx);
        const abandoned = await instance(ctx).counts(row.targetId);
        if (host.options?.deleteRequiresDecommission && abandoned.accounts > 0 && !ctx.body.abandon)
          throw refuse("CONFLICT", `${abandoned.accounts} accounts made through this target are still active at the app: decommission it first, or delete with abandon: true to leave them as they are`);
        // The target first: deliveries look it up each time, so none starts after this. One
        // already under way can still record its account; that record is of a target that no
        // longer exists, and nothing reads it. Generated ids never differ from another target's
        // only in case, so these can't reach another's rows on a case-insensitive database.
        await adapter.deleteMany({ model: TARGET_MODEL, where: [{ field: "id", value: row.id }] });
        for (const model of [JOB_MODEL, LINK_MODEL, GROUP_LINK_MODEL, ...(instance(ctx).decommission ? [DECOMMISSION_MODEL] : [])]) await adapter.deleteMany({ model, where: [{ field: "targetId", value: row.targetId }] });
        audit(ctx, actor, `deleted target ${row.targetId} of organization ${row.organizationId}${abandoned.accounts || abandoned.groups ? `, leaving ${abandoned.accounts} active accounts and ${abandoned.groups} groups at the app` : ""}`);
        return ctx.json({ deleted: true, abandoned });
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
        return ctx.json({ ...(await i.status(row.targetId)), failures: await i.failures(row.targetId), ...(i.decommission ? { decommission: await i.decommission.status(row.targetId) } : {}) });
      },
    ),

    /**
     * Decommission a target (with the plugin's `decommission`): deactivate every account and empty
     * every group made through it, deleting nothing (see `scimProvisioningDecommission`).
     * `preview: true` says how many; starting needs `confirm` equal to the accounts it showed.
     * `cancel: true`, before it completes, stops it and switches back on those still wanted. Only
     * `registry.decommissionRoles` (owners, by default) and the host's administrators, signed in
     * within `registry.decommissionFreshAge` (15 minutes). Its progress is in the status route.
     */
    scimProvisioningDecommissionTarget: createAuthEndpoint(
      "/scim-provisioning/targets/decommission",
      {
        method: "POST",
        use: [sensitiveSessionMiddleware],
        body: z
          .strictObject({ id: z.string().min(1).max(100), phase: z.enum(["deactivate", "purge"]).optional(), preview: z.literal(true).optional(), confirm: z.number().int().min(0).optional(), cancel: z.literal(true).optional() })
          .refine((b) => !(b.preview && b.cancel), "preview or cancel, not both"),
      },
      async (ctx) => {
        const preview = ctx.body.preview === true;
        const actor = await decommissionActor(ctx, !preview);
        const row = await rowFor(ctx, actor, ctx.body.id);
        const i = instance(ctx);
        const d = i.decommission;
        if (!d) throw refuse("BAD_REQUEST", "decommissioning isn't enabled (the plugin's decommission option)");
        const by = `user:${actor.userId}`;
        if (ctx.body.cancel) {
          if (!(await d.cancel(row.targetId, by))) throw refuse("BAD_REQUEST", "no decommission is running that can be cancelled (a complete one, or a purge, can't be)");
          const left = await i.counts(row.targetId);
          audit(ctx, actor, `cancelled the decommission of target ${row.targetId} of organization ${row.organizationId}: ${left.accounts} accounts still active there; every account and group queued again`);
          i.kick(row.targetId);
          return ctx.json({ decommission: await d.status(row.targetId) });
        }
        if (ctx.body.phase === "purge") {
          const counts = await i.counts(row.targetId, "purge");
          if (preview) return ctx.json({ ...counts, decommission: await d.status(row.targetId) });
          const current = await d.row(row.targetId);
          if (current?.phase === "purge" && current.state === "complete") throw refuse("BAD_REQUEST", "its purge is complete");
          if (current?.phase !== "purge") {
            if (current?.state !== "complete") throw refuse("BAD_REQUEST", "a purge comes after a complete decommission");
            if (!truthy(row.enabled)) throw refuse("BAD_REQUEST", "the target is disabled: enable it first");
            if (!(await readable(ctx, row))) throw refuse("BAD_REQUEST", "its stored credentials can't be read (was the secret changed?): give them again first");
            if (counts.accounts > PURGE_CONFIRM_ABOVE && ctx.body.confirm !== counts.accounts) throw refuse("BAD_REQUEST", `confirm the number of accounts to delete: ${counts.accounts} (preview: true shows it)`);
            await d.purge(row.targetId, by);
            audit(ctx, actor, `started purging target ${row.targetId} of organization ${row.organizationId}: ${counts.accounts} accounts and ${counts.groups} groups to delete`);
          } else await d.purge(row.targetId, by);
          i.kick(row.targetId);
          return ctx.json({ decommission: await d.status(row.targetId) });
        }
        const counts = await i.counts(row.targetId);
        if (preview) return ctx.json({ ...counts, decommission: await d.status(row.targetId) });
        const state = await d.state(row.targetId);
        if (state === "complete") throw refuse("BAD_REQUEST", "its decommission is complete");
        if (state !== "running") {
          // Its deliveries must be able to reach the app.
          if (!truthy(row.enabled)) throw refuse("BAD_REQUEST", "the target is disabled: enable it first");
          if (!(await readable(ctx, row))) throw refuse("BAD_REQUEST", "its stored credentials can't be read (was the secret changed?): give them again first");
          if (ctx.body.confirm !== counts.accounts) throw refuse("BAD_REQUEST", `confirm the number of accounts to deactivate: ${counts.accounts} (preview: true shows it)`);
          await d.start(row.targetId, by);
          audit(ctx, actor, `started decommissioning target ${row.targetId} of organization ${row.organizationId}: ${counts.accounts} accounts to deactivate, ${counts.groups} groups to empty`);
        } else await d.start(row.targetId, by);
        i.kick(row.targetId);
        return ctx.json({ decommission: await d.status(row.targetId) });
      },
    ),

    /** The accounts made through a target, a page at a time (`limit`, 100 by default; then `after: next`): to keep a record before abandoning them. */
    scimProvisioningTargetAccounts: createAuthEndpoint(
      "/scim-provisioning/targets/accounts",
      { method: "POST", use: [sensitiveSessionMiddleware], body: z.strictObject({ id: z.string().min(1).max(100), after: z.string().max(256).optional(), limit: z.number().int().min(1).max(1000).optional() }) },
      async (ctx) => {
        const actor = await actorOf(ctx, host.options);
        const row = await rowFor(ctx, actor, ctx.body.id);
        return ctx.json(await instance(ctx).accounts(row.targetId, ctx.body.after ?? null, ctx.body.limit ?? 100));
      },
    ),

    /**
     * Drift: a page of what's at the app that isn't as we'd have it (see `scimProvisioningDrift`):
     * accounts nobody manages, ours without a link, and linked ones that differ. Read only, and
     * the app's accounts are the organization's own to see. A failure is said in broad terms.
     */
    scimProvisioningTargetDrift: createAuthEndpoint(
      "/scim-provisioning/targets/drift",
      { method: "POST", use: [sensitiveSessionMiddleware], body: z.strictObject({ id: z.string().min(1).max(100), after: z.string().max(4096).optional(), limit: z.number().int().min(1).max(1000).optional() }) },
      async (ctx) => {
        const actor = await actorOf(ctx, host.options);
        const row = await rowFor(ctx, actor, ctx.body.id);
        if (row.type === "webhook") return ctx.json({ ok: null, problem: "a webhook receiver can't be listed, so it has no drift to report" });
        // As the check route: a target whose credentials can't be read sends nothing.
        if (!(await readable(ctx, row))) return ctx.json({ ok: false, problem: "its stored credentials can't be read (was the secret changed?): give them again" });
        try {
          return ctx.json({ ok: true, ...(await instance(ctx).drift(row.targetId, ctx.body.after ?? null, ctx.body.limit ?? 100)) });
        } catch (e) {
          if (e instanceof APIError) throw e;
          return ctx.json(checkResult(e));
        }
      },
    ),
  };
}
