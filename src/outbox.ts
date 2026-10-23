// The outbox: one job per (target, user) saying "make the app match this user", and one link per
// (target, user) remembering the app's id for them. A job carries no user data; delivery reads the
// user as it is then, so several quick changes collapse into one request with the latest state.
//
// Concurrency: a job is claimed with a lease (a conditional update on lockedUntil), so two workers
// never deliver it at once. A change during delivery bumps its version; the finished delivery only
// deletes the job if the version is still the one it claimed, so that change is delivered too.
//
// A link is written before an account is created at the app (remoteId empty: "pending"), so an
// account whose create reply was lost can still be found, and undone, later.
import { auditLog } from "./audit";
import { attributeFields, defaultScimUser, ENTERPRISE_VALUES, enterpriseFields, enterpriseValues, isBanned, withAttributes } from "./mapping";
import { type EntraIdClient, entraIdClient } from "./entra";
import { googleWorkspaceClient } from "./google";
import { webhookClient } from "./webhook";
import { SCIM_ENTERPRISE_USER_SCHEMA, SCIM_GROUP_SCHEMA, type ScimEnterpriseUser, ScimError, type ScimUser, scimClient, trimSlashes } from "./scim-client";
import type { AttributeFields, DeliveryFailure, ProvisionedUser, ScimProvisioningOptions, Target } from "./types";

export const JOB_MODEL = "scimProvisioningJob";
export const LINK_MODEL = "scimProvisioningLink";
export const GROUP_LINK_MODEL = "scimProvisioningGroupLink";
/** A target's decommission, one row per target (only with the `decommission` option). */
export const DECOMMISSION_MODEL = "scimProvisioningDecommission";

type Where = { field: string; value: unknown; operator?: "eq" | "ne" | "lt" | "gt" | "gte" | "in"; connector?: "AND" | "OR" };
export interface Adapter {
  create(a: { model: string; data: Record<string, unknown> }): Promise<unknown>;
  findOne(a: { model: string; where: Where[] }): Promise<unknown>;
  findMany(a: { model: string; where?: Where[]; limit?: number; offset?: number; sortBy?: { field: string; direction: "asc" | "desc" } }): Promise<unknown[]>;
  update(a: { model: string; where: Where[]; update: Record<string, unknown> }): Promise<unknown>;
  updateMany(a: { model: string; where: Where[]; update: Record<string, unknown> }): Promise<number>;
  deleteMany(a: { model: string; where: Where[] }): Promise<number>;
  count(a: { model: string; where?: Where[] }): Promise<number>;
}

export interface Job {
  id: string;
  key: string;
  targetId: string;
  userId: string;
  version: number;
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil: Date;
  failed: boolean;
  lastError?: string | null;
  /** The app's HTTP status for the last failure, if it answered. */
  lastStatus?: number | null;
  /** "group" for an organization's group (`userId` then holds the organization's id). */
  kind?: string | null;
  createdAt?: Date;
}

export interface Link {
  id: string;
  key: string;
  targetId: string;
  userId: string;
  /** The app's id for the account; empty while its create is pending (the reply not yet seen). */
  remoteId: string;
  userName: string;
  /** The externalId we sent, to recognise the account as ours at the app. */
  externalId?: string | null;
  active: boolean;
  /** Made elsewhere and taken over (adopt): never deleted by us, only deactivated. */
  adopted?: boolean | null;
}

/**
 * "Not held": any date in the past works; 2000-01-01 rather than the epoch, which MySQL's
 * TIMESTAMP columns reject (they start one second after it).
 */
const RELEASED = new Date("2000-01-01T00:00:00.000Z");
/**
 * How long a claimed job is held: a user delivery makes a handful of requests (a Google update
 * reads first; a 404 or 409 adds a find and a retry), each up to the target's timeout, plus a
 * margin. A group delivery's hold is also renewed while it runs. Shorter, and a second worker
 * could claim a job still being delivered.
 */
/** A paused target's jobs wait until then: never due, until resumed. */
export const PAUSED_UNTIL = new Date("2999-01-01T00:00:00.000Z");
/** A stored target whose credentials can't be read: its jobs are tried again this often (no attempt counted), so they go once it's fixed. */
export const UNREADABLE_RETRY_MS = 15 * 60_000;
/** Jobs one target may take of a scheduled run's batch, while others' are due: so one slow app can't hold up the rest. */
const PER_TARGET_SHARE = 0.5;
/**
 * How long after the plugin disables or deletes an Entra ID user its job comes back to check that
 * Graph has it so: Graph's replicas can drop a write made seconds after another to the same user.
 */
const CONFIRM_MS = 60_000;
/** The earlier of two times to look again, either possibly absent. */
const earliest = (a: Date | null, b: Date) => (a && a.getTime() < b.getTime() ? a : b);
/** Users (or groups) a resync queues per step. */
const RESYNC_PAGE = 100;

const leaseFor = (target: Target | undefined, kind?: string | null) =>
  kind && kind !== "user"
    ? // A group can take many requests, but its hold is renewed every few seconds while it runs:
      // short, so one cut off (a Worker ended) frees the group soon.
      Math.max(3 * RENEW_EVERY_MS, 2 * (target?.timeoutMs ?? 10_000)) + 30_000
    : 12 * (target?.timeoutMs ?? 10_000) + 30_000;
/** How often a long (group) delivery renews its hold on the job. */
const RENEW_EVERY_MS = 5_000;
/** How long a delivery waits for the host's onFailure. */
const ON_FAILURE_TIMEOUT_MS = 5_000;
/** Re-deliveries in a row for a job that keeps changing; the scheduled run takes over after. */
const MAX_ROUNDS = 3;
const MAX_DELAY_MS = 6 * 3_600_000;
/** How long a rate-limited target's jobs wait when the app doesn't say (no Retry-After). */
const RATE_LIMIT_WAIT_MS = 60_000;
/** The longest a request waits its turn under `maxRequestsPerMinute`; past that, its job goes back in the queue. */
const MAX_PACE_WAIT_MS = 30_000;
/** Page size for walking links. */
const PAGE = 500;
/** Ids per `in` query: D1 allows 100 bound parameters per statement. */
export const IN_BATCH = 50;
/** Target ids are [A-Za-z0-9_-], so ":" can't be ambiguous. */
export const keyOf = (targetId: string, userId: string) => `${targetId}:${userId}`;
/** An organization's group at a target. User ids never contain ":group:". */
export const groupKeyOf = (targetId: string, organizationId: string) => `${targetId}:group:${organizationId}`;
/** "group" is an organization's group (its key and kind kept from 0.1.0); "team" and "role" are the others. */
export type Kind = "user" | "group" | "team" | "role";
export type GroupRef = { kind: Exclude<Kind, "user">; id: string };
/**
 * A job's kind: a delivery, or "resync", a marker that queues an organization's target's members,
 * accounts and groups a page at a time ("m:<member id>", "l:<user id>", "g:", "G:<group link key>"),
 * each step queueing the next, so a large organization isn't queued inside one request;
 * "reports", which queues a manager's reports; or "decommission", a target's decommission, a step at
 * a time (its cursor is in its own row: see Decommission).
 */
type JobKind = Kind | "resync" | "reports" | "decommission";
/** Credentials expiring within this many days are warned about (daily, at warn)… */
const CREDENTIALS_WARN_DAYS = 30;
/** …and within this many (or once expired), at error and through onFailure. */
const CREDENTIALS_ALERT_DAYS = 7;
/** How often a process looks at its targets' credentials, at most. */
const CREDENTIALS_CHECK_MS = 3_600_000;

/** The job that notes a target's latest credentials alert (see claimCredentialsAlert). */
export const credentialsMarkerKey = (targetId: string) => `${targetId}:credentials:alert`;

/** A JWT's expiry (`exp`), read, not verified: only to warn before it comes. */
export function jwtExpiry(token: string | undefined): Date | null {
  const parts = token?.split(".");
  if (parts?.length !== 3) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob((parts[1] as string).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

/** When a target's credentials expire: as configured (`credentialsExpireAt`), or a bearer token's own `exp`. */
export function credentialsExpiry(target: Target): Date | null {
  if (target.credentialsExpireAt !== undefined) {
    const at = new Date(target.credentialsExpireAt);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  if (target.type !== undefined && target.type !== "scim") return null;
  return jwtExpiry(target.token ?? (target.auth?.type === "bearer" ? target.auth.token : target.auth?.type === "header" ? target.auth.value.split(" ").pop() : undefined));
}

/** A purge of more accounts than this needs their number confirmed. */
export const PURGE_CONFIRM_ABOVE = 500;
/** The decommission job's subject: one per target. */
const STEP = "step";
/** How often a decommission that's waiting on deliveries looks again. */
const SWEEP_MS = 60_000;
/**
 * Links a decommission step queues: one `in` query finds their jobs, so a step is about 60
 * queries (D1 allows 1,000 an invocation, and the run's deliveries need theirs).
 */
const DECOMMISSION_PAGE = 50;
/** A preview counts the accounts another target at the same app shares only up to this many accounts (a page of 500 is about 11 queries). */
const SHARED_SCAN_MAX = 10_000;
/** A Retry-After of 0 (or a date past) still waits this long, so a target that keeps answering 429 isn't asked every run. */
const MIN_RATE_LIMIT_WAIT_MS = 10_000;
/** A job rate limited for longer than this is logged as an error, not a warning: the app may never let it through. */
const RATE_LIMITED_LOUD_MS = 24 * 3_600_000;
/**
 * A role group's id is "<organization id>:<role>", and roles are named by people: "Admin" and
 * "admin" can both exist. Keys must stay distinct under a case-insensitive collation (MySQL's), so
 * a role with anything beyond [a-z0-9_-] is written as "~" and its UTF-8 in hex. Plain roles keep
 * the form 0.3 wrote, so their links and jobs are found as before.
 */
const SAFE_ROLE = /^[a-z0-9_-]*$/;
const hexOf = (text: string) => [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
const textOfHex = (hex: string) => new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16)));
const roleKeyPart = (id: string) => {
  const at = id.indexOf(":");
  const role = id.slice(at + 1);
  return SAFE_ROLE.test(role) ? id : `${id.slice(0, at)}:~${hexOf(role)}`;
};
const keyFor = (kind: JobKind, targetId: string, id: string) =>
  kind === "user" ? keyOf(targetId, id) : kind === "group" ? groupKeyOf(targetId, id) : `${targetId}:${kind}:${kind === "role" ? roleKeyPart(id) : id}`;
/** The key 0.3 wrote for a role group, unencoded: found and moved to the new key once. */
const legacyRoleKey = (targetId: string, id: string) => `${targetId}:role:${id}`;

export interface GroupLink {
  id: string;
  key: string;
  targetId: string;
  organizationId: string;
  /** Which group: "group", "team" or "role", and its id. Null in links written before 1.0. */
  kind?: string | null;
  subjectId?: string | null;
  /** The app's id for the group; empty while its create is pending. */
  remoteId: string;
  displayName: string;
}

export type Outcome = "done" | "retry" | "failed" | "busy";

/**
 * A target's decommission: deactivating every account and emptying every group we made there.
 * `cursor` is where its walk is: "G:<key>" group links, "l:<user id>" accounts, "s:<user id>" the
 * sweep for what's left; after a cancel, "R:<key>" and "r:<user id>" queue them all again; "" done.
 * Moved on only by a compare-and-set on `revision`, so a cancel stops a step that's under way.
 */
export interface Decommission {
  id: string;
  targetId: string;
  phase: "deactivate" | "purge";
  state: "running" | "complete" | "cancelled";
  cursor: string;
  revision: number;
  /** Accounts and groups to go when it started. */
  total: number;
  groupsTotal: number;
  startedAt: Date;
  startedBy: string;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
  cancelledBy?: string | null;
  /** The app it was started at (see appOf): pointed elsewhere since, it stops there. */
  destination?: string | null;
  updatedAt: Date;
}

/**
 * Where a target is in being retired: "none"; "frozen" (marked `decommission` in code, not
 * started: its jobs wait, nothing is sent); "deactivate" (a decommission running or complete:
 * everyone leaves, deactivated, whatever `deprovision` says, and groups are emptied); "purge".
 */
export type Retiring = "none" | "frozen" | "deactivate" | "purge";

const notFound = (e: unknown) => e instanceof ScimError && e.status === 404;

/**
 * The client for a target: SCIM, or Google Workspace's Directory API or Microsoft Graph behind the
 * same operations. `change` names the change being delivered (its job and version), for webhook
 * event ids; `owns` the attributes the target reads (`attributes`, resolved), which Google and
 * Graph need to know what's theirs to clear.
 */
export const clientFor = (target: Target, change?: string, owns?: AttributeFields | null) =>
  target.type === "google-workspace"
    ? googleWorkspaceClient(target, owns)
    : target.type === "entra-id"
      ? entraIdClient(target, owns)
      : target.type === "webhook"
      ? webhookClient(target, change)
      : scimClient({ url: target.url, token: target.token, auth: target.auth, timeoutMs: target.timeoutMs, fetch: target.fetch });

/**
 * Targets that exist but aren't delivered to now: their jobs are queued, and wait. A disabled one's
 * until it's enabled (resume); one whose stored credentials can't be read is looked at again every
 * few minutes, since nothing tells this server when the right secret is back.
 */
const pausedTargets = new WeakMap<object, "disabled" | "unreadable">();
export const markPaused = <T extends Target>(t: T, why: "disabled" | "unreadable" = "disabled"): T => {
  pausedTargets.set(t, why);
  return t;
};
export const isPaused = (t: Target) => pausedTargets.has(t);
/** Why a target is paused, if it is: disabled by its organization, or its stored credentials can't be read. */
export const pauseReason = (t: Target) => pausedTargets.get(t);

/**
 * Where the targets come from, looked up when they're used: the ones in code, and (with a
 * registry) the ones stored by organizations, read from the database each time. Paused targets
 * are included everywhere (isPaused), so changes are queued for them; delivery holds their jobs.
 */
export interface TargetSource {
  /** Some targets are limited to an organization: a user's change then concerns only some targets. */
  scoped: boolean;
  /** The target with this id, or null: it doesn't exist (its jobs are then dropped). */
  get(id: string): Promise<Target | null>;
  /** The targets that concern these organizations: the unscoped ones, and those of these organizations. */
  forOrganizations(organizationIds: readonly string[]): Promise<Target[]>;
  /** Every target, for the host's own endpoints (status, reconcile). */
  every(): Promise<Target[]>;
  /**
   * When each target's credentials expire, where known, without building every target (a stored
   * one's credentials would each have to be decrypted): from its settings. Paused ones left out.
   */
  expiries?(): Promise<{ id: string; at: Date }[]>;
}

/** The targets given in code, fixed at startup. */
export function staticTargets(list: Target[]): TargetSource {
  const byId = new Map(list.map((t) => [t.id, t]));
  return {
    scoped: list.some((t) => t.organizationId),
    get: async (id) => byId.get(id) ?? null,
    forOrganizations: async (ids) => list.filter((t) => !t.organizationId || ids.includes(t.organizationId)),
    every: async () => list,
    expiries: async () => list.flatMap((t) => {
      const at = isPaused(t) ? null : credentialsExpiry(t);
      return at ? [{ id: t.id, at }] : [];
    }),
  };
}

export function outbox(options: ScimProvisioningOptions, adapter: Adapter, log: { info?(m: string): void; warn(m: string): void; error(m: string): void }, source: TargetSource = staticTargets(options.targets), userFields?: ReadonlySet<string>) {
  /** A target's Enterprise User fields, `true` resolved against the user model's fields. */
  const fieldsOf = (target: Target) => enterpriseFields(target.enterprise, userFields);
  /** A target's `attributes` fields, likewise. */
  const attributesOf = (target: Target) => attributeFields(target.attributes, userFields);
  const maxAttempts = options.retry?.maxAttempts ?? 8;
  const audit = auditLog(options.audit, adapter, log);
  /** Targets in code: their audit events have no organization, whatever `organizationId` limits them to. */
  const inCode = new Set(options.targets.map((t) => t.id));
  let credentialsCheckedAt = 0;
  const baseDelayMs = options.retry?.baseDelayMs ?? 30_000;
  const backoff = (attempts: number) => Math.min(MAX_DELAY_MS, baseDelayMs * 2 ** Math.max(0, attempts - 1));

  /** When each paced target (`maxRequestsPerMinute`) may send its next request, in this process. */
  const nextSlot = new Map<string, number>();
  /**
   * The target with its requests spaced out, if it has `maxRequestsPerMinute`. A request that
   * would wait too long is answered here with a 429, as the app would, so its job is held like one.
   * The request after a wait gets its own timeout: the client's started before the wait.
   */
  function paced(target: Target): Target {
    const perMinute = target.maxRequestsPerMinute;
    if (!perMinute) return target;
    const send = target.fetch ?? fetch;
    const timeoutMs = target.timeoutMs ?? 10_000;
    const paced: typeof fetch = async (input, init) => {
      const now = Date.now();
      const at = Math.max(now, nextSlot.get(target.id) ?? 0);
      if (at - now > MAX_PACE_WAIT_MS) {
        const detail = `held back: the target's maxRequestsPerMinute (${perMinute})`;
        return new Response(JSON.stringify({ detail, error: { message: detail } }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(Math.ceil((at - now) / 1000)) } });
      }
      nextSlot.set(target.id, at + 60_000 / perMinute);
      if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
      return send(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    };
    return { ...target, fetch: paced } as Target;
  }

  /** A target's decommission row, if it has one. */
  async function decommissionOf(targetId: string): Promise<Decommission | null> {
    if (!options.decommission) return null;
    const row = (await adapter.findOne({ model: DECOMMISSION_MODEL, where: [{ field: "targetId", value: targetId }] })) as Decommission | null;
    return row && row.targetId === targetId ? row : null;
  }

  /** Where this target is in being retired (see Retiring). One read, only with the `decommission` option. */
  async function retiringOf(target: Target): Promise<Retiring> {
    if (!options.decommission) return "none";
    const row = await decommissionOf(target.id);
    // Pointed at another app since it started: nothing is sent there in its name (status: blocked).
    if (row && (row.state === "running" || row.state === "complete")) return moved(row, target) ? "frozen" : row.phase;
    return target.decommission === true ? "frozen" : "none";
  }

  const moved = (row: Decommission, target: Target) => !!row.destination && row.destination !== appOf(target);

  /** Which app a target sends to: two targets at one app (two organizations' with the same URL) can share an account. */
  const appOf = (t: Target) =>
    JSON.stringify([t.type ?? "scim", t.type === "entra-id" ? t.entra.tenantId : t.type === "google-workspace" ? (t.google.adminEmail.split("@")[1] ?? "").toLowerCase() : trimSlashes(t.url)]);

  /** Another target at the same app still in use (not decommissioning; a frozen one may yet be unmarked). */
  async function stillUsed(target: Target, otherId: string): Promise<boolean> {
    if (otherId === target.id) return false;
    const other = await source.get(otherId);
    if (!other || appOf(other) !== appOf(target)) return false;
    const retiring = await retiringOf(other);
    return retiring === "none" || retiring === "frozen";
  }

  /**
   * Another target at the same app, still in use, linked to this account for the same person: it's
   * theirs too (provisioned through both), so a decommission leaves it be. Active there, for a
   * deactivation; at all, for a purge (deleted, they couldn't switch it back on).
   */
  async function sharedWith(target: Target, userId: string, remoteId: string, purge: boolean): Promise<boolean> {
    const where: Where[] = [{ field: "remoteId", value: remoteId }, { field: "userId", value: userId }];
    if (!purge) where.push({ field: "active", value: true });
    const links = (await adapter.findMany({ model: LINK_MODEL, where, limit: 20 })) as Link[];
    for (const l of links) if (l.remoteId === remoteId && l.userId === userId && (purge || l.active) && (await stillUsed(target, l.targetId))) return true;
    return false;
  }

  /** Another target at the same app, still in use, linked to this group (one organization's two targets there share its groups). */
  async function groupSharedWith(target: Target, remoteId: string): Promise<boolean> {
    const links = (await adapter.findMany({ model: GROUP_LINK_MODEL, where: [{ field: "remoteId", value: remoteId }], limit: 20 })) as GroupLink[];
    for (const l of links) if (l.remoteId === remoteId && (await stillUsed(target, l.targetId))) return true;
    return false;
  }

  /** A rate limit: the app's 429, Google's 403 rateLimitExceeded, or maxRequestsPerMinute's own. */
  const rateLimited = (e: ScimError) => e.status === 429 || e.rateLimited === true;

  /**
   * The app is rate limiting this target: its other jobs that would go before `until` wait until
   * then too, rather than each finding out with a request of its own. Marked 429, so a change to
   * one of those users keeps the wait (enqueue). Jobs being delivered now are left to finish.
   */
  async function holdTarget(targetId: string, until: Date): Promise<void> {
    await adapter.updateMany({
      model: JOB_MODEL,
      where: [
        { field: "targetId", value: targetId },
        { field: "failed", value: false },
        { field: "lockedUntil", value: new Date(), operator: "lt" },
        { field: "nextAttemptAt", value: until, operator: "lt" },
      ],
      update: { nextAttemptAt: until, lastStatus: 429 },
    });
  }

  /**
   * The jobs for (target, user). Normally one; a database without the UNIQUE key (MongoDB builds
   * indexes lazily) can briefly hold two, which is harmless: each delivers the latest state.
   */
  async function jobsFor(key: string): Promise<Job[]> {
    const rows = (await adapter.findMany({ model: JOB_MODEL, where: [{ field: "key", value: key }], limit: 10 })) as Job[];
    return rows.filter((j) => j.key === key);
  }

  const free = (j: Job, now = Date.now()) => !j.failed && new Date(j.lockedUntil).getTime() < now && new Date(j.nextAttemptAt).getTime() <= now;

  /**
   * Ask for (target, user) to be synced; an existing job is bumped rather than duplicated. A job
   * the app rate-limited (429) keeps its wait, so a busy user doesn't cut short the pause the app
   * asked for, unless `now` (reconcile, after fixing a target). A job deleted between the read and the bump (its delivery
   * just finished) is created again, so the change isn't lost.
   */
  async function enqueue(targetId: string, userId: string, o: { now?: boolean; kind?: JobKind } = {}): Promise<void> {
    const kind = o.kind ?? "user";
    const key = keyFor(kind, targetId, userId);
    for (let i = 0; i < 3; i++) if (await queueAs(key, targetId, userId, kind, (await jobsFor(key))[0], o.now === true)) return;
    throw new Error(`[scim] could not queue ${key}`);
  }

  /** Queue each of these (as enqueue, without `now`), their jobs found with one query a batch. */
  async function enqueueMany(targetId: string, refs: { kind: JobKind; id: string }[]): Promise<void> {
    for (let i = 0; i < refs.length; i += IN_BATCH) {
      const batch = refs.slice(i, i + IN_BATCH).map((r) => ({ ...r, key: keyFor(r.kind, targetId, r.id) }));
      const keys = batch.map((b) => b.key);
      const rows = (await adapter.findMany({ model: JOB_MODEL, where: [{ field: "key", value: keys, operator: "in" }], limit: keys.length * 2 })) as Job[];
      const jobs = new Map(rows.filter((j) => keys.includes(j.key)).map((j) => [j.key, j]));
      for (const b of batch) if (!(await queueAs(b.key, targetId, b.id, b.kind, jobs.get(b.key), false))) await enqueue(targetId, b.id, { kind: b.kind });
    }
  }

  /** One try at queueing: `existing` bumped, or the job created. False when it changed meanwhile (look again). */
  async function queueAs(key: string, targetId: string, userId: string, kind: JobKind, existing: Job | undefined, now: boolean): Promise<boolean> {
    const at = new Date();
    const fresh = { attempts: 0, nextAttemptAt: at, failed: false, lastError: null, lastStatus: null, updatedAt: at };
    if (existing) {
      const waiting = !now && !existing.failed && existing.lastStatus === 429 && new Date(existing.nextAttemptAt).getTime() > at.getTime();
      const update = waiting ? { version: existing.version + 1, updatedAt: at } : { ...fresh, version: existing.version + 1 };
      // Deleted meanwhile: looked for again, and created.
      return (await adapter.updateMany({ model: JOB_MODEL, where: [{ field: "id", value: existing.id }], update })) > 0;
    }
    try {
      await adapter.create({ model: JOB_MODEL, data: { key, targetId, userId, ...(kind === "user" ? {} : { kind }), version: 1, lockedUntil: RELEASED, createdAt: at, ...fresh } });
      return true;
    } catch (e) {
      // Created meanwhile (the UNIQUE key): bump that one instead.
      if (!(await jobsFor(key))[0]) throw e;
      return false;
    }
  }

  async function findLink(key: string): Promise<Link | null> {
    const link = (await adapter.findOne({ model: LINK_MODEL, where: [{ field: "key", value: key }] })) as Link | null;
    return link && link.key === key ? link : null;
  }

  async function saveLink(target: Target, userId: string, fields: { remoteId: string; userName: string; externalId: string | null; active: boolean; adopted?: boolean }) {
    const key = keyOf(target.id, userId);
    const update = { ...fields, syncedAt: new Date() };
    if ((await adapter.updateMany({ model: LINK_MODEL, where: [{ field: "key", value: key }], update })) > 0) return;
    await adapter.create({ model: LINK_MODEL, data: { key, targetId: target.id, userId, ...update } });
  }

  const dropLink = (key: string) => adapter.deleteMany({ model: LINK_MODEL, where: [{ field: "key", value: key }] });

  /** The user another link at this target already ties the app's account to, if any. */
  async function ownerOf(target: Target, remoteId: string): Promise<string | null> {
    const rows = (await adapter.findMany({ model: LINK_MODEL, where: [{ field: "targetId", value: target.id }, { field: "remoteId", value: remoteId }], limit: 2 })) as Link[];
    return rows.find((l) => l.targetId === target.id && l.remoteId === remoteId)?.userId ?? null;
  }

  /** Should this user be at this target now? */
  async function wanted(target: Target, user: ProvisionedUser | null): Promise<boolean> {
    if (!user || isBanned(user)) return false;
    if ((target.requireVerifiedEmail ?? true) && user.emailVerified !== true) return false;
    if (target.organizationId) {
      const member = (await adapter.findOne({ model: "member", where: [{ field: "userId", value: user.id }, { field: "organizationId", value: target.organizationId }] })) as { userId?: unknown; organizationId?: unknown } | null;
      if (!member || member.userId !== user.id || member.organizationId !== target.organizationId) return false;
    }
    return target.include ? (await target.include(user)) === true : true;
  }

  /**
   * Make the app match the user: create, update, adopt, reactivate or deprovision. Returns when to
   * look again without a change, if ever: the end of a timed ban.
   */
  /**
   * The Enterprise User extension added to a user about to be sent (unless `mapUser` set it), and
   * the attributes it no longer has, which a PATCH removes. The manager is their id at this app,
   * or their address at Google Workspace, and only once they're provisioned and active there.
   */
  /** Attribute values left out as invalid, logged once an hour per target and attribute (a reconcile mustn't log one line per user). */
  const invalidNoted = new Map<string, number>();
  function noteInvalid(targetId: string, userId: string, names: string[]) {
    const fresh = names.filter((n) => Date.now() - (invalidNoted.get(`${targetId}|${n}`) ?? 0) > 3_600_000);
    if (!fresh.length) return;
    for (const n of fresh) invalidNoted.set(`${targetId}|${n}`, Date.now());
    log.warn(`[scim] ${targetId}: user ${userId}: ${fresh.join(", ")} left out, not a valid value (a language tag such as en-CA; an IANA time zone such as America/Toronto); said once an hour per attribute`);
  }

  /**
   * The user's roles (`roles`: in the target's organization, or in each of theirs) and
   * entitlements (`entitlements`), unless `mapUser` set them. None is a key holding undefined, so
   * a PUT clears them; `clears` lists them for a PATCH.
   */
  async function withAccess(target: Target, user: ProvisionedUser, scim: ScimUser): Promise<{ scim: ScimUser; clears: string[] }> {
    const out: ScimUser = { ...scim };
    const clears: string[] = [];
    if (target.roles && scim.roles === undefined) {
      const roles = await scimRolesOf(target, user.id);
      out.roles = roles.length ? roles : undefined;
      if (!roles.length) clears.push("roles");
    }
    if (target.entitlements && scim.entitlements === undefined) {
      // Your code, with the target's timeout: a hang mustn't hold the job past its lease.
      const limit = target.timeoutMs ?? 10_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let given: string[];
      try {
        given = await Promise.race([Promise.resolve(target.entitlements(user)), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${limit / 1000} s`)), limit)))]);
      } catch (e) {
        // Your code's error, as mapUser's and include's: retried, and failed at maxAttempts.
        throw new Error(`entitlements: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
      const values = [...new Set((Array.isArray(given) ? given : []).filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()))];
      out.entitlements = values.length ? values.map((value) => ({ value })) : undefined;
      if (!values.length) clears.push("entitlements");
    }
    return { scim: out, clears };
  }

  /** A user's organization roles: at an organization's target, there; otherwise in each organization, typed by its slug. */
  async function scimRolesOf(target: Target, userId: string): Promise<NonNullable<ScimUser["roles"]>> {
    const where: Where[] = [{ field: "userId", value: userId }];
    if (target.organizationId) where.push({ field: "organizationId", value: target.organizationId });
    const members = (
      await capped<{ userId: string; organizationId: string; role?: string | null }>(adapter.findMany({ model: "member", where, limit: 1000 }), `user ${userId}: organizations`, "the rest's roles aren't sent")
    ).filter(
      (m) => m.userId === userId && (!target.organizationId || m.organizationId === target.organizationId),
    );
    const slugs = new Map<string, string>();
    if (!target.organizationId) {
      const ids = [...new Set(members.map((m) => m.organizationId))];
      for (let i = 0; i < ids.length; i += IN_BATCH) {
        const batch = ids.slice(i, i + IN_BATCH);
        for (const o of (await adapter.findMany({ model: "organization", where: [{ field: "id", value: batch, operator: "in" }], limit: batch.length })) as { id: string; slug?: string | null }[]) if (batch.includes(o.id)) slugs.set(o.id, o.slug ?? o.id);
      }
    }
    const roles = members.flatMap((m) =>
      String(m.role ?? "")
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean)
        .map((value) => ({ value, type: target.organizationId ? "organization" : (slugs.get(m.organizationId) ?? m.organizationId) })),
    );
    const seen = new Set<string>();
    return roles.filter((r) => !seen.has(`${r.type}|${r.value}`) && seen.add(`${r.type}|${r.value}`)).sort((a, b) => `${a.type}|${a.value}`.localeCompare(`${b.type}|${b.value}`));
  }

  async function withEnterprise(target: Target, user: ProvisionedUser, scim: ScimUser): Promise<{ scim: ScimUser; clears: string[] }> {
    const fields = fieldsOf(target);
    if (!fields || scim[SCIM_ENTERPRISE_USER_SCHEMA] !== undefined) return { scim, clears: [] };
    const { values, managerId } = enterpriseValues(user, fields);
    const named = [...ENTERPRISE_VALUES.filter((a) => fields[a]), ...(fields.manager ? (["manager"] as const) : [])];
    // Every attribute the target names is a key, undefined when it has no value: so Google, which
    // merges into what an admin set, knows which ones are ours to clear (JSON leaves them out).
    const extension: ScimEnterpriseUser = Object.fromEntries(named.map((a) => [a, undefined]));
    Object.assign(extension, values);
    if (managerId) {
      const value = managerValue(target, await findLink(keyOf(target.id, managerId)));
      if (value) extension.manager = { value };
    }
    return {
      scim: { ...scim, schemas: [...new Set([...scim.schemas, SCIM_ENTERPRISE_USER_SCHEMA])], [SCIM_ENTERPRISE_USER_SCHEMA]: extension },
      clears: named.filter((a) => extension[a] === undefined).map((a) => `${SCIM_ENTERPRISE_USER_SCHEMA}:${a}`),
    };
  }

  /** What the reports of a user name as their manager at this target: the user's id there (their address at Google), while active; otherwise nothing. */
  const managerValue = (target: Target, link: Link | null) => (link?.remoteId && link.active ? (target.type === "google-workspace" ? link.userName : link.remoteId) : null);

  /**
   * A user's delivery. With the Enterprise User manager, when what their reports would name as
   * their manager changes (their account at the app appears, goes, is made again under a new id,
   * or at Google gets a new address), a "reports" job is queued to update those reports: a job, so
   * a failure is retried rather than lost.
   */
  async function deliver(target: Target, userId: string, change?: string, retiring: Retiring = "none"): Promise<Date | null> {
    if (!fieldsOf(target)?.manager) return deliverUser(target, userId, change, retiring);
    const key = keyOf(target.id, userId);
    const before = managerValue(target, await findLink(key));
    const result = await deliverUser(target, userId, change, retiring);
    if (managerValue(target, await findLink(key)) !== before) {
      await enqueue(target.id, userId, { kind: "reports" });
      // At once, as part of this delivery; if it fails, the job is retried by the scheduled run.
      await runFor(target.id, userId, "reports").catch(() => {});
    }
    return result;
  }

  /**
   * A "reports" job: queue the users whose manager field names this user (at most a page; a
   * reconcile covers more), at an organization's target only its members. Throws on a database
   * error, so the job is retried.
   */
  async function reportsStep(target: Target, managerId: string): Promise<null> {
    const field = fieldsOf(target)?.manager;
    if (!field) return null;
    const found = (await adapter.findMany({ model: "user", where: [{ field, value: managerId }], limit: PAGE })) as ProvisionedUser[];
    // Exact matches (a case-insensitive collation mustn't widen it), a number field compared as text.
    let reports = found.filter((r) => r[field] != null && String(r[field]) === managerId && r.id !== managerId).map((r) => r.id);
    if (target.organizationId && reports.length) {
      const members = new Set<string>();
      for (let i = 0; i < reports.length; i += IN_BATCH) {
        const ids = reports.slice(i, i + IN_BATCH);
        const rows = (await adapter.findMany({ model: "member", where: [{ field: "organizationId", value: target.organizationId }, { field: "userId", value: ids, operator: "in" }], limit: ids.length })) as { userId: string; organizationId: string }[];
        for (const m of rows) if (m.organizationId === target.organizationId && ids.includes(m.userId)) members.add(m.userId);
      }
      reports = reports.filter((id) => members.has(id));
    }
    for (const id of reports) await enqueue(target.id, id);
    if (found.length >= PAGE) log.warn(`[scim] ${target.id}: user ${managerId} has more than ${PAGE} reports; run a reconcile to update the rest`);
    return null;
  }

  async function deliverUser(target: Target, userId: string, change?: string, retiring: Retiring = "none"): Promise<Date | null> {
    const client = clientFor(paced(target), change, attributesOf(target));
    const user = (await adapter.findOne({ model: "user", where: [{ field: "id", value: userId }] })) as ProvisionedUser | null;
    const key = keyOf(target.id, userId);
    let link = await findLink(key);

    // A target being decommissioned wants nobody.
    if (retiring === "none" && (await wanted(target, user))) {
      const core = withAttributes(user as ProvisionedUser, attributesOf(target), (target.mapUser ?? defaultScimUser)(user as ProvisionedUser));
      if (core.invalid.length) noteInvalid(target.id, userId, core.invalid);
      const access = await withAccess(target, user as ProvisionedUser, core.scim);
      const { scim, clears: enterpriseClears } = await withEnterprise(target, user as ProvisionedUser, access.scim);
      const clears = [...core.clears, ...access.clears, ...enterpriseClears];
      const externalId = scim.externalId ?? null;
      // Back after the plugin deactivated them (a ban, a removal): only then is a Google suspension
      // (or a disabled Entra account) lifted, never an admin's own or one of Google's.
      const reactivate = !!link?.remoteId && !link.active;
      /** Update the account: PUT, or PATCH (with the enterprise attributes cleared since). */
      const update = (id: string) =>
        target.update === "patch"
          ? (client as ReturnType<typeof scimClient>).patch(id, scim, clears)
          : target.type === "google-workspace" || target.type === "entra-id"
            ? (client as ReturnType<typeof googleWorkspaceClient>).replace(id, scim, { reactivate })
            : client.replace(id, scim);
      if (link?.remoteId) {
        try {
          await update(link.remoteId);
          await saveLink(target, userId, { remoteId: link.remoteId, userName: scim.userName, externalId, active: true });
          return null;
        } catch (e) {
          if (!notFound(e)) throw e;
          // Removed at the app since (create it again), or listed under another id now: only the
          // app's list can tell, and asking it also catches a wrong URL, which 404s for everything.
          const other = await stillThere(target, client, userId, link.userName, link.externalId ?? null, link.remoteId);
          if (other) {
            await update(other);
            await saveLink(target, userId, { remoteId: other, userName: scim.userName, externalId, active: true });
            return null;
          }
        }
      }
      // Pending under another name (a create whose reply was lost, then a rename): the account the
      // lost create made is found under the old name and renamed, never left behind beside a new one.
      if (link && !link.remoteId && link.userName !== scim.userName) {
        const settled = await settlePending(target, client, link);
        if (settled) {
          await update(settled.remoteId);
          await saveLink(target, userId, { remoteId: settled.remoteId, userName: scim.userName, externalId, active: true });
          return null;
        }
      }
      // A pending link from an earlier attempt: that create may have made the account (its reply
      // lost), so an account found now may be ours, whatever it looks like.
      const pendingBefore = link !== null && !link.remoteId;
      // Look first, so a second create doesn't make a second account where a create of ours is
      // pending: its reply lost, or accepted and not yet done (a 202, RFC 9967).
      if (pendingBefore && externalId && target.type !== "webhook") {
        const found = await lookUp(client, scim.userName, externalId);
        if (found && found.externalId === externalId) {
          await update(found.id);
          await saveLink(target, userId, { remoteId: found.id, userName: scim.userName, externalId, active: true });
          return null;
        }
      }
      // Pending first: if the reply to the create is lost, we still know to look for it. Pending
      // links have no id, so groups never list a user the app hasn't confirmed.
      await saveLink(target, userId, { remoteId: "", userName: scim.userName, externalId, active: true });
      let remoteId: string;
      try {
        remoteId = await client.create(scim);
      } catch (e) {
        if (!(e instanceof ScimError)) throw e;
        if (e.status !== 409) {
          // Maybe created (no reply, or an error on the way back): keep the pending link to find
          // it later. A refusal means nothing was created, except at Entra ID, where an error can
          // follow the account's creation (its manager refused, say): the pending link is kept
          // there, and found again by its immutableId, so a later ban or delete still reaches it.
          if (!e.retryable && !("findByExternalId" in client)) await dropLink(key);
          throw e;
        }
        // Already there (provisioned by hand, or our own create whose reply was lost): adopt it,
        // but only if it's ours, or nobody's and the email is verified.
        const found = await client.findByUserName(scim.userName);
        const refuse = async (why: string) => {
          // After a lost reply, the account may be the one our own create made: the pending link
          // is kept, so a later ban or delete still looks for it (and fails loudly if it can't
          // tell), instead of leaving an account of ours active at the app with nothing to find it.
          if (pendingBefore && (!found || found.externalId === null))
            throw new ScimError(`${scim.userName}: a create's reply was lost, and ${why}, so we can't tell whether the app's account is ours; resolve it at the app`, 409, false);
          await dropLink(key);
          throw new ScimError(`${scim.userName}: ${why}; resolve it at the app`, 409, false);
        };
        if (!found) {
          // Google's directory (and Graph's replicas) take a moment to show a new account: retried, with the link kept.
          if (target.type === "google-workspace" || target.type === "entra-id") throw new ScimError(`${scim.userName}: ${target.type === "entra-id" ? "Microsoft" : "Google"} says the account exists but can't find it yet; retrying`, 409, true);
          return refuse("the app says it exists but can't find it");
        }
        const ours = found.externalId !== null && found.externalId === externalId;
        if (!ours) {
          // Tied to another user, such as a deleted user whose email was reused: never handed
          // over (by the app's externalId, or by our own links for apps that don't keep it).
          if (found.externalId !== null) return refuse(`the app's account belongs to another user (externalId ${found.externalId})`);
          const owner = await ownerOf(target, found.id);
          if (owner && owner !== userId) return refuse("the app's account is linked to another user");
          // Nobody's: only for an address the user has shown they own, and only when the
          // account's userName is that address: a custom userName (mapUser) proves nothing about
          // who the account was made for.
          if ((user as ProvisionedUser).emailVerified !== true) return refuse("an account with this userName exists at the app, and the user's email is not verified");
          // Taking over accounts made elsewhere is a choice per target: on by default, except at
          // Google Workspace and Entra ID, where it could reach someone's real mailbox (and at
          // Entra, setting the immutableId changes how they sign in).
          const mailbox = target.type === "google-workspace" ? "Google Workspace" : target.type === "entra-id" ? "Entra ID" : null;
          if (!(target.adopt ?? !mailbox))
            return refuse(`an account with this userName already exists at the app, and this target doesn't take over existing accounts (adopt: ${mailbox ? `false, the default for ${mailbox}` : "false"})`);
          // Taking it over would switch it back on, with whatever it held (at Google, someone's
          // mailbox): an admin decides that.
          if (found.active === false)
            return refuse(
              target.type === "google-workspace"
                ? "the Workspace account is suspended; unsuspend it at Google first if it should be taken over"
                : target.type === "entra-id"
                  ? "the Entra account is disabled; enable it in Entra first if it should be taken over"
                  : "the app's account is deactivated; reactivate it at the app first if it should be taken over",
            );
          if (scim.userName.toLowerCase() !== (user as ProvisionedUser).email.toLowerCase())
            return refuse("an account with this userName exists at the app, and its userName isn't the user's verified email, so it isn't taken over");
        }
        await update(found.id);
        remoteId = found.id;
        // Made elsewhere (not ours by externalId): adopted, so never deleted by us, only deactivated.
        if (!ours) {
          await saveLink(target, userId, { remoteId, userName: scim.userName, externalId, active: true, adopted: true });
          return null;
        }
      }
      await saveLink(target, userId, { remoteId, userName: scim.userName, externalId, active: true });
      return null;
    }

    // Leaving. A timed ban ends by itself: look again then (not while decommissioning: the user
    // isn't coming back here, and a long ban mustn't hold the decommission open).
    const recheckAt = retiring === "none" && user && isBanned(user) && user.banExpires != null ? new Date(user.banExpires) : null;
    if (link && !link.remoteId) link = await settlePending(target, client, link);
    if (!link) return recheckAt;
    const externalId = link.externalId ?? null;
    // At Entra ID, Graph can answer a write made seconds after another as done and drop it (found
    // live): so after a disable or a delete, this job comes back a minute later and checks.
    const entra = target.type === "entra-id";
    const confirmAt = () => earliest(recheckAt, new Date(Date.now() + CONFIRM_MS));
    // Decommissioning, and another target at the same app still has this account: only our link goes.
    const purging = retiring === "purge";
    const shared = async (remoteId: string) => {
      if (retiring === "none" || !(await sharedWith(target, userId, remoteId, purging))) return false;
      log.info?.(`[scim] ${target.id}: user ${userId}: their account is also another target's at the same app; left ${purging ? "there" : "active there"}, and only this target's link removed`);
      await dropLink(key);
      return true;
    };
    if ((link.active || purging) && link.remoteId && (await shared(link.remoteId))) return null;
    // An adopted account wasn't made by us: it's deactivated, never deleted, whatever the target says.
    // A decommission deactivates, whatever the target says; only its purge deletes.
    const deprovision = retiring === "deactivate" ? "deactivate" : retiring === "purge" ? "delete" : (target.deprovision ?? "deactivate");
    if (deprovision === "delete" && !link.adopted) {
      // Inactive links too: a target switched from deactivate to delete.
      let removed: string | null = link.remoteId;
      try {
        await client.remove(link.remoteId);
      } catch (e) {
        if (!notFound(e)) throw e;
        removed = await stillThere(target, client, userId, link.userName, externalId, link.remoteId);
        if (removed && (await shared(removed))) return null;
        if (removed) await client.remove(removed);
      }
      // At Entra, the link stays (inactive) until a delete finds the account gone: the check a
      // minute later deletes again, and its 404 (then not found by the immutableId) ends it. The
      // first delete's 404 isn't the end either: an account made seconds earlier can answer 404
      // and be missing from the immutableId lookup for a moment (found live), and taking that as
      // gone left the account live. So it's checked a minute later too; only an inactive link (a
      // delete already sent, or an earlier deactivation) ends on a 404.
      if (entra && (removed || link.active)) {
        await saveLink(target, userId, { remoteId: removed ?? link.remoteId, userName: link.userName, externalId, active: false });
        return confirmAt();
      }
      await dropLink(key);
      return recheckAt;
    }
    if (link.active) {
      let remoteId = link.remoteId;
      try {
        await client.setActive(remoteId, false);
      } catch (e) {
        if (!notFound(e)) throw e;
        const other = await stillThere(target, client, userId, link.userName, externalId, remoteId);
        if (other) {
          await client.setActive(other, false);
          remoteId = other;
        }
      }
      await saveLink(target, userId, { remoteId, userName: link.userName, externalId, active: false });
      return entra ? confirmAt() : recheckAt;
    }
    // Disabled already, by us: at Entra, is that how Graph has it? (The check a minute after the
    // disable, and any later delivery while the user is out.)
    if (entra && (await (client as unknown as EntraIdClient).enabled(link.remoteId))) {
      log.warn(`[scim] ${target.id}: user ${userId}: Entra shows the account enabled, though it was disabled; disabling it again`);
      await client.setActive(link.remoteId, false);
      return confirmAt();
    }
    return recheckAt;
  }

  /**
   * The account for a user, by our externalId where the client can look that up (Entra ID: the
   * immutableId shows at once after a write, while the userPrincipalName lags for seconds, found
   * live), otherwise by userName.
   */
  const lookUp = (client: ReturnType<typeof scimClient>, userName: string, externalId: string | null) =>
    externalId && "findByExternalId" in client ? (client as unknown as EntraIdClient).findByExternalId(externalId) : client.findByUserName(userName);

  /**
   * After a 404 for one user: is the account still at the app, under another id? Asks the app's
   * list, which throws (retryably) if the app can't be asked at all: a wrong URL 404s for
   * everything, and taking that 404 as "gone" left users active at the app (found in the field
   * test). Returns the account's id if it's ours, or null when it's gone.
   */
  async function stillThere(target: Target, client: ReturnType<typeof scimClient>, userId: string, userName: string, externalId: string | null, missing: string): Promise<string | null> {
    const found = await lookUp(client, userName, externalId);
    if (!found) return null;
    const ours = (found.externalId !== null && found.externalId === externalId) || (found.externalId === null && (await ownerOf(target, found.id)) === userId);
    if (!ours) return null;
    // Listed under the very id that just answered 404: the app isn't done creating it (Google, for
    // a few seconds after a create, found live). Retried, rather than failed by a second 404.
    if (found.id === missing) throw new ScimError(`${userName}: the app lists the account but answers 404 for it, so it's still being created; retrying`, 404, true);
    return found.id;
  }

  /**
   * A pending create for a user who is now leaving: find out whether the account exists at the app,
   * and return it as a real link to deprovision, or drop the link.
   */
  async function settlePending(target: Target, client: ReturnType<typeof scimClient>, link: Link): Promise<Link | null> {
    // A receiver has no lookup, but its id is our externalId: the user may have been received, so
    // they're deprovisioned (harmless at a receiver that never saw them).
    if (target.type === "webhook" && link.externalId) return { ...link, remoteId: link.externalId, active: true };
    const found = await lookUp(client, link.userName, link.externalId ?? null);
    const owner = found ? await ownerOf(target, found.id) : null;
    if (!found || (owner && owner !== link.userId) || (found.externalId !== null && found.externalId !== link.externalId)) {
      await dropLink(link.key);
      return null;
    }
    if (found.externalId === null)
      throw new ScimError(`${link.userName}: a create's reply was lost, and the app doesn't keep externalId, so we can't tell whether its account is ours; resolve it at the app`, null, false);
    return { ...link, remoteId: found.id, active: true };
  }

  /**
   * Deliver one job, if no one else holds it. A job bumped during delivery (the user changed
   * again) is delivered again straight away, up to a few rounds, so the latest state goes out.
   */
  async function run(job: Job, round = 0): Promise<Outcome> {
    const now = Date.now();
    const lockedUntil = now + leaseFor((await source.get(job.targetId)) ?? undefined, job.kind);
    const claimed = await adapter.updateMany({
      model: JOB_MODEL,
      // Still due and not failed, not just free: a worker holding an old list of due jobs must not
      // send one another worker has just put off (a 429's Retry-After, a backoff).
      where: [
        { field: "id", value: job.id },
        { field: "lockedUntil", value: new Date(now), operator: "lt" },
        { field: "nextAttemptAt", value: new Date(now + 1), operator: "lt" },
        { field: "failed", value: false },
      ],
      update: { lockedUntil: new Date(lockedUntil) },
    });
    if (claimed === 0) return "busy";
    const current = (await adapter.findOne({ model: JOB_MODEL, where: [{ field: "id", value: job.id }] })) as Job | null;
    if (!current) return "done";
    const target = await source.get(current.targetId);
    if (!target) {
      // A target removed from the configuration (or the registry): nothing to deliver to.
      await adapter.deleteMany({ model: JOB_MODEL, where: [{ field: "id", value: current.id }] });
      return "done";
    }
    if (isPaused(target)) {
      // Kept, not attempted, and out of the scheduled run's way until the target is resumed
      // (resume) or the job is queued again (a change, a reconcile). Only the version read: a job
      // queued again meanwhile (the target enabled, its organization queued) stays due.
      const until = pausedTargets.get(target) === "unreadable" ? new Date(Date.now() + UNREADABLE_RETRY_MS) : PAUSED_UNTIL;
      const parked = await adapter.updateMany({ model: JOB_MODEL, where: [{ field: "id", value: current.id }, { field: "version", value: current.version }], update: { lockedUntil: RELEASED, nextAttemptAt: until } });
      if (parked === 0) await release(current.id);
      // Enabled while this was parking it (resume ran before the parking): due again.
      else {
        const latest = await source.get(current.targetId);
        if (latest && !isPaused(latest)) await adapter.updateMany({ model: JOB_MODEL, where: [{ field: "id", value: current.id }, { field: "nextAttemptAt", value: until }], update: { nextAttemptAt: new Date() } });
      }
      return "busy";
    }
    const isDecommission = current.kind === "decommission";
    const retiring = await retiringOf(target);
    if (retiring === "frozen") {
      // Marked for decommission in code, not started: nothing is sent, and nothing is lost. Looked
      // at again every few minutes, so the jobs go once the mark is removed (or deactivate, once
      // the decommission starts). A scheduled run leaves them out (runDue).
      const row = isDecommission ? await decommissionOf(target.id) : null;
      if (row && moved(row, target)) log.error(`[scim] ${target.id}: its decommission was started at ${row.destination}, and the target now sends to ${appOf(target)}: stopped, and nothing is sent in its name; point it back, or cancel the decommission`);
      const parked = await adapter.updateMany({ model: JOB_MODEL, where: [{ field: "id", value: current.id }, { field: "version", value: current.version }], update: { lockedUntil: RELEASED, nextAttemptAt: new Date(Date.now() + UNREADABLE_RETRY_MS) } });
      if (parked === 0) await release(current.id);
      return "busy";
    }
    // Duplicates (a database without the UNIQUE key): one delivery per user at a time.
    // Free ones are covered by this delivery, which reads the user after this. Of the held ones,
    // the one claimed first goes ahead (then the lower id, for claims at the same moment), and
    // the others wait their turn: they're delivered after it, by nextFor.
    const others = (await jobsFor(current.key)).filter((j) => j.id !== current.id);
    const ahead = (j: Job) => {
      const held = new Date(j.lockedUntil).getTime();
      return held >= now && (held < lockedUntil || (held === lockedUntil && j.id < current.id));
    };
    if (others.some(ahead)) {
      await release(current.id);
      return "busy";
    }
    for (const j of others) {
      await adapter.deleteMany({ model: JOB_MODEL, where: [{ field: "id", value: j.id }, { field: "lockedUntil", value: new Date(now), operator: "lt" }] });
    }
    let recheckAt: Date | null;
    const isGroup = current.kind === "group" || current.kind === "team" || current.kind === "role";
    const isResync = current.kind === "resync";
    const isReports = current.kind === "reports";
    // A group delivery has no fixed number of requests (members a page and a batch at a time; at
    // Google one per member changed): the hold is renewed while it runs, so no second worker
    // claims the job halfway through.
    const renewal =
      isGroup || isDecommission
      ? setInterval(() => {
          const until = new Date(Date.now() + leaseFor(target, current.kind));
          adapter
            .updateMany({ model: JOB_MODEL, where: [{ field: "id", value: current.id }, { field: "lockedUntil", value: new Date(), operator: "gt" }], update: { lockedUntil: until } })
            .catch(() => {});
        }, RENEW_EVERY_MS)
      : undefined;
    try {
      const change = `${current.id}@${current.version}`;
      recheckAt = isResync
        ? await resyncStep(target, current.userId)
        : isDecommission
          ? await decommissionStep(target)
          : isReports
          ? await reportsStep(target, current.userId)
          : isGroup
          ? await deliverGroup(target, { kind: current.kind as GroupRef["kind"], id: current.userId }, change, retiring)
          : await deliver(target, current.userId, change, retiring);
    } catch (e) {
      const err = e instanceof ScimError ? e : new ScimError((e as Error).message, null, true);
      // A rate limit isn't a failure: the job waits as asked (the app's Retry-After) without an
      // attempt counted, so a large sync can't make jobs stuck, and the target's other jobs wait too.
      const limited = rateLimited(err);
      const attempts = limited ? current.attempts : current.attempts + 1;
      // Only an error that won't fix itself fails the job. The app's (an outage, an expired token)
      // keeps retrying, every 6 hours once past maxAttempts, so it recovers when the app does.
      // One from the host's own code or database (mapUser, include, a query) fails at
      // maxAttempts: it won't fix itself on a timer.
      const giveUp = !limited && (!err.retryable || (!(e instanceof ScimError) && attempts >= maxAttempts));
      const wait = limited ? Math.max(err.retryAfterMs ?? RATE_LIMIT_WAIT_MS, MIN_RATE_LIMIT_WAIT_MS) : Math.max(err.retryAfterMs ?? 0, attempts >= maxAttempts ? MAX_DELAY_MS : backoff(attempts));
      const loud = !limited && (giveUp || attempts === maxAttempts);
      // Rate limited for a day: the app may never let it through (a quota, a firewall answering 429).
      const longLimited = limited && !!current.createdAt && Date.now() - new Date(current.createdAt).getTime() > RATE_LIMITED_LOUD_MS;
      (loud || longLimited ? log.error : log.warn)(
        `[scim] ${target.id}: ${isResync ? "queueing its organization at" : isDecommission ? "decommission step" : isReports ? "queueing the users reporting to" : isGroup ? `${current.kind === "group" ? "" : `${current.kind} `}group` : "user"} ${current.userId}: ${err.message}${giveUp ? " (failed; retried on the user's next change or a reconcile)" : limited ? ` (rate limited${longLimited ? ", queued over a day ago" : ""}; the target's jobs wait ${Math.round(wait / 1000)} s)` : ` (attempt ${attempts}; retry in ${Math.round(wait / 1000)} s)`}`,
      );
      const recorded = await adapter.updateMany({
        model: JOB_MODEL,
        where: [{ field: "id", value: current.id }, { field: "version", value: current.version }],
        update: { attempts, lastError: err.message.slice(0, 1000), lastStatus: limited ? 429 : err.status, lockedUntil: RELEASED, failed: giveUp, nextAttemptAt: new Date(Date.now() + wait), updatedAt: new Date() },
      });
      if (limited) await holdTarget(target.id, new Date(Date.now() + wait));
      // Only a failure that was recorded: a job bumped during delivery goes out again at once,
      // so it hasn't failed. The host's hook gets a few seconds; this worker still holds the job.
      if (loud && recorded > 0 && options.onFailure && !isResync && !isReports && !isDecommission) {
        const failure: DeliveryFailure = { targetId: target.id, kind: (isGroup ? current.kind : "user") as DeliveryFailure["kind"], subjectId: current.userId, error: err.message, status: err.status, attempts, failed: giveUp };
        try {
          await Promise.race([options.onFailure(failure), new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ON_FAILURE_TIMEOUT_MS / 1000} s`)), ON_FAILURE_TIMEOUT_MS))]);
        } catch (hookError) {
          log.error(`[scim] onFailure threw: ${(hookError as Error).message}`);
        }
      }
      // Bumped during delivery (a new change, already due now): free it and try the new state;
      // but an app that asked us to wait (429) is waited for, whatever changed meanwhile.
      if (recorded === 0) {
        const hold = limited ? wait : err.retryAfterMs;
        if (hold)
          await adapter.updateMany({
            model: JOB_MODEL,
            where: [{ field: "id", value: current.id }, { field: "nextAttemptAt", value: new Date(Date.now() + hold), operator: "lt" }],
            update: { nextAttemptAt: new Date(Date.now() + hold), lastStatus: limited ? 429 : err.status, updatedAt: new Date() },
          });
        await release(current.id);
      }
      // Only new work goes round again: the bumped job, or a duplicate; never the one that just
      // failed unchanged, which waits for its backoff.
      const again = await nextFor(current.key, round, recorded === 0 ? undefined : current.id);
      if (again) return again;
      return giveUp ? "failed" : "retry";
    } finally {
      if (renewal) clearInterval(renewal);
    }
    const isUser = !isGroup && !isResync && !isReports && !isDecommission;
    // A decommission that started during this delivery (an account just made or switched back on,
    // a group just made or filled): delivered again at once, under it.
    if ((isUser || isGroup) && retiring === "none" && options.decommission && (await retiringOf(target)) !== "none") await enqueue(target.id, current.userId, { kind: (current.kind ?? "user") as JobKind });
    const settled = recheckAt
      ? // Look again when the ban runs out.
        await adapter.updateMany({
          model: JOB_MODEL,
          where: [{ field: "id", value: current.id }, { field: "version", value: current.version }],
          update: { attempts: 0, lastError: null, lastStatus: null, lockedUntil: RELEASED, failed: false, nextAttemptAt: recheckAt, updatedAt: new Date() },
        })
      : await adapter.deleteMany({ model: JOB_MODEL, where: [{ field: "id", value: current.id }, { field: "version", value: current.version }] });
    // Bumped during delivery: keep the job, free it; then deliver whatever is still due for this
    // user (the bumped job, or a duplicate), so the latest change goes out now.
    if (settled === 0) await release(current.id);
    // A decommission step goes once a run: a step queues 50 deliveries, which go first.
    const outcome = (isDecommission ? null : await nextFor(current.key, round)) ?? "done";
    // The user's groups follow: added once they exist at the app, left once they don't.
    if (isUser && retiring === "none" && hasGroups(target)) await syncGroupsOf(target, current.userId);
    return outcome;
  }

  /** Another delivery for the same (target, user), if one is free and due and rounds remain. */
  async function nextFor(key: string, round: number, skipId?: string): Promise<Outcome | null> {
    if (round >= MAX_ROUNDS) return null;
    const next = (await jobsFor(key)).find((j) => j.id !== skipId && free(j));
    if (!next) return null;
    const outcome = await run(next, round + 1);
    return outcome === "busy" ? null : outcome;
  }

  const release = (id: string) => adapter.updateMany({ model: JOB_MODEL, where: [{ field: "id", value: id }], update: { lockedUntil: RELEASED } });

  /**
   * Deliver the jobs that are due, oldest first, `concurrency` at a time (default 4): one at a
   * time was the bottleneck at scale (about 0.7 s a user on Workers and D1). Each job's
   * lease still keeps two deliveries for one user apart.
   */
  async function runDue(limit = 50, targetId?: string): Promise<Record<Outcome, number>> {
    const due = await dueJobs(limit, targetId);
    const tally: Record<Outcome, number> = { done: 0, retry: 0, failed: 0, busy: 0 };
    let next = 0;
    const worker = async () => {
      while (next < due.length) tally[await run(due[next++] as Job)]++;
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, due.length) }, worker));
    // Housekeeping, after the deliveries: never in their way.
    if (targetId === undefined) {
      await audit.prune();
      await checkCredentials();
    }
    return tally;
  }

  /**
   * The jobs a run delivers. A few times the batch is looked at, so that if one target has most of
   * what's due (a slow app, a large organization just queued), it takes at most half the batch and
   * the others' go too. A paced target (maxRequestsPerMinute) takes about a minute's worth (two
   * requests a job): more would only wait their turn, holding up the run. A frozen one takes none.
   * When those fill what was looked at, it looks again past them, so they can't hold up the rest.
   */
  async function dueJobs(limit: number, targetId?: string): Promise<Job[]> {
    const window = targetId === undefined ? limit * 4 : limit;
    const paces = new Map<string, number>();
    const looked = new Set<string>();
    const found = new Map<string, Job>();
    const past: string[] = [];
    for (let pass = 0; ; pass++) {
      const page = (await adapter.findMany({
        model: JOB_MODEL,
        // Not held: jobs another worker holds (or held when it died) mustn't use up the limit.
        where: [
          ...(targetId === undefined ? [] : [{ field: "targetId", value: targetId }]),
          ...past.map((id) => ({ field: "targetId", value: id, operator: "ne" as const })),
          { field: "failed", value: false },
          { field: "nextAttemptAt", value: new Date(Date.now() + 1), operator: "lt" },
          { field: "lockedUntil", value: new Date(Date.now()), operator: "lt" },
        ],
        sortBy: { field: "nextAttemptAt", direction: "asc" },
        limit: window,
      })) as Job[];
      for (const j of page) if (!past.includes(j.targetId)) found.set(j.id, j);
      for (const id of new Set(page.map((j) => j.targetId))) {
        if (looked.has(id)) continue;
        looked.add(id);
        const t = await source.get(id);
        if (t && options.decommission && (await retiringOf(t)) === "frozen") paces.set(id, 0);
        else if (t?.maxRequestsPerMinute) paces.set(id, Math.max(1, Math.floor(t.maxRequestsPerMinute / 2)));
      }
      const all = [...found.values()].sort((a, b) => new Date(a.nextAttemptAt).getTime() - new Date(b.nextAttemptAt).getTime());
      const due = fairShare(all, limit, paces);
      if (targetId !== undefined || page.length < window || due.length >= limit || pass >= 2) return due;
      const queued = new Map<string, number>();
      for (const j of all) queued.set(j.targetId, (queued.get(j.targetId) ?? 0) + 1);
      const full = [...paces].filter(([id, pace]) => !past.includes(id) && (queued.get(id) ?? 0) >= pace).map(([id]) => id);
      if (full.length === 0) return due;
      past.push(...full);
    }
  }

  /**
   * Up to `limit` jobs, oldest first, no target taking more than its share while others' wait; the
   * rest of the batch fills from what's left. A paced target never takes more than its pace.
   */
  function fairShare(jobs: Job[], limit: number, paces: ReadonlyMap<string, number> = new Map()): Job[] {
    const cap = Math.max(1, Math.floor(limit * PER_TARGET_SHARE));
    const taken = new Map<string, number>();
    const picked: Job[] = [];
    const skipped: Job[] = [];
    for (const j of jobs) {
      const n = taken.get(j.targetId) ?? 0;
      const pace = paces.get(j.targetId);
      if (pace !== undefined && n >= pace) continue;
      if (n < Math.min(cap, pace ?? cap) && picked.length < limit) picked.push(j);
      else skipped.push(j);
      taken.set(j.targetId, n + 1);
    }
    return [...picked, ...skipped].slice(0, limit);
  }

  /** Deliver (target, user) now if due, e.g. right after enqueue. */
  async function runFor(targetId: string, userId: string, kind: JobKind = "user"): Promise<Outcome | null> {
    const jobs = await jobsFor(keyFor(kind, targetId, userId));
    const job = jobs.find((j) => free(j));
    if (!job) return jobs.length ? "busy" : null;
    return run(job);
  }

  /** The users linked at a target (active or not), a page at a time, in userId order after `after`. */
  async function linkedUsers(targetId: string, after: string | null, limit = PAGE): Promise<string[]> {
    const where: Where[] = [{ field: "targetId", value: targetId }];
    if (after !== null) where.push({ field: "userId", value: after, operator: "gt" });
    const links = (await adapter.findMany({ model: LINK_MODEL, where, limit, sortBy: { field: "userId", direction: "asc" } })) as Link[];
    return links.filter((l) => l.targetId === targetId).map((l) => l.userId);
  }

  /** Every user linked at a target. */
  async function* allLinkedUsers(targetId: string): AsyncGenerator<string> {
    let after: string | null = null;
    for (;;) {
      const page = await linkedUsers(targetId, after);
      yield* page;
      if (page.length < PAGE) return;
      after = page[page.length - 1] as string;
    }
  }


  // Groups: an organization, a team, or a role in an organization is a group at a target that
  // asks for it (`groups`, `teamGroups`, `roleGroups`), its members those who are provisioned and
  // active there. A group is recomputed from the database on each delivery, so it converges
  // whatever order changes arrive in.

  const inScope = (target: Target, organizationId: string) => !target.organizationId || target.organizationId === organizationId;
  /** Does this target have groups of any kind? */
  const hasGroups = (target: Target) => !!(target.groups || target.teamGroups || target.roleGroups);
  /** The externalId a group carries at the app: the organization's id (as in 0.1.0), or the team's or role's. */
  const externalIdOf = (ref: GroupRef) => (ref.kind === "group" ? ref.id : `${ref.kind}:${ref.id}`);
  /** Roles on a member row: Better Auth keeps several as "admin,member". */
  const rolesOf = (role: unknown) => (typeof role === "string" ? role.split(",").map((r) => r.trim()).filter(Boolean) : []);
  /** A role group's id is "<organization id>:<role>"; organization ids don't contain ":". */
  const splitRoleId = (id: string) => {
    const at = id.indexOf(":");
    return { organizationId: id.slice(0, at), role: id.slice(at + 1) };
  };

  type Org = { id: string; name: string; slug: string | null };
  async function organization(id: string): Promise<Org | null> {
    const org = (await adapter.findOne({ model: "organization", where: [{ field: "id", value: id }] })) as { id: string; name: string; slug?: string | null } | null;
    return org && org.id === id ? { id: org.id, name: org.name, slug: org.slug ?? null } : null;
  }

  /** User ids from rows of `model` matching `where`, a page at a time, in user id order. */
  async function userIdsOf(model: string, where: Where[], keep: (row: Record<string, unknown>) => boolean = () => true): Promise<string[]> {
    const ids: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = (await adapter.findMany({ model, where: after === null ? where : [...where, { field: "userId", value: after, operator: "gt" }], limit: PAGE, sortBy: { field: "userId", direction: "asc" } })) as Record<string, unknown>[];
      for (const row of page) if (where.every((w) => row[w.field] === w.value) && keep(row)) ids.push(row.userId as string);
      if (page.length < PAGE) break;
      after = page[page.length - 1]?.userId as string;
    }
    return ids;
  }

  /**
   * What a group should be now: its organization, whether it's wanted, its name and its members'
   * user ids; null when its organization (or team) no longer exists.
   */
  async function resolveGroup(target: Target, ref: GroupRef): Promise<{ organizationId: string; wanted: boolean; displayName: string; userIds: () => Promise<string[]> } | null> {
    if (ref.kind === "group") {
      const org = await organization(ref.id);
      if (!org) return null;
      const wanted = inScope(target, org.id) && (typeof target.groups === "function" ? (await target.groups(org)) === true : target.groups === true);
      return { organizationId: org.id, wanted, displayName: target.groupName ? target.groupName(org) : org.name, userIds: () => userIdsOf("member", [{ field: "organizationId", value: org.id }]) };
    }
    if (ref.kind === "team") {
      const team = (await adapter.findOne({ model: "team", where: [{ field: "id", value: ref.id }] })) as { id: string; name: string; organizationId: string } | null;
      const org = team && team.id === ref.id ? await organization(team.organizationId) : null;
      if (!team || !org) return null;
      const t = { id: team.id, name: team.name, organizationId: team.organizationId };
      const wanted = inScope(target, org.id) && (typeof target.teamGroups === "function" ? (await target.teamGroups(t, org)) === true : target.teamGroups === true);
      return { organizationId: org.id, wanted, displayName: target.teamGroupName ? target.teamGroupName(t, org) : `${org.name} / ${team.name}`, userIds: () => userIdsOf("teamMember", [{ field: "teamId", value: team.id }]) };
    }
    const { organizationId, role } = splitRoleId(ref.id);
    const org = await organization(organizationId);
    if (!org) return null;
    const holders = () => userIdsOf("member", [{ field: "organizationId", value: org.id }], (m) => rolesOf(m.role).includes(role));
    // A listed role keeps its group even when empty; with `true`, a role no one holds any more has none.
    const wanted =
      inScope(target, org.id) && (Array.isArray(target.roleGroups) ? target.roleGroups.includes(role) : target.roleGroups === true && (await holders()).length > 0);
    return { organizationId: org.id, wanted, displayName: target.roleGroupName ? target.roleGroupName(role, org) : `${org.name} / ${role}`, userIds: holders };
  }

  /** The users' ids at the app: provisioned and active, sorted. */
  async function remoteIdsOf(target: Target, userIds: string[]): Promise<{ value: string }[]> {
    const values: string[] = [];
    for (let i = 0; i < userIds.length; i += IN_BATCH) {
      const batch = userIds.slice(i, i + IN_BATCH);
      const links = (await adapter.findMany({ model: LINK_MODEL, where: [{ field: "targetId", value: target.id }, { field: "userId", value: batch, operator: "in" }], limit: batch.length })) as Link[];
      for (const l of links) if (l.targetId === target.id && batch.includes(l.userId) && l.active && l.remoteId) values.push(l.remoteId);
    }
    return [...new Set(values)].sort().map((value) => ({ value }));
  }

  async function findGroupLink(key: string): Promise<GroupLink | null> {
    const link = (await adapter.findOne({ model: GROUP_LINK_MODEL, where: [{ field: "key", value: key }] })) as GroupLink | null;
    return link && link.key === key ? link : null;
  }

  async function saveGroupLink(target: Target, ref: GroupRef, organizationId: string, fields: { remoteId: string; displayName: string }) {
    const key = keyFor(ref.kind, target.id, ref.id);
    // kind and subjectId are written on every save, so links from before 1.0 gain them too.
    const update = { ...fields, kind: ref.kind, subjectId: ref.id, syncedAt: new Date() };
    if ((await adapter.updateMany({ model: GROUP_LINK_MODEL, where: [{ field: "key", value: key }], update })) > 0) return;
    await adapter.create({ model: GROUP_LINK_MODEL, data: { key, targetId: target.id, organizationId, ...update } });
  }

  /** Make the app's group match its organization, team or role: create, update, adopt, or remove. */
  async function deliverGroup(target: Target, ref: GroupRef, change?: string, retiring: Retiring = "none"): Promise<null> {
    const client = clientFor(paced(target), change);
    const key = keyFor(ref.kind, target.id, ref.id);
    const externalId = externalIdOf(ref);
    let link = await findGroupLink(key);
    // A role group linked by 0.3 under its unencoded key: moved to the new key, so it's still ours.
    if (!link && ref.kind === "role" && key !== legacyRoleKey(target.id, ref.id)) {
      const legacy = await findGroupLink(legacyRoleKey(target.id, ref.id));
      if (legacy) {
        await adapter.updateMany({ model: GROUP_LINK_MODEL, where: [{ field: "id", value: legacy.id }], update: { key, kind: ref.kind, subjectId: ref.id } });
        link = { ...legacy, key };
      }
    }
    // Decommissioning, and another target at the same app still uses this group (one organization's
    // two targets there): it's left as it is, and only this target's link goes.
    if ((retiring === "deactivate" || retiring === "purge") && link?.remoteId && (await groupSharedWith(target, link.remoteId))) {
      log.info?.(`[scim] ${target.id}: ${ref.kind} group ${ref.id}: also another target's at the same app; left as it is there, and only this target's link removed`);
      await adapter.deleteMany({ model: GROUP_LINK_MODEL, where: [{ field: "key", value: key }] });
      return null;
    }
    // Decommissioning: a group of ours is emptied, not removed, so what the app ties to it (AWS
    // permission sets, Access policies) survives a cancel; the purge removes it. None is made.
    if (retiring === "deactivate") {
      if (!link) return null;
      const empty = { schemas: [SCIM_GROUP_SCHEMA], externalId, displayName: link.displayName, members: [] };
      const compat = target.compat ?? {};
      const emptyAt = (id: string) => (compat.groupUpdate === "patch" ? client.patchGroup(id, empty, { membersFrom: compat.groupMembers, batch: compat.maxGroupMembersPerRequest }) : client.replaceGroup(id, empty));
      let remoteId = link.remoteId;
      if (remoteId) {
        try {
          await emptyAt(remoteId);
          return null;
        } catch (e) {
          if (!notFound(e)) throw e;
        }
      } else if (target.type === "webhook") {
        // Pending at a receiver: its id is our externalId.
        await emptyAt(externalId);
        return null;
      }
      // Gone, under another id, or pending (a create whose reply was lost): the list tells.
      const found = await client.findGroupByName(link.displayName, externalId);
      remoteId = found && found.externalId === externalId ? found.id : "";
      if (!remoteId) {
        await adapter.deleteMany({ model: GROUP_LINK_MODEL, where: [{ field: "key", value: key }] });
        return null;
      }
      await emptyAt(remoteId);
      await adapter.updateMany({ model: GROUP_LINK_MODEL, where: [{ field: "key", value: key }], update: { remoteId, syncedAt: new Date() } });
      return null;
    }
    // A purge removes every group of ours there.
    const now = retiring === "purge" ? null : await resolveGroup(target, ref);

    if (!now?.wanted) {
      if (!link) return null;
      if (link.remoteId) {
        try {
          await client.removeGroup(link.remoteId);
        } catch (e) {
          if (!notFound(e)) throw e;
          // Gone, or a wrong URL: the list tells (and throws if the app can't be asked).
          const found = await client.findGroupByName(link.displayName, externalId);
          if (found && found.externalId === externalId) await client.removeGroup(found.id);
        }
      } else if (target.type === "webhook") {
        // Pending at a receiver: it may have the group; its id is our externalId.
        await client.removeGroup(externalId);
      } else {
        // Pending: a create whose reply was lost may have made it. Ours is removed.
        const found = await client.findGroupByName(link.displayName, externalId);
        if (found && found.externalId === externalId) await client.removeGroup(found.id);
      }
      await adapter.deleteMany({ model: GROUP_LINK_MODEL, where: [{ field: "key", value: key }] });
      return null;
    }

    const { organizationId, displayName } = now;
    const group = { schemas: [SCIM_GROUP_SCHEMA], externalId, displayName, members: await remoteIdsOf(target, await now.userIds()) };
    const compat = target.compat ?? {};
    const updateGroup = (id: string) =>
      compat.groupUpdate === "patch" ? client.patchGroup(id, group, { membersFrom: compat.groupMembers, batch: compat.maxGroupMembersPerRequest }) : client.replaceGroup(id, group);
    const createGroup = () => (compat.maxGroupMembersPerRequest ? client.createGroupInBatches(group, compat.maxGroupMembersPerRequest) : client.createGroup(group));
    // An app that can't rename groups: a new group with the new name and the members, then the
    // old one deleted (the order Atlassian documents, so access never lapses).
    const otherOwner = async (remoteId: string) =>
      ((await adapter.findMany({ model: GROUP_LINK_MODEL, where: [{ field: "targetId", value: target.id }, { field: "remoteId", value: remoteId }], limit: 2 })) as GroupLink[]).some((l) => l.remoteId === remoteId && l.key !== key);
    if (link?.remoteId && link.displayName !== displayName && compat.groupRename === "recreate") {
      // The new group may already exist: made by an earlier try whose delete of the old one failed,
      // or whose reply was lost. Ours (our externalId, no other link) is used, never created twice.
      const ours = async () => {
        const found = await client.findGroupByName(displayName, externalId);
        if (!found) return null;
        if (found.externalId !== externalId || (await otherOwner(found.id)))
          throw new ScimError(`group ${displayName}: renaming means creating it anew, and a group with this name already exists at the app`, 409, false);
        await updateGroup(found.id);
        return found.id;
      };
      let created = await ours();
      if (!created) {
        try {
          created = await createGroup();
        } catch (e) {
          if (!(e instanceof ScimError && e.status === 409)) throw e;
          created = await ours();
          if (!created) throw new ScimError(`group ${displayName}: the app says it exists but can't find it`, 409, true);
        }
      }
      // Only once the old group is gone does the link move: a failed delete is retried, finding the
      // new group above rather than making another.
      try {
        await client.removeGroup(link.remoteId);
      } catch (e) {
        if (!notFound(e)) throw e;
      }
      await saveGroupLink(target, ref, organizationId, { remoteId: created, displayName });
      return null;
    }
    if (link?.remoteId) {
      try {
        await updateGroup(link.remoteId);
        await saveGroupLink(target, ref, organizationId, { remoteId: link.remoteId, displayName });
        return null;
      } catch (e) {
        if (!notFound(e)) throw e;
        // Removed at the app since, or a wrong URL: asking the list tells which.
        const found = await client.findGroupByName(link.displayName, externalId);
        if (found && found.externalId === externalId) {
          await updateGroup(found.id);
          await saveGroupLink(target, ref, organizationId, { remoteId: found.id, displayName });
          return null;
        }
      }
    }
    const pendingBefore = link !== null && !link.remoteId;
    /**
     * A group without our externalId, found after a create of ours that may have made it (its
     * reply lost, at an app that drops externalId): ours only if it has members and every one is
     * someone we'd put there. A group made by hand in the meantime, with anyone else in it, is
     * never taken over; an empty one can't be told apart, so it isn't either.
     */
    const onlyOurs = async (found: { id: string; externalId: string | null }) => {
      if (found.externalId !== null) return false;
      const members = await client.groupMembers(found.id);
      const wanted = new Set(group.members.map((m) => m.value));
      return members.length > 0 && members.every((m) => wanted.has(m));
    };
    // Pending under another name (a lost create's reply, then a rename): the group it made is
    // found under the old name and renamed (or, at apps that can't rename, removed and made anew).
    if (link && pendingBefore && link.displayName !== displayName && target.type !== "webhook") {
      const found = await client.findGroupByName(link.displayName, externalId);
      if (found && !(await otherOwner(found.id)) && (found.externalId === externalId || (await onlyOurs(found)))) {
        if (compat.groupRename === "recreate") await client.removeGroup(found.id);
        else {
          await updateGroup(found.id);
          await saveGroupLink(target, ref, organizationId, { remoteId: found.id, displayName });
          return null;
        }
      }
    }
    const refuse = async (): Promise<never> => {
      await adapter.deleteMany({ model: GROUP_LINK_MODEL, where: [{ field: "key", value: key }] });
      const what = ref.kind === "group" ? "organization" : ref.kind;
      throw new ScimError(`group ${displayName}: a group with this name already exists at the app and isn't this ${what}'s; rename one of them, or set ${ref.kind === "group" ? "groupName" : `${ref.kind}GroupName`}`, 409, false);
    };
    // Look before creating: a group of this name that isn't ours is refused here, before any
    // pending link exists, so a pending link always means "our own create may have made it". With
    // one pending (a reply lost, or a 202 not yet done), ours by externalId is taken up here
    // rather than created again; any other is left to the create's 409, as before.
    const existing = await client.findGroupByName(displayName, externalId);
    if (existing && (!pendingBefore || existing.externalId === externalId)) {
      if (existing.externalId !== externalId || (await otherOwner(existing.id))) return refuse();
      await updateGroup(existing.id);
      await saveGroupLink(target, ref, organizationId, { remoteId: existing.id, displayName });
      return null;
    }
    // Pending first, as for users: a create whose reply is lost is ours to adopt later.
    await saveGroupLink(target, ref, organizationId, { remoteId: "", displayName });
    let remoteId: string;
    try {
      remoteId = await createGroup();
    } catch (e) {
      if (!(e instanceof ScimError && e.status === 409)) throw e;
      // A group with this name exists. Ours (our externalId, or no externalId after our own create
      // whose reply was lost) is updated; anyone else's is never taken over: replacing it would
      // rewrite its members.
      const found = await client.findGroupByName(displayName, externalId);
      // Google's reads trail its writes: right after our own create it can say "exists" and still
      // not show the group (found live). Retried, with the pending link kept, as for users.
      if (!found && target.type === "google-workspace") throw new ScimError(`group ${displayName}: Google says it exists but can't find it yet; retrying`, 409, true);
      const ours = found !== null && !(await otherOwner(found.id)) && (found.externalId === externalId || (pendingBefore && (await onlyOurs(found))));
      if (!found || !ours) return refuse();
      await updateGroup(found.id);
      remoteId = found.id;
    }
    await saveGroupLink(target, ref, organizationId, { remoteId, displayName });
    return null;
  }

  /** Rows up to a cap, with a warning when it's reached: beyond it, groups (or roles) would be skipped silently. */
  async function capped<T>(rows: Promise<unknown[]>, what: string, rest = "the rest's groups aren't updated", cap = 1000): Promise<T[]> {
    const got = (await rows) as T[];
    if (got.length >= cap) log.warn(`[scim] ${what}: only the first ${cap} are taken into account; ${rest}`);
    return got;
  }

  /**
   * Every group an organization may have at this target: its own, its teams', its roles', and any
   * still linked (a team removed, a role no longer held), so those are removed.
   */
  async function groupsForOrganization(target: Target, organizationId: string): Promise<GroupRef[]> {
    if (!hasGroups(target) || !inScope(target, organizationId)) return [];
    const refs: GroupRef[] = [];
    if (target.groups) refs.push({ kind: "group", id: organizationId });
    if (target.teamGroups) {
      const teams = await capped<{ id: string; organizationId: string }>(adapter.findMany({ model: "team", where: [{ field: "organizationId", value: organizationId }], limit: 1000 }), `organization ${organizationId}: teams`);
      for (const t of teams) if (t.organizationId === organizationId) refs.push({ kind: "team", id: t.id });
    }
    if (target.roleGroups) {
      const roles = new Set<string>(Array.isArray(target.roleGroups) ? target.roleGroups : []);
      if (target.roleGroups === true) {
        for (let after: string | null = null; ; ) {
          const page = (await adapter.findMany({ model: "member", where: after === null ? [{ field: "organizationId", value: organizationId }] : [{ field: "organizationId", value: organizationId }, { field: "userId", value: after, operator: "gt" }], limit: PAGE, sortBy: { field: "userId", direction: "asc" } })) as { userId: string; organizationId: string; role?: unknown }[];
          for (const m of page) if (m.organizationId === organizationId) for (const r of rolesOf(m.role)) roles.add(r);
          if (page.length < PAGE) break;
          after = (page[page.length - 1] as { userId: string }).userId;
        }
      }
      for (const r of roles) refs.push({ kind: "role", id: `${organizationId}:${r}` });
    }
    const linked = await capped<GroupLink>(adapter.findMany({ model: GROUP_LINK_MODEL, where: [{ field: "targetId", value: target.id }, { field: "organizationId", value: organizationId }], limit: 1000 }), `${target.id}: organization ${organizationId}: linked groups`);
    for (const l of linked) if (l.targetId === target.id && l.organizationId === organizationId) refs.push(refOfLink(l));
    return uniqueRefs(refs);
  }

  /**
   * A link's group: from its kind and subjectId, or, for a link written before 1.0, from its key
   * ("<target>:group|team|role:<id>").
   */
  const refOfLink = (l: GroupLink): GroupRef => {
    if ((l.kind === "group" || l.kind === "team" || l.kind === "role") && l.subjectId) return { kind: l.kind, id: l.subjectId };
    const rest = l.key.slice(l.targetId.length + 1);
    const at = rest.indexOf(":");
    const kind = rest.slice(0, at);
    if (kind === "role") {
      const id = rest.slice(at + 1);
      const sep = id.indexOf(":");
      return { kind, id: id.slice(sep + 1).startsWith("~") ? `${id.slice(0, sep)}:${textOfHex(id.slice(sep + 2))}` : id };
    }
    return kind === "team" ? { kind, id: rest.slice(at + 1) } : { kind: "group", id: l.organizationId };
  };
  const uniqueRefs = (refs: GroupRef[]) => [...new Map(refs.map((r) => [`${r.kind}:${r.id}`, r])).values()];

  /**
   * One step of queueing an organization's target (a "resync" job): a page of its members, then
   * of the users with an account there (to deactivate those who left), then its groups and every
   * group linked there. Queues the next step; null when done. Pages, so a large organization
   * doesn't run past a Workers invocation's limits.
   */
  async function resyncStep(target: Target, cursor: string): Promise<null> {
    const organizationId = target.organizationId;
    if (!organizationId) return null;
    const after = cursor.slice(2);
    let next: string | null = null;
    if (cursor.startsWith("m:")) {
      const where: Where[] = [{ field: "organizationId", value: organizationId }];
      if (after) where.push({ field: "id", value: after, operator: "gt" });
      const page = (await adapter.findMany({ model: "member", where, limit: RESYNC_PAGE, sortBy: { field: "id", direction: "asc" } })) as { id: string; userId: string; organizationId: string }[];
      for (const m of page) if (m.organizationId === organizationId) await enqueue(target.id, m.userId, { now: true });
      next = page.length < RESYNC_PAGE ? "l:" : `m:${(page[page.length - 1] as { id: string }).id}`;
    } else if (cursor.startsWith("l:")) {
      const users = await linkedUsers(target.id, after || null, RESYNC_PAGE);
      for (const userId of users) await enqueue(target.id, userId, { now: true });
      next = users.length < RESYNC_PAGE ? (hasGroups(target) ? "g:" : null) : `l:${users[users.length - 1]}`;
    } else if (cursor.startsWith("g:")) {
      for (const ref of await groupsForOrganization(target, organizationId)) await enqueue(target.id, ref.id, { kind: ref.kind, now: true });
      next = "G:";
    } else if (cursor.startsWith("G:")) {
      // Every group linked there, so those whose organization, team or role is gone are removed.
      const linked = await linkedGroups(target.id, after || null, RESYNC_PAGE);
      for (const l of linked) await enqueue(target.id, l.ref.id, { kind: l.ref.kind, now: true });
      next = linked.length < RESYNC_PAGE ? null : `G:${(linked[linked.length - 1] as { key: string }).key}`;
    }
    if (next) await enqueue(target.id, next, { kind: "resync", now: true });
    return null;
  }

  /** The groups at this target that include (or may include) this user. */
  async function groupsOf(target: Target, userId: string): Promise<GroupRef[]> {
    if (!hasGroups(target)) return [];
    const refs: GroupRef[] = [];
    const memberships = await capped<{ userId: string; organizationId: string; role?: unknown }>(adapter.findMany({ model: "member", where: [{ field: "userId", value: userId }], limit: 1000 }), `user ${userId}: organizations`);
    for (const m of memberships) {
      if (m.userId !== userId || !inScope(target, m.organizationId)) continue;
      if (target.groups) refs.push({ kind: "group", id: m.organizationId });
      if (target.roleGroups) for (const r of rolesOf(m.role)) if (target.roleGroups === true || target.roleGroups.includes(r)) refs.push({ kind: "role", id: `${m.organizationId}:${r}` });
    }
    if (target.teamGroups) {
      const teamIds = await capped<{ userId: string; teamId: string }>(adapter.findMany({ model: "teamMember", where: [{ field: "userId", value: userId }], limit: 1000 }).catch(() => []), `user ${userId}: teams`);
      const mine = teamIds.filter((t) => t.userId === userId).map((t) => t.teamId);
      if (target.organizationId) {
        // An organization's target: only that organization's teams (others' would be queued and dropped).
        for (let i = 0; i < mine.length; i += IN_BATCH) {
          const ids = mine.slice(i, i + IN_BATCH);
          const teams = (await adapter.findMany({ model: "team", where: [{ field: "id", value: ids, operator: "in" }], limit: ids.length })) as { id: string; organizationId: string }[];
          for (const t of teams) if (ids.includes(t.id) && t.organizationId === target.organizationId) refs.push({ kind: "team", id: t.id });
        }
      } else for (const id of mine) refs.push({ kind: "team", id });
    }
    return uniqueRefs(refs);
  }

  /**
   * After a user's delivery: queue their groups. Only queued, so a reconcile of a whole
   * organization updates each group a few times, not once per member; the host delivers them at
   * once for a single change (see index.ts). Never fails the user's job.
   */
  async function syncGroupsOf(target: Target, userId: string): Promise<void> {
    try {
      for (const ref of await groupsOf(target, userId)) await enqueue(target.id, ref.id, { kind: ref.kind });
    } catch (e) {
      log.error(`[scim] ${target.id}: user ${userId}: could not update their groups: ${(e as Error).message}`);
    }
  }

  /** The groups linked at a target, a page at a time in key order (for reconcile: groups whose organization, team or role is gone). */
  async function linkedGroups(targetId: string, after: string | null, limit = PAGE): Promise<{ key: string; ref: GroupRef }[]> {
    const where: Where[] = [{ field: "targetId", value: targetId }];
    if (after !== null) where.push({ field: "key", value: after, operator: "gt" });
    const links = (await adapter.findMany({ model: GROUP_LINK_MODEL, where, limit, sortBy: { field: "key", direction: "asc" } })) as GroupLink[];
    return links.filter((l) => l.targetId === targetId).map((l) => ({ key: l.key, ref: refOfLink(l) }));
  }

  /**
   * Credentials that expire soon, or have: warned about once a day per target (per process), at
   * warn from 30 days out, at error and through onFailure from 7. The scheduled run calls it.
   */
  async function checkCredentials(): Promise<void> {
    if (Date.now() - credentialsCheckedAt < CREDENTIALS_CHECK_MS) return;
    credentialsCheckedAt = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    let expiries: { id: string; at: Date }[];
    try {
      expiries = source.expiries ? await source.expiries() : [];
    } catch (e) {
      log.error(`[scim] couldn't list the targets to check their credentials: ${(e as Error).message}`);
      return;
    }
    const alerts: DeliveryFailure[] = [];
    for (const { id, at } of expiries) {
      const days = (at.getTime() - Date.now()) / 86_400_000;
      if (days > CREDENTIALS_WARN_DAYS) continue;
      const level = days <= 0 ? "expired" : days <= CREDENTIALS_ALERT_DAYS ? "alert" : "warn";
      // Once a day per target and level, across every process: a higher level the same day still goes.
      if (!(await claimCredentialsAlert(id, `${today}|${level}`))) continue;
      const when = at.toISOString().slice(0, 10);
      const error = days <= 0 ? `its credentials expired on ${when}: give it new ones` : `its credentials expire on ${when}, in ${Math.ceil(days)} days: give it new ones before then`;
      if (level === "warn") {
        log.warn(`[scim] ${id}: ${error}`);
        continue;
      }
      log.error(`[scim] ${id}: ${error}`);
      alerts.push({ targetId: id, kind: "credentials", subjectId: id, error, status: null, attempts: 0, failed: days <= 0 });
    }
    // A few at a time, each with its few seconds.
    const onFailure = options.onFailure;
    if (!onFailure) return;
    for (let i = 0; i < alerts.length; i += 10) {
      await Promise.all(
        alerts.slice(i, i + 10).map(async (failure) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([onFailure(failure), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${ON_FAILURE_TIMEOUT_MS / 1000} s`)), ON_FAILURE_TIMEOUT_MS)))]);
          } catch (hookError) {
            log.error(`[scim] onFailure threw: ${(hookError as Error).message}`);
          } finally {
            clearTimeout(timer);
          }
        }),
      );
    }
  }

  /**
   * Note that a target's credentials were alerted about (`mark`: the day and level): true if this
   * call is the one that did, so every process together alerts once. Kept as a job that's never
   * due, under the target's id with "~credentials" (no target's: target ids have no "~"), so it's in
   * no target's counts.
   */
  async function claimCredentialsAlert(targetId: string, mark: string): Promise<boolean> {
    const key = credentialsMarkerKey(targetId);
    const [marker] = await jobsFor(key);
    if (marker) {
      if (marker.lastError === mark) return false;
      return (await adapter.updateMany({ model: JOB_MODEL, where: [{ field: "id", value: marker.id }, { field: "version", value: marker.version }], update: { lastError: mark, version: marker.version + 1, updatedAt: new Date() } })) > 0;
    }
    const now = new Date();
    try {
      await adapter.create({ model: JOB_MODEL, data: { key, targetId: `${targetId}~credentials`, userId: "alert", kind: "credentials", version: 1, attempts: 0, nextAttemptAt: PAUSED_UNTIL, lockedUntil: RELEASED, failed: false, lastError: mark, lastStatus: null, createdAt: now, updatedAt: now } });
      return true;
    } catch {
      // Another process noted it first (the UNIQUE key).
      return false;
    }
  }


  /** Per target: jobs queued, stuck (still retried past maxAttempts) and failed; accounts and groups the app confirmed. */
  async function status(targetIds: string[]) {
    const count = (model: string, where: { field: string; value: string | number | boolean | Date; operator?: "lt" | "gte" | "ne" }[]) => adapter.count({ model, where });
    return Promise.all(
      targetIds.map(async (id) => {
        const t = { field: "targetId", value: id };
        return {
          id,
          // Due now; waiting: its backoff, a Retry-After, or a ban running out.
          queued: await count(JOB_MODEL, [t, { field: "failed", value: false }, { field: "attempts", value: maxAttempts, operator: "lt" }, { field: "nextAttemptAt", value: new Date(Date.now() + 1), operator: "lt" }]),
          waiting: await count(JOB_MODEL, [t, { field: "failed", value: false }, { field: "attempts", value: maxAttempts, operator: "lt" }, { field: "nextAttemptAt", value: new Date(), operator: "gte" }]),
          stuck: await count(JOB_MODEL, [t, { field: "failed", value: false }, { field: "attempts", value: maxAttempts, operator: "gte" }]),
          failed: await count(JOB_MODEL, [t, { field: "failed", value: true }]),
          // Of those waiting, held by the app's rate limit (429): not counted as attempts, so never
          // stuck however long the app keeps refusing; this says so.
          rateLimited: await count(JOB_MODEL, [t, { field: "failed", value: false }, { field: "lastStatus", value: 429 }, { field: "nextAttemptAt", value: new Date(), operator: "gte" }]),
          // Confirmed by the app: a pending create's link has no remoteId yet.
          accounts: await count(LINK_MODEL, [t, { field: "active", value: true }, { field: "remoteId", value: "", operator: "ne" }]),
          groups: await count(GROUP_LINK_MODEL, [t, { field: "remoteId", value: "", operator: "ne" }]),
          // When its credentials expire, if known (see credentialsExpireAt).
          credentialsExpireAt: await source.get(id).then((target) => (target ? (credentialsExpiry(target)?.toISOString() ?? null) : null)),
        };
      }),
    );
  }

  /**
   * Failed and stuck jobs, by id, a page at a time. One query (failed, or past maxAttempts), so
   * the database orders both the page and the cursor: merging two queries in JavaScript would
   * compare ids differently from a case-insensitive collation (MySQL's) and skip some.
   */
  async function failures(o: { targetId?: string | undefined; after?: string | undefined; limit: number }) {
    const where: Where[] = [
      ...(o.targetId ? [{ field: "targetId", value: o.targetId }] : []),
      ...(o.after ? [{ field: "id", value: o.after, operator: "gt" as const }] : []),
      { field: "failed", value: true, connector: "OR" },
      { field: "attempts", value: maxAttempts, operator: "gte", connector: "OR" },
    ];
    const rows = (await adapter.findMany({ model: JOB_MODEL, where, sortBy: { field: "id", direction: "asc" }, limit: o.limit + 1 })) as Job[];
    const items = rows.slice(0, o.limit).map((j) => ({
      targetId: j.targetId,
      kind: (j.kind ?? "user") as "user" | "group" | "team" | "role" | "resync" | "reports" | "decommission",
      subjectId: j.userId,
      failed: j.failed,
      attempts: j.attempts,
      lastStatus: j.lastStatus ?? null,
      lastError: j.lastError ?? null,
      nextAttemptAt: new Date(j.nextAttemptAt).toISOString(),
    }));
    return { items, next: rows.length > o.limit ? (rows[o.limit - 1]?.id ?? null) : null };
  }

  /** One user's account and pending job at each target. */
  async function userStatus(userId: string, targetIds: string[]) {
    const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
    return Promise.all(
      targetIds.map(async (targetId) => {
        const key = keyOf(targetId, userId);
        const link = (await adapter.findOne({ model: LINK_MODEL, where: [{ field: "key", value: key }] })) as (Link & { syncedAt?: unknown }) | null;
        const job = (await jobsFor(key))[0];
        return {
          targetId,
          account: link ? { remoteId: link.remoteId || null, active: link.active, syncedAt: iso(link.syncedAt) } : null,
          job: job ? { attempts: job.attempts, failed: job.failed, lastStatus: job.lastStatus ?? null, lastError: job.lastError ?? null, nextAttemptAt: iso(job.nextAttemptAt) } : null,
        };
      }),
    );
  }

  /**
   * Drift: a page of the app's own list of accounts against our records. Each account that isn't
   * as we'd have it is reported with a finding: `unmanaged` (no link here, and not our
   * externalId: made by hand, or by another tool), `unlinked` (our externalId for a user here, but
   * no link: a lost one, or made before this plugin), or `mismatch` (linked, but deactivated or
   * renamed at the app, or still active though the user was deleted here). Reported, never
   * changed: a reconcile, or queueing the user, is what sends our state again.
   */
  async function drift(target: Target, after: string | null, limit: number) {
    const page = await clientFor(paced(target)).listUsers(after, limit);
    const byRemote = new Map<string, Link>();
    const remoteIds = page.users.map((u) => u.id);
    for (let i = 0; i < remoteIds.length; i += IN_BATCH) {
      const batch = remoteIds.slice(i, i + IN_BATCH);
      const links = (await adapter.findMany({ model: LINK_MODEL, where: [{ field: "targetId", value: target.id }, { field: "remoteId", value: batch, operator: "in" }], limit: batch.length })) as Link[];
      for (const l of links) if (l.targetId === target.id && batch.includes(l.remoteId)) byRemote.set(l.remoteId, l);
    }
    // The users here that matter: the linked ones, and those an unlinked account's externalId names.
    const wanted = [...new Set([...[...byRemote.values()].map((l) => l.userId), ...page.users.filter((u) => !byRemote.has(u.id) && u.externalId).map((u) => u.externalId as string)])];
    const exists = new Set<string>();
    for (let i = 0; i < wanted.length; i += IN_BATCH) {
      const batch = wanted.slice(i, i + IN_BATCH);
      const found = (await adapter.findMany({ model: "user", where: [{ field: "id", value: batch, operator: "in" }], limit: batch.length })) as { id: string }[];
      for (const u of found) if (batch.includes(u.id)) exists.add(u.id);
    }
    // An organization's target provisions its members only: an account for anyone else is nobody's
    // here, and the answer mustn't say whether the id is a user elsewhere on the host.
    let provisions = exists;
    if (target.organizationId) {
      provisions = new Set<string>();
      const ids = [...exists];
      for (let i = 0; i < ids.length; i += IN_BATCH) {
        const batch = ids.slice(i, i + IN_BATCH);
        const rows = (await adapter.findMany({ model: "member", where: [{ field: "organizationId", value: target.organizationId }, { field: "userId", value: batch, operator: "in" }], limit: batch.length })) as { userId: string; organizationId: string }[];
        for (const m of rows) if (m.organizationId === target.organizationId && batch.includes(m.userId)) provisions.add(m.userId);
      }
    }
    const items: { remoteId: string; userName: string; externalId: string | null; active: boolean | null; userId: string | null; finding: "unmanaged" | "unlinked" | "mismatch" | "ours-active"; detail: string }[] = [];
    // A target being decommissioned, or decommissioned, should have no account of ours active.
    // Linked ones only: one another target at the same app shares was left on, its link removed.
    const decommission = await decommissionOf(target.id);
    const retired = decommission?.state === "running" || decommission?.state === "complete";
    for (const u of page.users) {
      const link = byRemote.get(u.id);
      const account = { remoteId: u.id, userName: u.userName, externalId: u.externalId, active: u.active ?? null };
      if (retired && link && u.active !== false) {
        items.push({ ...account, userId: link.userId, finding: "ours-active", detail: link.active ? "active at a target being decommissioned, not reached yet: the decommission deactivates it" : "active at the app though the decommission deactivated it: queue the user, or deactivate it at the app" });
        continue;
      }
      if (link) {
        const problems: string[] = [];
        if (link.active && !exists.has(link.userId)) {
          // Deleted here, and the deprovisioning didn't get through: say what the app shows, not our record.
          problems.push(u.active === false ? "the user was deleted here and the account is deactivated at the app, though our record still says active" : u.active === true ? "the user was deleted here, and the account is still active" : "the user was deleted here, and the account is still there (our record says active)");
        } else if (u.active !== undefined && u.active !== link.active) problems.push(u.active ? "active at the app, deactivated here" : "deactivated at the app, active here");
        if (u.userName.toLowerCase() !== link.userName.toLowerCase()) problems.push(`renamed at the app (we sent ${link.userName})`);
        if (problems.length) items.push({ ...account, userId: link.userId, finding: "mismatch", detail: `${problems.join("; ")}: a reconcile, or queueing the user, sends our state again` });
      } else if (u.externalId && provisions.has(u.externalId)) {
        // Ours by externalId, but not the account the user's link names: a create whose reply was
        // lost (the link is pending), a second account, or a lost link.
        const own = await findLink(keyOf(target.id, u.externalId));
        if (own && !own.remoteId) items.push({ ...account, userId: u.externalId, finding: "mismatch", detail: "a create of ours for this user is pending (its reply was lost): the next delivery settles it" });
        else if (own) items.push({ ...account, userId: u.externalId, finding: "unlinked", detail: `has our externalId for a user whose account here is another one (${own.remoteId}): resolve it at the app` });
        else items.push({ ...account, userId: u.externalId, finding: "unlinked", detail: "has our externalId for a user here, but no link: if its userName is still the user's address, queueing the user takes it over; otherwise resolve it at the app" });
      } else {
        items.push({ ...account, userId: null, finding: "unmanaged", detail: u.externalId ? `its externalId (${u.externalId}) is nobody this target provisions: made by another tool, or for a user since deleted (at an organization's target, no longer a member)` : "no externalId and no link here: made by hand, or by another tool" });
      }
    }
    return { items, scanned: page.users.length, next: page.next };
  }

  /** A page of a target's links after a user id, in user id order; `active`: only those still active (pending creates are). */
  async function linkRows(targetId: string, after: string, active: boolean): Promise<{ rows: Link[]; full: boolean }> {
    const where: Where[] = [{ field: "targetId", value: targetId }];
    if (active) where.push({ field: "active", value: true });
    if (after) where.push({ field: "userId", value: after, operator: "gt" });
    const rows = (await adapter.findMany({ model: LINK_MODEL, where, limit: DECOMMISSION_PAGE, sortBy: { field: "userId", direction: "asc" } })) as Link[];
    return { rows: rows.filter((l) => l.targetId === targetId && (!active || l.active)), full: rows.length >= DECOMMISSION_PAGE };
  }

  /** Which of these users have a job at this target. */
  async function withJobs(targetId: string, userIds: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < userIds.length; i += IN_BATCH) {
      const keys = userIds.slice(i, i + IN_BATCH).map((u) => keyOf(targetId, u));
      const rows = (await adapter.findMany({ model: JOB_MODEL, where: [{ field: "key", value: keys, operator: "in" }], limit: keys.length * 2 })) as Job[];
      for (const j of rows) if (keys.includes(j.key)) found.add(j.userId);
    }
    return found;
  }

  /**
   * One step of a target's decommission (its "decommission" job): a page of its group links, then
   * of its accounts, each queued to leave; then a sweep, until no account of ours there is active
   * and nothing for the target is queued, waiting, stuck or failed. After a cancel, every link is
   * queued again instead, so those still wanted are switched back on. Returns when to look again.
   */
  async function decommissionStep(target: Target): Promise<Date | null> {
    const row = await decommissionOf(target.id);
    if (!row || row.state === "complete" || !row.cursor) return null;
    const at = row.cursor.slice(0, 2);
    const after = row.cursor.slice(2);
    const restoring = row.state === "cancelled";
    const purge = row.phase === "purge";
    let next = "";
    let later: Date | null = null;
    let complete = false;
    if (at === "G:" || at === "R:") {
      // First, everything already queued for the target goes now: a job waiting for a ban to end,
      // or one that failed (a group's create refused), would otherwise hold this open.
      if (!after) await resume(target.id);
      const linked = await linkedGroups(target.id, after || null, DECOMMISSION_PAGE);
      await enqueueMany(target.id, linked.map((l) => l.ref));
      next = linked.length < DECOMMISSION_PAGE ? (restoring ? "r:" : "l:") : `${at}${(linked[linked.length - 1] as { key: string }).key}`;
    } else if (at === "l:" || at === "r:") {
      // Deactivating, the accounts still active; purging, every one not adopted (an adopted account
      // is only ever deactivated); restoring, every one, so those still wanted are switched back on.
      const { rows, full } = await linkRows(target.id, after, at === "l:" && !purge);
      await enqueueMany(target.id, rows.filter((l) => restoring || !purge || !l.adopted).map((l) => ({ kind: "user" as const, id: l.userId })));
      next = full ? `${at}${(rows[rows.length - 1] as Link | undefined)?.userId ?? after}` : restoring ? "" : "s:";
    } else if (at === "s:") {
      // Accounts still to go with nothing queued for them: written behind the walk, by a delivery
      // that was under way when it started.
      const { rows, full } = await linkRows(target.id, after, !purge);
      const toGo = rows.filter((l) => !purge || !l.adopted);
      const queued = await withJobs(target.id, toGo.map((l) => l.userId));
      await enqueueMany(target.id, toGo.filter((l) => !queued.has(l.userId)).map((l) => ({ kind: "user" as const, id: l.userId })));
      if (full) next = `s:${(rows[rows.length - 1] as Link | undefined)?.userId ?? after}`;
      else {
        const t = { field: "targetId", value: target.id };
        const left = (await decommissionCounts(target.id, row.phase)).accounts;
        // Still being delivered (this job is one); a user's failed job no longer matters once no
        // account is left, but a group's does: it may not be empty (or, purging, gone).
        const live = await adapter.count({ model: JOB_MODEL, where: [t, { field: "failed", value: false }, { field: "attempts", value: maxAttempts, operator: "lt" }] });
        const groupsLeft = await adapter.count({ model: JOB_MODEL, where: [t, { field: "kind", value: ["group", "team", "role"], operator: "in" }] });
        const groupLinks = purge ? await adapter.count({ model: GROUP_LINK_MODEL, where: [t] }) : 0;
        if (left === 0 && live <= 1 && groupsLeft === 0 && groupLinks === 0) complete = true;
        else {
          next = "s:";
          later = new Date(Date.now() + SWEEP_MS);
        }
      }
    }
    const now = new Date();
    const moved = await adapter.updateMany({
      model: DECOMMISSION_MODEL,
      where: [{ field: "id", value: row.id }, { field: "revision", value: row.revision }],
      update: { cursor: next, revision: row.revision + 1, updatedAt: now, ...(complete ? { state: "complete", completedAt: now } : {}) },
    });
    // Moved on meanwhile: a cancel or a start (which queued this job again), or another run of this
    // step (one that outlived its hold), which may have set when it looks again. This job stays.
    if (moved === 0) return new Date(Date.now() + 5_000);
    if (complete)
      await audit.record({ targetId: target.id, organizationId: inCode.has(target.id) ? null : (target.organizationId ?? null), actor: "system", action: purge ? "purge.completed" : "decommission.completed", detail: { total: row.total, groupsTotal: row.groupsTotal } });
    if (complete)
      log.warn(`[scim] ${target.id}: ${purge ? `purge complete: none of its accounts (but adopted ones) or groups left there; ${row.total} accounts and ${row.groupsTotal} groups when it started` : `decommission complete: none of its accounts active there, its groups emptied; ${row.total} accounts and ${row.groupsTotal} groups when it started`}`);
    // The next step, in the next run: this one's deliveries go first.
    return next && !later ? now : later;
  }

  /**
   * What a decommission has to do: accounts still active there (pending creates included), and
   * groups linked; for a purge, accounts still there that aren't adopted (those stay, deactivated).
   */
  async function decommissionCounts(targetId: string, phase: Decommission["phase"] = "deactivate") {
    const t = { field: "targetId", value: targetId };
    return {
      accounts:
        phase === "purge"
          ? (await adapter.count({ model: LINK_MODEL, where: [t] })) - (await adapter.count({ model: LINK_MODEL, where: [t, { field: "adopted", value: true }] }))
          : await adapter.count({ model: LINK_MODEL, where: [t, { field: "active", value: true }] }),
      groups: await adapter.count({ model: GROUP_LINK_MODEL, where: [t] }),
    };
  }

  /**
   * Of what decommissionCounts counts, how much another target at the same app still uses, and so
   * is left there (see sharedWith): for a preview. Null past SHARED_SCAN_MAX accounts (not
   * counted), or for a target that can't be built.
   */
  async function sharedCounts(targetId: string, phase: Decommission["phase"] = "deactivate"): Promise<{ accounts: number; groups: number } | null> {
    const target = await source.get(targetId);
    if (!target) return null;
    const purge = phase === "purge";
    const t = { field: "targetId", value: targetId };
    if ((await adapter.count({ model: LINK_MODEL, where: purge ? [t] : [t, { field: "active", value: true }] })) > SHARED_SCAN_MAX) return null;
    const used = new Map<string, Promise<boolean>>();
    const stillUsedOnce = (otherId: string) => {
      const known = used.get(otherId) ?? stillUsed(target, otherId);
      used.set(otherId, known);
      return known;
    };
    let accounts = 0;
    for (let after = "", full = true; full; ) {
      const where: Where[] = [t];
      if (!purge) where.push({ field: "active", value: true });
      if (after) where.push({ field: "userId", value: after, operator: "gt" });
      const page = (await adapter.findMany({ model: LINK_MODEL, where, limit: PAGE, sortBy: { field: "userId", direction: "asc" } })) as Link[];
      full = page.length >= PAGE;
      after = page[page.length - 1]?.userId ?? after;
      const mine = page.filter((l) => l.targetId === targetId && (purge ? !l.adopted : l.active) && l.remoteId);
      for (let i = 0; i < mine.length; i += IN_BATCH) {
        const batch = mine.slice(i, i + IN_BATCH);
        const others = (await adapter.findMany({ model: LINK_MODEL, where: [{ field: "remoteId", value: batch.map((l) => l.remoteId), operator: "in" }], limit: batch.length * 20 })) as Link[];
        for (const l of batch) {
          const theirs = others.filter((o) => o.targetId !== targetId && o.remoteId === l.remoteId && o.userId === l.userId && (purge || o.active));
          for (const o of theirs)
            if (await stillUsedOnce(o.targetId)) {
              accounts++;
              break;
            }
        }
      }
    }
    let groups = 0;
    for (let after: string | null = null, full = true; full; ) {
      const where: Where[] = [t];
      if (after !== null) where.push({ field: "key", value: after, operator: "gt" });
      const page = (await adapter.findMany({ model: GROUP_LINK_MODEL, where, limit: PAGE, sortBy: { field: "key", direction: "asc" } })) as GroupLink[];
      full = page.length >= PAGE;
      after = page[page.length - 1]?.key ?? after;
      const mine = page.filter((g) => g.targetId === targetId && g.remoteId);
      for (let i = 0; i < mine.length; i += IN_BATCH) {
        const batch = mine.slice(i, i + IN_BATCH);
        const others = (await adapter.findMany({ model: GROUP_LINK_MODEL, where: [{ field: "remoteId", value: batch.map((g) => g.remoteId), operator: "in" }], limit: batch.length * 20 })) as GroupLink[];
        for (const g of batch)
          for (const o of others.filter((o) => o.targetId !== targetId && o.remoteId === g.remoteId))
            if (await stillUsedOnce(o.targetId)) {
              groups++;
              break;
            }
      }
    }
    return { accounts, groups };
  }

  async function targetFor(targetId: string): Promise<Target> {
    const target = await source.get(targetId);
    if (!target) throw new Error(`[scim] no target ${targetId}`);
    return target;
  }

  /**
   * After a complete decommission, delete what it deactivated: every account there that isn't
   * adopted, and every group. Irreversible at most apps, so it can't be cancelled. Returns the row,
   * or null if there's no complete decommission to purge. A purge under way is queued again (a
   * nudge, if its step was lost).
   */
  async function startPurge(targetId: string, by: string): Promise<(Decommission & { started: boolean }) | null> {
    const target = await targetFor(targetId);
    for (let i = 0; i < 5; i++) {
      const row = await decommissionOf(target.id);
      if (row?.phase === "purge") {
        if (row.state === "running") await enqueue(target.id, STEP, { kind: "decommission", now: true });
        return { ...row, started: false };
      }
      if (row?.state !== "complete") return null;
      const counts = await decommissionCounts(target.id, "purge");
      const now = new Date();
      const moved = await adapter.updateMany({
        model: DECOMMISSION_MODEL,
        where: [{ field: "id", value: row.id }, { field: "revision", value: row.revision }],
        update: { phase: "purge", state: "running", cursor: "G:", revision: row.revision + 1, total: counts.accounts, groupsTotal: counts.groups, startedAt: now, startedBy: by, completedAt: null, updatedAt: now },
      });
      if (moved > 0) {
        await enqueue(target.id, STEP, { kind: "decommission", now: true });
        const started = await decommissionOf(target.id);
        return started ? { ...started, started: true } : null;
      }
    }
    throw new Error(`[scim] ${target.id}: could not start the purge (its decommission kept changing); try again`);
  }

  /**
   * Start deactivating everything at a target (or start again, after a cancel). Returns its row. One
   * under way is queued again (a nudge, if its step was lost); a complete one is left as it is. The
   * caller checks that it may, and the confirmation.
   */
  async function startDecommission(targetId: string, by: string): Promise<Decommission & { started: boolean }> {
    const target = await targetFor(targetId);
    for (let i = 0; i < 5; i++) {
      const row = await decommissionOf(target.id);
      if (row?.state === "complete") return { ...row, started: false };
      if (row?.state === "running") {
        await enqueue(target.id, STEP, { kind: "decommission", now: true });
        return { ...row, started: false };
      }
      const counts = await decommissionCounts(target.id);
      const now = new Date();
      const fields = { phase: "deactivate", state: "running", cursor: "G:", total: counts.accounts, groupsTotal: counts.groups, startedAt: now, startedBy: by, completedAt: null, cancelledAt: null, cancelledBy: null, destination: appOf(target), updatedAt: now };
      let mine = true;
      if (row) {
        // A cancel's restore steps move it on meanwhile: read again, and retry.
        if ((await adapter.updateMany({ model: DECOMMISSION_MODEL, where: [{ field: "id", value: row.id }, { field: "revision", value: row.revision }], update: { ...fields, revision: row.revision + 1 } })) === 0) continue;
      } else {
        try {
          await adapter.create({ model: DECOMMISSION_MODEL, data: { targetId: target.id, revision: 0, ...fields } });
        } catch (e) {
          // Started meanwhile (the UNIQUE targetId): that one stands.
          if (!(await decommissionOf(target.id))) throw e;
          mine = false;
        }
      }
      const started = (await decommissionOf(target.id)) as Decommission;
      if (started.state === "running") await enqueue(target.id, STEP, { kind: "decommission", now: true });
      return { ...started, started: mine };
    }
    throw new Error(`[scim] ${target.id}: could not start the decommission (it kept changing); try again`);
  }

  /** Stop a running decommission and queue every link again, so those still wanted are switched back on. False if none is running. */
  async function cancelDecommission(targetId: string, by: string): Promise<boolean> {
    for (let i = 0; i < 5; i++) {
      const row = await decommissionOf(targetId);
      // A purge deletes: what's gone can't be switched back on, so it isn't cancelled.
      if (row?.state !== "running" || row.phase === "purge") return false;
      const now = new Date();
      const moved = await adapter.updateMany({
        model: DECOMMISSION_MODEL,
        where: [{ field: "id", value: row.id }, { field: "revision", value: row.revision }],
        update: { state: "cancelled", cursor: "R:", revision: row.revision + 1, cancelledAt: now, cancelledBy: by, updatedAt: now },
      });
      if (moved > 0) {
        await enqueue(targetId, STEP, { kind: "decommission", now: true });
        return true;
      }
      // A step moved it on meanwhile: read it again.
    }
    throw new Error(`[scim] ${targetId}: could not cancel the decommission (it kept changing); try again`);
  }

  /**
   * A target's decommission as it stands: null if it has none; "frozen" when marked in code but
   * not started; "paused" while the target is disabled; "blocked" when all that's left is failed
   * or stuck (the jobs' errors say why).
   */
  async function decommissionStatus(target: Target) {
    const row = await decommissionOf(target.id);
    if (!row && target.decommission !== true) return null;
    const { accounts, groups } = await decommissionCounts(target.id, row?.phase);
    if (!row || row.state === "cancelled") {
      if (target.decommission === true) return { phase: null, state: "frozen" as const, accounts, groups, total: null, groupsTotal: null, startedAt: null, startedBy: null, completedAt: null, cancelledAt: row?.cancelledAt ? new Date(row.cancelledAt).toISOString() : null, estimatedCompletionAt: null };
    }
    if (!row) return null;
    let state: "running" | "blocked" | "paused" | "complete" | "cancelled" = row.state;
    if (state === "running") {
      const t = { field: "targetId", value: target.id };
      const others = (await adapter.count({ model: JOB_MODEL, where: [t] })) - (await adapter.count({ model: JOB_MODEL, where: [{ field: "key", value: keyFor("decommission", target.id, STEP) }] }));
      const bad = await adapter.count({ model: JOB_MODEL, where: [t, { field: "failed", value: true, connector: "OR" }, { field: "attempts", value: maxAttempts, operator: "gte", connector: "OR" }] });
      if (isPaused(target)) state = "paused";
      // Pointed at another app since it started (see run), or all that's left failed or stuck.
      else if (moved(row, target) || (bad > 0 && bad >= others)) state = "blocked";
    }
    const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
    // At the pace so far: the accounts done since it started, and those left.
    let estimatedCompletionAt: string | null = null;
    const done = row.total - accounts;
    const elapsed = Date.now() - new Date(row.startedAt).getTime();
    if (state === "running" && done > 0 && accounts > 0 && elapsed > 0) estimatedCompletionAt = new Date(Date.now() + (accounts * elapsed) / done).toISOString();
    return { phase: row.phase, state, accounts, groups, total: row.total, groupsTotal: row.groupsTotal, startedAt: iso(row.startedAt), startedBy: row.startedBy, completedAt: iso(row.completedAt), cancelledAt: iso(row.cancelledAt), estimatedCompletionAt };
  }

  /**
   * Accounts a decommission (or purge) can't get through, and that someone has dealt with at the
   * app by hand (an account the app won't deactivate, or delete): forgotten here, their links and
   * jobs at this target removed, so it can complete. Only while one is running or complete, and
   * only accounts it's stuck on: linked here, their job failed or past maxAttempts, and not being
   * delivered right now. The others are `skipped`. Null if there's no such decommission. The caller
   * records it.
   */
  async function forgetAccounts(targetId: string, userIds: string[], by: string): Promise<{ forgotten: string[]; skipped: string[] } | null> {
    const row = await decommissionOf(targetId);
    if (row?.state !== "running" && row?.state !== "complete") return null;
    const ids = [...new Set(userIds)];
    const forgotten: string[] = [];
    const skipped: string[] = [];
    const now = Date.now();
    for (let i = 0; i < ids.length; i += IN_BATCH) {
      const batch = ids.slice(i, i + IN_BATCH);
      const keys = batch.map((u) => keyOf(targetId, u));
      const links = new Set(((await adapter.findMany({ model: LINK_MODEL, where: [{ field: "key", value: keys, operator: "in" }], limit: keys.length * 2 })) as Link[]).filter((l) => l.targetId === targetId).map((l) => l.key));
      const jobs = ((await adapter.findMany({ model: JOB_MODEL, where: [{ field: "key", value: keys, operator: "in" }], limit: keys.length * 2 })) as Job[]).filter((j) => j.targetId === targetId && (j.kind ?? "user") === "user");
      const gone: string[] = [];
      for (const [n, userId] of batch.entries()) {
        const key = keys[n] as string;
        const own = jobs.filter((j) => j.key === key);
        const stuck = own.length > 0 && own.every((j) => (j.failed || j.attempts >= maxAttempts) && new Date(j.lockedUntil).getTime() < now);
        if (!links.has(key) || !stuck) {
          skipped.push(userId);
          continue;
        }
        forgotten.push(userId);
        gone.push(key);
      }
      if (gone.length) {
        await adapter.deleteMany({ model: LINK_MODEL, where: [{ field: "key", value: gone, operator: "in" }] });
        await adapter.deleteMany({ model: JOB_MODEL, where: [{ field: "key", value: gone, operator: "in" }] });
      }
    }
    if (forgotten.length) log.warn(`[scim] ${targetId}: ${forgotten.length} accounts forgotten by ${by}, left at the app as they are: ${forgotten.join(", ")}`);
    return { forgotten, skipped };
  }

  /** A target's accounts, a page at a time in user id order (`after`: the last page's `next`). */
  async function accounts(targetId: string, after: string | null, limit: number) {
    const where: Where[] = [{ field: "targetId", value: targetId }];
    if (after) where.push({ field: "userId", value: after, operator: "gt" });
    const rows = ((await adapter.findMany({ model: LINK_MODEL, where, limit: limit + 1, sortBy: { field: "userId", direction: "asc" } })) as Link[]).filter((l) => l.targetId === targetId);
    const items = rows.slice(0, limit).map((l) => ({ userId: l.userId, userName: l.userName, remoteId: l.remoteId || null, active: l.active, adopted: l.adopted === true }));
    return { items, next: rows.length > limit ? (items[items.length - 1]?.userId ?? null) : null };
  }

  /** A resumed (or fixed) target: its waiting and failed jobs are due now. */
  async function resume(targetId: string): Promise<number> {
    return adapter.updateMany({ model: JOB_MODEL, where: [{ field: "targetId", value: targetId }], update: { nextAttemptAt: new Date(), failed: false } });
  }

  return { audit, forgetAccounts, enqueue, resume, run, runDue, runFor, linkedUsers, allLinkedUsers, linkedGroups, groupsOf, groupsForOrganization, hasGroups, source, status, userStatus, failures, drift, accounts, decommissionCounts, sharedCounts, startPurge, decommissionOf, startDecommission, cancelDecommission, decommissionStatus };
}
