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
import { defaultScimUser, isBanned } from "./mapping";
import { googleWorkspaceClient } from "./google";
import { webhookClient } from "./webhook";
import { SCIM_GROUP_SCHEMA, ScimError, scimClient } from "./scim-client";
import type { DeliveryFailure, ProvisionedUser, ScimProvisioningOptions, Target } from "./types";

export const JOB_MODEL = "scimProvisioningJob";
export const LINK_MODEL = "scimProvisioningLink";
export const GROUP_LINK_MODEL = "scimProvisioningGroupLink";

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
/** How long a paused target's jobs wait before they're looked at again. */
const PAUSED_RECHECK_MS = 5 * 60_000;

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
const keyFor = (kind: Kind, targetId: string, id: string) =>
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

const notFound = (e: unknown) => e instanceof ScimError && e.status === 404;

/** The client for a target: SCIM, or Google Workspace's Directory API behind the same operations. */
/** `change` names the change being delivered (its job and version), for webhook event ids. */
const clientFor = (target: Target, change?: string) =>
  target.type === "google-workspace"
    ? googleWorkspaceClient(target)
    : target.type === "webhook"
      ? webhookClient(target, change)
      : scimClient({ url: target.url, token: target.token, auth: target.auth, timeoutMs: target.timeoutMs, fetch: target.fetch });

/**
 * Where the targets come from, looked up when they're used: the ones in code, and (with a
 * registry) the ones stored by organizations. `get` is authoritative: null means the target
 * doesn't exist (its jobs are then dropped), never "not in a cache yet". "paused" means it exists
 * but isn't delivered to now (disabled, or its stored credentials can't be read): its jobs wait.
 * `all` lists only the targets delivered to.
 */
export interface TargetSource {
  all(): Promise<Target[]>;
  get(id: string): Promise<Target | "paused" | null>;
}

/** The targets given in code, fixed at startup. */
export function staticTargets(list: Target[]): TargetSource {
  const byId = new Map(list.map((t) => [t.id, t]));
  return { all: async () => list, get: async (id) => byId.get(id) ?? null };
}

export function outbox(options: ScimProvisioningOptions, adapter: Adapter, log: { warn(m: string): void; error(m: string): void }, source: TargetSource = staticTargets(options.targets)) {
  const maxAttempts = options.retry?.maxAttempts ?? 8;
  const baseDelayMs = options.retry?.baseDelayMs ?? 30_000;
  const backoff = (attempts: number) => Math.min(MAX_DELAY_MS, baseDelayMs * 2 ** Math.max(0, attempts - 1));

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
  async function enqueue(targetId: string, userId: string, o: { now?: boolean; kind?: Kind } = {}): Promise<void> {
    const kind = o.kind ?? "user";
    const key = keyFor(kind, targetId, userId);
    for (let i = 0; i < 3; i++) {
      const now = new Date();
      const fresh = { attempts: 0, nextAttemptAt: now, failed: false, lastError: null, lastStatus: null, updatedAt: now };
      const existing = (await jobsFor(key))[0];
      if (existing) {
        const waiting = !o.now && !existing.failed && existing.lastStatus === 429 && new Date(existing.nextAttemptAt).getTime() > now.getTime();
        const update = waiting ? { version: existing.version + 1, updatedAt: now } : { ...fresh, version: existing.version + 1 };
        if ((await adapter.updateMany({ model: JOB_MODEL, where: [{ field: "id", value: existing.id }], update })) > 0) return;
        continue; // deleted meanwhile: look again, and create it
      }
      try {
        await adapter.create({ model: JOB_MODEL, data: { key, targetId, userId, ...(kind === "user" ? {} : { kind }), version: 1, lockedUntil: RELEASED, createdAt: now, ...fresh } });
        return;
      } catch (e) {
        // Created meanwhile (the UNIQUE key): bump that one instead.
        if (!(await jobsFor(key))[0]) throw e;
      }
    }
    throw new Error(`[scim] could not queue ${key}`);
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
  async function deliver(target: Target, userId: string, change?: string): Promise<Date | null> {
    const client = clientFor(target, change);
    const user = (await adapter.findOne({ model: "user", where: [{ field: "id", value: userId }] })) as ProvisionedUser | null;
    const key = keyOf(target.id, userId);
    let link = await findLink(key);

    if (await wanted(target, user)) {
      const scim = (target.mapUser ?? defaultScimUser)(user as ProvisionedUser);
      const externalId = scim.externalId ?? null;
      if (link?.remoteId) {
        try {
          await (target.update === "patch" ? client.patch : client.replace)(link.remoteId, scim);
          await saveLink(target, userId, { remoteId: link.remoteId, userName: scim.userName, externalId, active: true });
          return null;
        } catch (e) {
          if (!notFound(e)) throw e;
          // Removed at the app since (create it again), or listed under another id now: only the
          // app's list can tell, and asking it also catches a wrong URL, which 404s for everything.
          const other = await stillThere(target, client, userId, link.userName, link.externalId ?? null, link.remoteId);
          if (other) {
            await (target.update === "patch" ? client.patch : client.replace)(other, scim);
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
          await (target.update === "patch" ? client.patch : client.replace)(settled.remoteId, scim);
          await saveLink(target, userId, { remoteId: settled.remoteId, userName: scim.userName, externalId, active: true });
          return null;
        }
      }
      // A pending link from an earlier attempt: that create may have made the account (its reply
      // lost), so an account found now may be ours, whatever it looks like.
      const pendingBefore = link !== null && !link.remoteId;
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
          // it later. A refusal means nothing was created.
          if (!e.retryable) await dropLink(key);
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
          // Google's directory takes a moment to show a new account: retried, with the link kept.
          if (target.type === "google-workspace") throw new ScimError(`${scim.userName}: Google says the account exists but can't find it yet; retrying`, 409, true);
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
          // Google Workspace, where it could reach someone's real mailbox.
          if (!(target.adopt ?? target.type !== "google-workspace"))
            return refuse(`an account with this userName already exists at the app, and this target doesn't take over existing accounts (adopt: ${target.type === "google-workspace" ? "false, the default for Google Workspace" : "false"})`);
          // Taking it over would switch it back on, with whatever it held (at Google, someone's
          // mailbox): an admin decides that.
          if (found.active === false)
            return refuse(
              target.type === "google-workspace"
                ? "the Workspace account is suspended; unsuspend it at Google first if it should be taken over"
                : "the app's account is deactivated; reactivate it at the app first if it should be taken over",
            );
          if (scim.userName.toLowerCase() !== (user as ProvisionedUser).email.toLowerCase())
            return refuse("an account with this userName exists at the app, and its userName isn't the user's verified email, so it isn't taken over");
        }
        await (target.update === "patch" ? client.patch : client.replace)(found.id, scim);
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

    // Leaving. A timed ban ends by itself: look again then.
    const recheckAt = user && isBanned(user) && user.banExpires != null ? new Date(user.banExpires) : null;
    if (link && !link.remoteId) link = await settlePending(target, client, link);
    if (!link) return recheckAt;
    const externalId = link.externalId ?? null;
    // An adopted account wasn't made by us: it's deactivated, never deleted, whatever the target says.
    if ((target.deprovision ?? "deactivate") === "delete" && !link.adopted) {
      // Inactive links too: a target switched from deactivate to delete.
      try {
        await client.remove(link.remoteId);
      } catch (e) {
        if (!notFound(e)) throw e;
        const other = await stillThere(target, client, userId, link.userName, externalId, link.remoteId);
        if (other) await client.remove(other);
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
    }
    return recheckAt;
  }

  /**
   * After a 404 for one user: is the account still at the app, under another id? Asks the app's
   * list, which throws (retryably) if the app can't be asked at all: a wrong URL 404s for
   * everything, and taking that 404 as "gone" left users active at the app (found in the field
   * test). Returns the account's id if it's ours, or null when it's gone.
   */
  async function stillThere(target: Target, client: ReturnType<typeof scimClient>, userId: string, userName: string, externalId: string | null, missing: string): Promise<string | null> {
    const found = await client.findByUserName(userName);
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
    const found = await client.findByUserName(link.userName);
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
    const known = await source.get(job.targetId);
    const lockedUntil = now + leaseFor(typeof known === "object" ? (known ?? undefined) : undefined, job.kind);
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
    if (target === "paused") {
      // Kept, not attempted: looked at again in a while, delivered once the target is back.
      await adapter.updateMany({ model: JOB_MODEL, where: [{ field: "id", value: current.id }], update: { lockedUntil: RELEASED, nextAttemptAt: new Date(now + PAUSED_RECHECK_MS) } });
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
    // A group delivery has no fixed number of requests (members a page and a batch at a time; at
    // Google one per member changed): the hold is renewed while it runs, so no second worker
    // claims the job halfway through.
    const renewal = isGroup
      ? setInterval(() => {
          const until = new Date(Date.now() + leaseFor(target, current.kind));
          adapter
            .updateMany({ model: JOB_MODEL, where: [{ field: "id", value: current.id }, { field: "lockedUntil", value: new Date(), operator: "gt" }], update: { lockedUntil: until } })
            .catch(() => {});
        }, RENEW_EVERY_MS)
      : undefined;
    try {
      const change = `${current.id}@${current.version}`;
      recheckAt = isGroup ? await deliverGroup(target, { kind: current.kind as GroupRef["kind"], id: current.userId }, change) : await deliver(target, current.userId, change);
    } catch (e) {
      const attempts = current.attempts + 1;
      const err = e instanceof ScimError ? e : new ScimError((e as Error).message, null, true);
      // Only an error that won't fix itself fails the job. The app's (an outage, an expired token)
      // keeps retrying, every 6 hours once past maxAttempts, so it recovers when the app does.
      // One from the host's own code or database (mapUser, include, a query) fails at
      // maxAttempts: it won't fix itself on a timer.
      const giveUp = !err.retryable || (!(e instanceof ScimError) && attempts >= maxAttempts);
      const wait = Math.max(err.retryAfterMs ?? 0, attempts >= maxAttempts ? MAX_DELAY_MS : backoff(attempts));
      const loud = giveUp || attempts === maxAttempts;
      (loud ? log.error : log.warn)(
        `[scim] ${target.id}: ${isGroup ? `${current.kind === "group" ? "" : `${current.kind} `}group` : "user"} ${current.userId}: ${err.message}${giveUp ? " (failed; retried on the user's next change or a reconcile)" : ` (attempt ${attempts}; retry in ${Math.round(wait / 1000)} s)`}`,
      );
      const recorded = await adapter.updateMany({
        model: JOB_MODEL,
        where: [{ field: "id", value: current.id }, { field: "version", value: current.version }],
        update: { attempts, lastError: err.message.slice(0, 1000), lastStatus: err.status, lockedUntil: RELEASED, failed: giveUp, nextAttemptAt: new Date(Date.now() + wait), updatedAt: new Date() },
      });
      // Only a failure that was recorded: a job bumped during delivery goes out again at once,
      // so it hasn't failed. The host's hook gets a few seconds; this worker still holds the job.
      if (loud && recorded > 0 && options.onFailure) {
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
        if (err.retryAfterMs)
          await adapter.updateMany({
            model: JOB_MODEL,
            where: [{ field: "id", value: current.id }, { field: "nextAttemptAt", value: new Date(Date.now() + err.retryAfterMs), operator: "lt" }],
            update: { nextAttemptAt: new Date(Date.now() + err.retryAfterMs), lastStatus: err.status, updatedAt: new Date() },
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
    const outcome = (await nextFor(current.key, round)) ?? "done";
    // The user's groups follow: added once they exist at the app, left once they don't.
    if (!isGroup && hasGroups(target)) await syncGroupsOf(target, current.userId);
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
  async function runDue(limit = 50): Promise<Record<Outcome, number>> {
    const due = (await adapter.findMany({
      model: JOB_MODEL,
      // Not held: jobs another worker holds (or held when it died) mustn't use up the limit.
      where: [
        { field: "failed", value: false },
        { field: "nextAttemptAt", value: new Date(Date.now() + 1), operator: "lt" },
        { field: "lockedUntil", value: new Date(Date.now()), operator: "lt" },
      ],
      sortBy: { field: "nextAttemptAt", direction: "asc" },
      limit,
    })) as Job[];
    const tally: Record<Outcome, number> = { done: 0, retry: 0, failed: 0, busy: 0 };
    let next = 0;
    const worker = async () => {
      while (next < due.length) tally[await run(due[next++] as Job)]++;
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, due.length) }, worker));
    return tally;
  }

  /** Deliver (target, user) now if due, e.g. right after enqueue. */
  async function runFor(targetId: string, userId: string, kind: Kind = "user"): Promise<Outcome | null> {
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
  async function deliverGroup(target: Target, ref: GroupRef, change?: string): Promise<null> {
    const client = clientFor(target, change);
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
    const now = await resolveGroup(target, ref);

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
    if (!pendingBefore) {
      // Look before creating: a group of this name that isn't ours is refused here, before any
      // pending link exists, so a pending link always means "our own create may have made it".
      const existing = await client.findGroupByName(displayName, externalId);
      if (existing) {
        if (existing.externalId !== externalId || (await otherOwner(existing.id))) return refuse();
        await updateGroup(existing.id);
        await saveGroupLink(target, ref, organizationId, { remoteId: existing.id, displayName });
        return null;
      }
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

  /** Rows up to a cap, with a warning when it's reached: beyond it, groups would be skipped silently. */
  async function capped<T>(rows: Promise<unknown[]>, what: string, cap = 1000): Promise<T[]> {
    const got = (await rows) as T[];
    if (got.length >= cap) log.warn(`[scim] ${what}: only the first ${cap} are taken into account; the rest's groups aren't updated`);
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
      for (const t of teamIds) if (t.userId === userId) refs.push({ kind: "team", id: t.teamId });
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
          // Confirmed by the app: a pending create's link has no remoteId yet.
          accounts: await count(LINK_MODEL, [t, { field: "active", value: true }, { field: "remoteId", value: "", operator: "ne" }]),
          groups: await count(GROUP_LINK_MODEL, [t, { field: "remoteId", value: "", operator: "ne" }]),
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
      kind: (j.kind ?? "user") as "user" | "group" | "team" | "role",
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

  return { enqueue, run, runDue, runFor, linkedUsers, allLinkedUsers, linkedGroups, groupsOf, groupsForOrganization, hasGroups, source, status, userStatus, failures };
}
