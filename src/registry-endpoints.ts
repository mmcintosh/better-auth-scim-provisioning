// The target registry's API: organizations' administrators connect, change, check and remove
// their organization's targets; the host's administrators (`registry.canManage`) any organization's.
// Every route needs a fresh session (checked against the database), of a user who isn't banned
// or impersonated, decided on memberships as the database has them now, never the session's
// active organization. Credentials go in and never come out: a target shows only their kind.
import type { GenericEndpointContext } from "better-auth";
import { APIError, createAuthEndpoint, sensitiveSessionMiddleware } from "better-auth/api";
import * as z from "zod";
import { type Adapter, clientFor, GROUP_LINK_MODEL, JOB_MODEL, LINK_MODEL } from "./outbox";
import {
  assemble,
  credentialsKind,
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
import type { Target, TargetRegistryOptions } from "./types";

const MAX_LIST = 1000;
const MAX_CONFIG_BYTES = 16 * 1024;

/** What the endpoints need from the plugin's instance. */
export interface RegistryHost {
  options: TargetRegistryOptions;
  /** Ids of the targets in code: a stored one never takes one, in any case. */
  codeIds: string[];
  /** Problems with a whole target, as the plugin's option checks see them. */
  targetProblems(target: Target): string[];
  /** This instance's state: forget the cached list, and queue an organization's members and groups for a target. */
  instance(ctx: GenericEndpointContext): { forget(): void; queueOrganization(organizationId: string, targetId: string): void } | undefined;
}

/** A stored target as the API shows it: no credentials, and no query string values (an Azure Function's ?code= is a secret). */
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

const redactQuery = (url: string | undefined) => {
  if (url === undefined || !url.includes("?")) return url;
  return `${url.slice(0, url.indexOf("?"))}?…`;
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

async function actorOf(ctx: GenericEndpointContext, options: TargetRegistryOptions): Promise<Actor> {
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
    const members = (await (ctx.context.adapter as unknown as Adapter).findMany({ model: "member", where: [{ field: "userId", value: user.id }], limit: 1000 })) as { userId: string; organizationId: string; role?: string | null }[];
    for (const m of members) {
      // Exact match: a case-insensitive collation mustn't widen it. Better Auth stores several roles comma-separated.
      if (m.userId !== user.id) continue;
      if (String(m.role ?? "").split(",").some((r) => roles.includes(r.trim()))) organizations.add(m.organizationId);
    }
  }
  if (!host && organizations.size === 0) throw refuse("FORBIDDEN", "not allowed");
  return { userId: user.id, host, organizations };
}

export function registryEndpoints(host: RegistryHost, key: (ctx: GenericEndpointContext) => SealKey) {
  const adapterOf = (ctx: GenericEndpointContext) => ctx.context.adapter as unknown as Adapter;
  const audit = (ctx: GenericEndpointContext, actor: Actor, what: string) => ctx.context.logger.info(`[scim] registry: user ${actor.userId}${actor.host ? " (host administrator)" : ""} ${what}`);

  /** The row with this id, if the actor may see it; otherwise 404, so others' targets aren't confirmed to exist. */
  async function rowFor(ctx: GenericEndpointContext, actor: Actor, id: string): Promise<TargetRow> {
    const rows = (await adapterOf(ctx).findMany({ model: TARGET_MODEL, where: [{ field: "targetId", value: id }], limit: 2 })) as TargetRow[];
    const row = rows.find((r) => r.targetId === id);
    if (!row || !may(actor, row.organizationId)) throw refuse("NOT_FOUND", `no target ${id}`);
    return row;
  }

  function view(row: TargetRow, credentials: StoredCredentials | null): StoredTargetView {
    let settings: StoredSettings = {};
    try {
      settings = storedSettingsSchema.parse(JSON.parse(row.config));
    } catch {}
    return {
      id: row.targetId,
      organizationId: row.organizationId,
      type: row.type,
      enabled: truthy(row.enabled),
      settings: { ...settings, ...(settings.url !== undefined ? { url: redactQuery(settings.url) } : {}) },
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
      ...(credentials.success ? [] : ["credentials: give token, auth, secret or privateKey (see the docs for each type)"]),
    ];
    if (settings.success && credentials.success) {
      issues.push(...storedProblems(settings.data, credentials.data, host.options.allowHosts));
      if (!issues.length) issues.push(...host.targetProblems(assemble(ids, settings.data, credentials.data)));
    }
    if (issues.length) throw refuse("BAD_REQUEST", "invalid target", issues);
    return { settings: settings.data as StoredSettings, credentials: credentials.data as StoredCredentials };
  }

  const changed = (ctx: GenericEndpointContext, organizationId: string, targetId: string, queue: boolean) => {
    const i = host.instance(ctx);
    i?.forget();
    // A new (or re-enabled) target starts with the organization's members and groups; the rest
    // (or anything this doesn't finish) is caught up by a reconcile.
    if (queue) i?.queueOrganization(organizationId, targetId);
  };

  return {
    /** The targets stored for an organization (one you administer), or, for a host administrator without `organizationId`, every one. */
    scimProvisioningListTargets: createAuthEndpoint(
      "/scim-provisioning/targets",
      { method: "GET", use: [sensitiveSessionMiddleware], query: z.object({ organizationId: z.string().min(1).max(256).optional() }).optional() },
      async (ctx) => {
        const actor = await actorOf(ctx, host.options);
        let organizationId = ctx.query?.organizationId;
        if (!actor.host && organizationId === undefined) {
          if (actor.organizations.size > 1) throw refuse("BAD_REQUEST", "organizationId: required (you administer several organizations)");
          organizationId = [...actor.organizations][0];
        }
        if (organizationId !== undefined && !may(actor, organizationId)) throw refuse("FORBIDDEN", "not allowed");
        const rows = ((await adapterOf(ctx).findMany({
          model: TARGET_MODEL,
          ...(organizationId !== undefined ? { where: [{ field: "organizationId", value: organizationId }] } : {}),
          limit: MAX_LIST,
          sortBy: { field: "createdAt", direction: "asc" },
        })) as TargetRow[]).filter((r) => organizationId === undefined || r.organizationId === organizationId);
        const targets: StoredTargetView[] = [];
        for (const r of rows) targets.push(view(r, await readable(ctx, r)));
        return ctx.json({ targets });
      },
    ),

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
        const existing = ((await adapter.findMany({ model: TARGET_MODEL, where: [{ field: "organizationId", value: organizationId }], limit: MAX_LIST })) as TargetRow[]).filter((r) => r.organizationId === organizationId);
        const max = host.options.maxTargetsPerOrganization ?? 10;
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
        changed(ctx, organizationId, targetId, enabled);
        return ctx.json({ target: view(row, credentials) });
      },
    ),

    /**
     * Change a target: `settings` replaces its settings (its type stays), `credentials` its
     * credentials, `enabled` pauses or resumes it (a paused target's jobs wait). What isn't
     * given stays as it was.
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
          current = ctx.body.credentials === undefined ? await readable(ctx, row) : null;
          if (ctx.body.credentials === undefined && !current) throw refuse("BAD_REQUEST", "its stored credentials can't be read (was the secret changed?): give credentials too");
          const settings = ctx.body.settings !== undefined ? ctx.body.settings : JSON.parse(row.config);
          const type = (settings as { type?: unknown } | null)?.type ?? "scim";
          if (type !== row.type) throw refuse("BAD_REQUEST", `a target's type can't change (it's ${row.type}): remove it and connect a new one`);
          const checked = check(row, settings, ctx.body.credentials ?? current);
          current = checked.credentials;
          update.config = JSON.stringify(checked.settings);
          if (ctx.body.credentials !== undefined) update.sealed = await seal(key(ctx), row.targetId, row.organizationId, checked.credentials);
        }
        const resumed = ctx.body.enabled === true && !truthy(row.enabled);
        if (ctx.body.enabled !== undefined) update.enabled = ctx.body.enabled;
        await adapterOf(ctx).update({ model: TARGET_MODEL, where: [{ field: "id", value: row.id }], update });
        const after = { ...row, ...update } as TargetRow;
        audit(ctx, actor, `updated target ${row.targetId} (${Object.keys(update).filter((k) => k !== "updatedAt").map((k) => (k === "sealed" ? "credentials" : k === "config" ? "settings" : k)).join(", ") || "nothing"})`);
        changed(ctx, row.organizationId, row.targetId, resumed);
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
        await adapter.deleteMany({ model: TARGET_MODEL, where: [{ field: "id", value: row.id }] });
        // Generated ids never differ from another target's only in case, so these can't reach another's rows.
        for (const model of [JOB_MODEL, LINK_MODEL, GROUP_LINK_MODEL]) await adapter.deleteMany({ model, where: [{ field: "targetId", value: row.targetId }] });
        audit(ctx, actor, `deleted target ${row.targetId} of organization ${row.organizationId}`);
        changed(ctx, row.organizationId, row.targetId, false);
        return ctx.json({ deleted: true });
      },
    ),

    /**
     * Try a target's URL and credentials without changing anything: a lookup of a user who
     * doesn't exist (SCIM, Google Workspace). Webhooks have no request that changes nothing.
     */
    scimProvisioningCheckTarget: createAuthEndpoint(
      "/scim-provisioning/targets/check",
      { method: "POST", use: [sensitiveSessionMiddleware], body: z.strictObject({ id: z.string().min(1).max(100) }) },
      async (ctx) => {
        const actor = await actorOf(ctx, host.options);
        const row = await rowFor(ctx, actor, ctx.body.id);
        const credentials = await readable(ctx, row);
        if (!credentials) return ctx.json({ ok: false, error: "its stored credentials can't be read (was the secret changed?)" });
        const target = assemble(row, storedSettingsSchema.parse(JSON.parse(row.config)), credentials, host.options.fetch);
        if (target.type === "webhook") return ctx.json({ ok: null, error: "a webhook has no request that changes nothing: its first event is the check" });
        try {
          await clientFor(target).findByUserName("scim-provisioning-check@example.invalid");
          return ctx.json({ ok: true });
        } catch (e) {
          return ctx.json({ ok: false, error: e instanceof Error ? e.message : String(e), ...(typeof (e as { status?: unknown }).status === "number" ? { status: (e as { status: number }).status } : {}) });
        }
      },
    ),
  };
}
