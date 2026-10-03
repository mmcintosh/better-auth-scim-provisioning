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
import { SCIM_GROUP_SCHEMA, ScimError, scimClient } from "./scim-client";
import type { ProvisionedUser, ScimProvisioningOptions, ScimTarget } from "./types";

export const JOB_MODEL = "scimProvisioningJob";
export const LINK_MODEL = "scimProvisioningLink";
export const GROUP_LINK_MODEL = "scimProvisioningGroupLink";

type Where = { field: string; value: unknown; operator?: "eq" | "lt" | "gt" | "in" };
export interface Adapter {
  create(a: { model: string; data: Record<string, unknown> }): Promise<unknown>;
  findOne(a: { model: string; where: Where[] }): Promise<unknown>;
  findMany(a: { model: string; where?: Where[]; limit?: number; offset?: number; sortBy?: { field: string; direction: "asc" | "desc" } }): Promise<unknown[]>;
  update(a: { model: string; where: Where[]; update: Record<string, unknown> }): Promise<unknown>;
  updateMany(a: { model: string; where: Where[]; update: Record<string, unknown> }): Promise<number>;
  deleteMany(a: { model: string; where: Where[] }): Promise<number>;
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
}

/**
 * "Not held": any date in the past works; 2000-01-01 rather than the epoch, which MySQL's
 * TIMESTAMP columns reject (they start one second after it).
 */
const RELEASED = new Date("2000-01-01T00:00:00.000Z");
/**
 * How long a claimed job is held: a delivery makes at most four requests (replace, create, find,
 * replace), each up to the target's timeout, plus a margin. Shorter, and a second worker could
 * claim a job still being delivered.
 */
const leaseFor = (target: ScimTarget | undefined) => 12 * (target?.timeoutMs ?? 10_000) + 30_000;
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
export type Kind = "user" | "group";
const keyFor = (kind: Kind, targetId: string, id: string) => (kind === "group" ? groupKeyOf(targetId, id) : keyOf(targetId, id));

export interface GroupLink {
  id: string;
  key: string;
  targetId: string;
  organizationId: string;
  /** The app's id for the group; empty while its create is pending. */
  remoteId: string;
  displayName: string;
}

export type Outcome = "done" | "retry" | "failed" | "busy";

const notFound = (e: unknown) => e instanceof ScimError && e.status === 404;

export function outbox(options: ScimProvisioningOptions, adapter: Adapter, log: { warn(m: string): void; error(m: string): void }) {
  const targets = new Map(options.targets.map((t) => [t.id, t]));
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
        await adapter.create({ model: JOB_MODEL, data: { key, targetId, userId, ...(kind === "group" ? { kind } : {}), version: 1, lockedUntil: RELEASED, createdAt: now, ...fresh } });
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

  async function saveLink(target: ScimTarget, userId: string, fields: { remoteId: string; userName: string; externalId: string | null; active: boolean }) {
    const key = keyOf(target.id, userId);
    const update = { ...fields, syncedAt: new Date() };
    if ((await adapter.updateMany({ model: LINK_MODEL, where: [{ field: "key", value: key }], update })) > 0) return;
    await adapter.create({ model: LINK_MODEL, data: { key, targetId: target.id, userId, ...update } });
  }

  const dropLink = (key: string) => adapter.deleteMany({ model: LINK_MODEL, where: [{ field: "key", value: key }] });

  /** The user another link at this target already ties the app's account to, if any. */
  async function ownerOf(target: ScimTarget, remoteId: string): Promise<string | null> {
    const rows = (await adapter.findMany({ model: LINK_MODEL, where: [{ field: "targetId", value: target.id }, { field: "remoteId", value: remoteId }], limit: 2 })) as Link[];
    return rows.find((l) => l.targetId === target.id && l.remoteId === remoteId)?.userId ?? null;
  }

  /** Should this user be at this target now? */
  async function wanted(target: ScimTarget, user: ProvisionedUser | null): Promise<boolean> {
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
  async function deliver(target: ScimTarget, userId: string): Promise<Date | null> {
    const client = scimClient({ url: target.url, token: target.token, auth: target.auth, timeoutMs: target.timeoutMs, fetch: target.fetch });
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
          const other = await stillThere(target, client, userId, link.userName, link.externalId ?? null);
          if (other) {
            await (target.update === "patch" ? client.patch : client.replace)(other, scim);
            await saveLink(target, userId, { remoteId: other, userName: scim.userName, externalId, active: true });
            return null;
          }
        }
      }
      // Pending first: if the reply to the create is lost, we still know to look for it.
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
          await dropLink(key);
          throw new ScimError(`${scim.userName}: ${why}; resolve it at the app`, 409, false);
        };
        if (!found) return refuse("the app says it exists but can't find it");
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
          if (scim.userName.toLowerCase() !== (user as ProvisionedUser).email.toLowerCase())
            return refuse("an account with this userName exists at the app, and its userName isn't the user's verified email, so it isn't taken over");
        }
        await (target.update === "patch" ? client.patch : client.replace)(found.id, scim);
        remoteId = found.id;
      }
      await saveLink(target, userId, { remoteId, userName: scim.userName, externalId, active: true });
      return null;
    }

    // Leaving. A timed ban ends by itself: look again then.
    const recheckAt = user && isBanned(user) && user.banExpires != null ? new Date(user.banExpires) : null;
    if (link && !link.remoteId) link = await settlePending(target, client, link);
    if (!link) return recheckAt;
    const externalId = link.externalId ?? null;
    if ((target.deprovision ?? "deactivate") === "delete") {
      // Inactive links too: a target switched from deactivate to delete.
      try {
        await client.remove(link.remoteId);
      } catch (e) {
        if (!notFound(e)) throw e;
        const other = await stillThere(target, client, userId, link.userName, externalId);
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
        const other = await stillThere(target, client, userId, link.userName, externalId);
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
  async function stillThere(target: ScimTarget, client: ReturnType<typeof scimClient>, userId: string, userName: string, externalId: string | null): Promise<string | null> {
    const found = await client.findByUserName(userName);
    if (!found) return null;
    if (found.externalId !== null && found.externalId === externalId) return found.id;
    return found.externalId === null && (await ownerOf(target, found.id)) === userId ? found.id : null;
  }

  /**
   * A pending create for a user who is now leaving: find out whether the account exists at the app,
   * and return it as a real link to deprovision, or drop the link.
   */
  async function settlePending(target: ScimTarget, client: ReturnType<typeof scimClient>, link: Link): Promise<Link | null> {
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
    const lockedUntil = now + leaseFor(targets.get(job.targetId));
    const claimed = await adapter.updateMany({
      model: JOB_MODEL,
      where: [{ field: "id", value: job.id }, { field: "lockedUntil", value: new Date(now), operator: "lt" }],
      update: { lockedUntil: new Date(lockedUntil) },
    });
    if (claimed === 0) return "busy";
    const current = (await adapter.findOne({ model: JOB_MODEL, where: [{ field: "id", value: job.id }] })) as Job | null;
    if (!current) return "done";
    const target = targets.get(current.targetId);
    if (!target) {
      // A target removed from the configuration: nothing to deliver to.
      await adapter.deleteMany({ model: JOB_MODEL, where: [{ field: "id", value: current.id }] });
      return "done";
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
    const isGroup = current.kind === "group";
    try {
      recheckAt = isGroup ? await deliverGroup(target, current.userId) : await deliver(target, current.userId);
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
        `[scim] ${target.id}: ${isGroup ? "group" : "user"} ${current.userId}: ${err.message}${giveUp ? " (failed; retried on the user's next change or a reconcile)" : ` (attempt ${attempts}; retry in ${Math.round(wait / 1000)} s)`}`,
      );
      const recorded = await adapter.updateMany({
        model: JOB_MODEL,
        where: [{ field: "id", value: current.id }, { field: "version", value: current.version }],
        update: { attempts, lastError: err.message.slice(0, 1000), lastStatus: err.status, lockedUntil: RELEASED, failed: giveUp, nextAttemptAt: new Date(Date.now() + wait), updatedAt: new Date() },
      });
      // Bumped during delivery (a new change, already due now): free it and try the new state.
      if (recorded === 0) await release(current.id);
      // Only new work goes round again: the bumped job, or a duplicate; never the one that just
      // failed unchanged, which waits for its backoff.
      const again = await nextFor(current.key, round, recorded === 0 ? undefined : current.id);
      if (again) return again;
      return giveUp ? "failed" : "retry";
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
    if (!isGroup && target.groups) await syncGroupsOf(target, current.userId);
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
      where: [{ field: "failed", value: false }, { field: "nextAttemptAt", value: new Date(Date.now() + 1), operator: "lt" }],
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


  // Groups: an organization is a group at a target with `groups: true`, its members the
  // organization's members who are provisioned and active there. A group is recomputed from the
  // database on each delivery, so it converges whatever order changes arrive in.

  /** Could this organization have a group at this target? (`groups` set, and in scope.) */
  const groupWanted = (target: ScimTarget, organizationId: string) => !!target.groups && (!target.organizationId || target.organizationId === organizationId);
  /** Is the organization's group wanted: in scope, and through the `groups` filter if there is one. */
  const groupIncluded = async (target: ScimTarget, org: { id: string; name: string; slug: string | null }) =>
    groupWanted(target, org.id) && (typeof target.groups === "function" ? (await target.groups(org)) === true : target.groups === true);

  /** The organization's members' ids at the app: provisioned, active, in id order. */
  async function groupMembers(target: ScimTarget, organizationId: string): Promise<{ value: string }[]> {
    const values: string[] = [];
    let after: string | null = null;
    for (;;) {
      const where: Where[] = [{ field: "organizationId", value: organizationId }];
      if (after !== null) where.push({ field: "userId", value: after, operator: "gt" });
      const members = (await adapter.findMany({ model: "member", where, limit: PAGE, sortBy: { field: "userId", direction: "asc" } })) as { userId: string; organizationId: string }[];
      const ids = members.filter((m) => m.organizationId === organizationId).map((m) => m.userId);
      for (let i = 0; i < ids.length; i += IN_BATCH) {
        const batch = ids.slice(i, i + IN_BATCH);
        const links = (await adapter.findMany({ model: LINK_MODEL, where: [{ field: "targetId", value: target.id }, { field: "userId", value: batch, operator: "in" }], limit: batch.length })) as Link[];
        for (const l of links) if (l.targetId === target.id && batch.includes(l.userId) && l.active && l.remoteId) values.push(l.remoteId);
      }
      if (members.length < PAGE) break;
      after = (members[members.length - 1] as { userId: string }).userId;
    }
    return [...new Set(values)].sort().map((value) => ({ value }));
  }

  async function findGroupLink(key: string): Promise<GroupLink | null> {
    const link = (await adapter.findOne({ model: GROUP_LINK_MODEL, where: [{ field: "key", value: key }] })) as GroupLink | null;
    return link && link.key === key ? link : null;
  }

  async function saveGroupLink(target: ScimTarget, organizationId: string, fields: { remoteId: string; displayName: string }) {
    const key = groupKeyOf(target.id, organizationId);
    const update = { ...fields, syncedAt: new Date() };
    if ((await adapter.updateMany({ model: GROUP_LINK_MODEL, where: [{ field: "key", value: key }], update })) > 0) return;
    await adapter.create({ model: GROUP_LINK_MODEL, data: { key, targetId: target.id, organizationId, ...update } });
  }

  /** Make the app's group match the organization: create, update, adopt, or remove. */
  async function deliverGroup(target: ScimTarget, organizationId: string): Promise<null> {
    const client = scimClient({ url: target.url, token: target.token, auth: target.auth, timeoutMs: target.timeoutMs, fetch: target.fetch });
    const key = groupKeyOf(target.id, organizationId);
    const link = await findGroupLink(key);
    const org = (await adapter.findOne({ model: "organization", where: [{ field: "id", value: organizationId }] })) as { id: string; name: string; slug?: string } | null;

    if (!org || org.id !== organizationId || !(await groupIncluded(target, { id: org.id, name: org.name, slug: org.slug ?? null }))) {
      if (!link) return null;
      if (link.remoteId) {
        try {
          await client.removeGroup(link.remoteId);
        } catch (e) {
          if (!notFound(e)) throw e;
          // Gone, or a wrong URL: the list tells (and throws if the app can't be asked).
          const found = await client.findGroupByName(link.displayName);
          if (found && found.externalId === organizationId) await client.removeGroup(found.id);
        }
      }
      await adapter.deleteMany({ model: GROUP_LINK_MODEL, where: [{ field: "key", value: key }] });
      return null;
    }

    const displayName = target.groupName ? target.groupName({ id: org.id, name: org.name, slug: org.slug ?? null }) : org.name;
    const group = { schemas: [SCIM_GROUP_SCHEMA], externalId: organizationId, displayName, members: await groupMembers(target, organizationId) };
    if (link?.remoteId) {
      try {
        await client.replaceGroup(link.remoteId, group);
        await saveGroupLink(target, organizationId, { remoteId: link.remoteId, displayName });
        return null;
      } catch (e) {
        if (!notFound(e)) throw e;
        // Removed at the app since, or a wrong URL: asking the list tells which.
        const found = await client.findGroupByName(link.displayName);
        if (found && found.externalId === organizationId) {
          await client.replaceGroup(found.id, group);
          await saveGroupLink(target, organizationId, { remoteId: found.id, displayName });
          return null;
        }
      }
    }
    const pendingBefore = link !== null && !link.remoteId;
    const otherOwner = async (remoteId: string) =>
      ((await adapter.findMany({ model: GROUP_LINK_MODEL, where: [{ field: "targetId", value: target.id }, { field: "remoteId", value: remoteId }], limit: 2 })) as GroupLink[]).some((l) => l.remoteId === remoteId && l.organizationId !== organizationId);
    const refuse = async (): Promise<never> => {
      await adapter.deleteMany({ model: GROUP_LINK_MODEL, where: [{ field: "key", value: key }] });
      throw new ScimError(`group ${displayName}: a group with this name already exists at the app and isn't this organization's; rename one of them, or set groupName`, 409, false);
    };
    if (!pendingBefore) {
      // Look before creating: a group of this name that isn't ours is refused here, before any
      // pending link exists, so a pending link always means "our own create may have made it"
      //.
      const existing = await client.findGroupByName(displayName);
      if (existing) {
        if (existing.externalId !== organizationId || (await otherOwner(existing.id))) return refuse();
        await client.replaceGroup(existing.id, group);
        await saveGroupLink(target, organizationId, { remoteId: existing.id, displayName });
        return null;
      }
    }
    // Pending first, as for users: a create whose reply is lost is ours to adopt later.
    await saveGroupLink(target, organizationId, { remoteId: "", displayName });
    let remoteId: string;
    try {
      remoteId = await client.createGroup(group);
    } catch (e) {
      if (!(e instanceof ScimError && e.status === 409)) throw e;
      // A group with this name exists. Ours (our externalId, or no externalId after our own create
      // whose reply was lost) is updated; anyone else's is never taken over: replacing it would
      // rewrite its members.
      const found = await client.findGroupByName(displayName);
      const ours = found !== null && !(await otherOwner(found.id)) && (found.externalId === organizationId || (found.externalId === null && pendingBefore));
      if (!found || !ours) return refuse();
      await client.replaceGroup(found.id, group);
      remoteId = found.id;
    }
    await saveGroupLink(target, organizationId, { remoteId, displayName });
    return null;
  }

  /** The organizations whose groups at this target include (or may include) this user. */
  async function groupsOf(target: ScimTarget, userId: string): Promise<string[]> {
    if (!target.groups) return [];
    const memberships = (await adapter.findMany({ model: "member", where: [{ field: "userId", value: userId }], limit: 1000 })) as { userId: string; organizationId: string }[];
    return [...new Set(memberships.filter((m) => m.userId === userId && groupWanted(target, m.organizationId)).map((m) => m.organizationId))];
  }

  /**
   * After a user's delivery: queue their organizations' groups. Only queued, so a reconcile of a
   * whole organization updates its group a few times, not once per member; the host delivers it
   * at once for a single change (see index.ts). Never fails the user's job.
   */
  async function syncGroupsOf(target: ScimTarget, userId: string): Promise<void> {
    try {
      for (const org of await groupsOf(target, userId)) await enqueue(target.id, org, { kind: "group" });
    } catch (e) {
      log.error(`[scim] ${target.id}: user ${userId}: could not update their groups: ${(e as Error).message}`);
    }
  }

  /** Organizations with a group linked at a target (for reconcile: groups of deleted organizations). */
  async function linkedGroups(targetId: string): Promise<string[]> {
    const links = (await adapter.findMany({ model: GROUP_LINK_MODEL, where: [{ field: "targetId", value: targetId }], limit: 10_000 })) as GroupLink[];
    return links.filter((l) => l.targetId === targetId).map((l) => l.organizationId);
  }

  return { enqueue, run, runDue, runFor, linkedUsers, allLinkedUsers, linkedGroups, groupsOf, targets };
}
