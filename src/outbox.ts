// The outbox: one job per (target, user) saying "make the app match this user", and one link per
// (target, user) remembering the app's id for them. A job carries no user data; delivery reads the
// user as it is then, so several quick changes collapse into one request with the latest state.
//
// Concurrency: a job is claimed with a lease (a conditional update on lockedUntil), so two workers
// never deliver it at once. A change during delivery bumps its version; the finished delivery only
// deletes the job if the version is still the one it claimed, so that change is delivered too.
//
// A link is written before an account is created at the app (remoteId empty: "pending"), so an
// account whose create reply was lost can still be found, and undone, later (S2-2).
import { defaultScimUser, isBanned } from "./mapping";
import { ScimError, scimClient } from "./scim-client";
import type { ProvisionedUser, ScimProvisioningOptions, ScimTarget } from "./types";

export const JOB_MODEL = "scimProvisioningJob";
export const LINK_MODEL = "scimProvisioningLink";

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
 * claim a job still being delivered (S1-3).
 */
const leaseFor = (target: ScimTarget | undefined) => 4 * (target?.timeoutMs ?? 10_000) + 30_000;
/** Re-deliveries in a row for a job that keeps changing; the scheduled run takes over after. */
const MAX_ROUNDS = 3;
const MAX_DELAY_MS = 6 * 3_600_000;
/** Page size for walking links. */
const PAGE = 500;
/** Target ids are [A-Za-z0-9_-], so ":" can't be ambiguous. */
export const keyOf = (targetId: string, userId: string) => `${targetId}:${userId}`;

export type Outcome = "done" | "retry" | "failed" | "busy";

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
   * asked for (S2-9), unless `now` (reconcile, after fixing a target). A job deleted between the read and the bump (its delivery
   * just finished) is created again, so the change isn't lost (S2-1).
   */
  async function enqueue(targetId: string, userId: string, o: { now?: boolean } = {}): Promise<void> {
    const key = keyOf(targetId, userId);
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
        await adapter.create({ model: JOB_MODEL, data: { key, targetId, userId, version: 1, lockedUntil: RELEASED, createdAt: now, ...fresh } });
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

  /** The user another link at this target already ties the app's account to, if any (S2-3). */
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
   * look again without a change, if ever: the end of a timed ban (S2-7).
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
          await client.replace(link.remoteId, scim);
          await saveLink(target, userId, { remoteId: link.remoteId, userName: scim.userName, externalId, active: true });
          return null;
        } catch (e) {
          // Removed at the app since: create it again.
          if (!(e instanceof ScimError && e.status === 404)) throw e;
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
          // over (S1-1 by the app's externalId, S2-3 by our own links, for apps that don't keep it).
          if (found.externalId !== null) return refuse(`the app's account belongs to another user (externalId ${found.externalId})`);
          const owner = await ownerOf(target, found.id);
          if (owner && owner !== userId) return refuse("the app's account is linked to another user");
          // Nobody's: only for an address the user has shown they own (S2-5).
          if ((user as ProvisionedUser).emailVerified !== true) return refuse("an account with this userName exists at the app, and the user's email is not verified");
        }
        await client.replace(found.id, scim);
        remoteId = found.id;
      }
      await saveLink(target, userId, { remoteId, userName: scim.userName, externalId, active: true });
      return null;
    }

    // Leaving. A timed ban ends by itself: look again then (S2-7).
    const recheckAt = user && isBanned(user) && user.banExpires != null ? new Date(user.banExpires) : null;
    if (link && !link.remoteId) link = await settlePending(target, client, link);
    if (!link) return recheckAt;
    if ((target.deprovision ?? "deactivate") === "delete") {
      // Inactive links too: a target switched from deactivate to delete (S2-8).
      await client.remove(link.remoteId);
      await dropLink(key);
      return recheckAt;
    }
    if (link.active) {
      try {
        await client.setActive(link.remoteId, false);
      } catch (e) {
        if (!(e instanceof ScimError && e.status === 404)) throw e;
      }
      await saveLink(target, userId, { remoteId: link.remoteId, userName: link.userName, externalId: link.externalId ?? null, active: false });
    }
    return recheckAt;
  }

  /**
   * A pending create for a user who is now leaving: find out whether the account exists at the app,
   * and return it as a real link to deprovision, or drop the link (S2-2).
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
    // Duplicates (a database without the UNIQUE key): one delivery per user at a time (S2-11).
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
    try {
      recheckAt = await deliver(target, current.userId);
    } catch (e) {
      const attempts = current.attempts + 1;
      const err = e instanceof ScimError ? e : new ScimError((e as Error).message, null, true);
      // Only an error that won't fix itself fails the job. Anything else (an outage, an expired
      // token) keeps retrying, every 6 hours once past maxAttempts, so it recovers when the app
      // does (S2-4).
      const giveUp = !err.retryable;
      const wait = Math.max(err.retryAfterMs ?? 0, attempts >= maxAttempts ? MAX_DELAY_MS : backoff(attempts));
      const loud = giveUp || attempts === maxAttempts;
      (loud ? log.error : log.warn)(
        `[scim] ${target.id}: user ${current.userId}: ${err.message}${giveUp ? " (failed; retried on the user's next change or a reconcile)" : ` (attempt ${attempts}; retry in ${Math.round(wait / 1000)} s)`}`,
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
    return (await nextFor(current.key, round)) ?? "done";
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

  /** Deliver the jobs that are due, oldest first. */
  async function runDue(limit = 50): Promise<Record<Outcome, number>> {
    const due = (await adapter.findMany({
      model: JOB_MODEL,
      where: [{ field: "failed", value: false }, { field: "nextAttemptAt", value: new Date(Date.now() + 1), operator: "lt" }],
      sortBy: { field: "nextAttemptAt", direction: "asc" },
      limit,
    })) as Job[];
    const tally: Record<Outcome, number> = { done: 0, retry: 0, failed: 0, busy: 0 };
    for (const job of due) tally[await run(job)]++;
    return tally;
  }

  /** Deliver (target, user) now if due, e.g. right after enqueue. */
  async function runFor(targetId: string, userId: string): Promise<Outcome | null> {
    const jobs = await jobsFor(keyOf(targetId, userId));
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

  return { enqueue, run, runDue, runFor, linkedUsers, allLinkedUsers, targets };
}
