// The outbox: one job per (target, user) saying "make the app match this user", and one link per
// (target, user) remembering the app's id for them. A job carries no user data; delivery reads the
// user as it is then, so several quick changes collapse into one request with the latest state.
//
// Concurrency: a job is claimed with a lease (a conditional update on lockedUntil), so two workers
// never deliver it at once. A change during delivery bumps its version; the finished delivery only
// deletes the job if the version is still the one it claimed, so that change is delivered too.
import { defaultScimUser, isBanned } from "./mapping";
import { ScimError, scimClient } from "./scim-client";
import type { ProvisionedUser, ScimProvisioningOptions, ScimTarget } from "./types";

export const JOB_MODEL = "scimProvisioningJob";
export const LINK_MODEL = "scimProvisioningLink";

type Where = { field: string; value: unknown; operator?: "eq" | "lt" | "in" };
export interface Adapter {
  create(a: { model: string; data: Record<string, unknown> }): Promise<unknown>;
  findOne(a: { model: string; where: Where[] }): Promise<unknown>;
  findMany(a: { model: string; where?: Where[]; limit?: number; sortBy?: { field: string; direction: "asc" | "desc" } }): Promise<unknown[]>;
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
}

export interface Link {
  id: string;
  key: string;
  targetId: string;
  userId: string;
  remoteId: string;
  userName: string;
  active: boolean;
}

const EPOCH = new Date(0);
const LEASE_MS = 60_000;
/** Re-deliveries in a row for a job that keeps changing; the scheduled run takes over after. */
const MAX_ROUNDS = 3;
const MAX_DELAY_MS = 6 * 3_600_000;
/** Target ids are [A-Za-z0-9_-], so ":" can't be ambiguous. */
export const keyOf = (targetId: string, userId: string) => `${targetId}:${userId}`;

export type Outcome = "done" | "retry" | "failed" | "busy";

export function outbox(options: ScimProvisioningOptions, adapter: Adapter, log: { warn(m: string): void; error(m: string): void }) {
  const targets = new Map(options.targets.map((t) => [t.id, t]));
  const maxAttempts = options.retry?.maxAttempts ?? 8;
  const baseDelayMs = options.retry?.baseDelayMs ?? 30_000;
  const backoff = (attempts: number) => Math.min(MAX_DELAY_MS, baseDelayMs * 2 ** Math.max(0, attempts - 1));

  /** Ask for (target, user) to be synced now; an existing job is bumped rather than duplicated. */
  async function enqueue(targetId: string, userId: string): Promise<void> {
    const key = keyOf(targetId, userId);
    const now = new Date();
    const fresh = { attempts: 0, nextAttemptAt: now, failed: false, lastError: null, updatedAt: now };
    try {
      await adapter.create({ model: JOB_MODEL, data: { key, targetId, userId, version: 1, lockedUntil: EPOCH, createdAt: now, ...fresh } });
      return;
    } catch (e) {
      const existing = (await adapter.findOne({ model: JOB_MODEL, where: [{ field: "key", value: key }] })) as Job | null;
      if (!existing || existing.key !== key) throw e;
      await adapter.updateMany({ model: JOB_MODEL, where: [{ field: "id", value: existing.id }], update: { ...fresh, version: existing.version + 1 } });
    }
  }

  async function findLink(key: string): Promise<Link | null> {
    const link = (await adapter.findOne({ model: LINK_MODEL, where: [{ field: "key", value: key }] })) as Link | null;
    return link && link.key === key ? link : null;
  }

  async function saveLink(target: ScimTarget, userId: string, fields: { remoteId: string; userName: string; active: boolean }) {
    const key = keyOf(target.id, userId);
    const update = { ...fields, syncedAt: new Date() };
    if ((await adapter.updateMany({ model: LINK_MODEL, where: [{ field: "key", value: key }], update })) > 0) return;
    await adapter.create({ model: LINK_MODEL, data: { key, targetId: target.id, userId, ...update } });
  }

  /** Should this user be at this target now? */
  async function wanted(target: ScimTarget, user: ProvisionedUser | null): Promise<boolean> {
    if (!user || user.emailVerified !== true || isBanned(user)) return false;
    if (target.organizationId) {
      const member = (await adapter.findOne({ model: "member", where: [{ field: "userId", value: user.id }, { field: "organizationId", value: target.organizationId }] })) as { userId?: unknown; organizationId?: unknown } | null;
      if (!member || member.userId !== user.id || member.organizationId !== target.organizationId) return false;
    }
    return target.include ? (await target.include(user)) === true : true;
  }

  /** Make the app match the user: create, update, adopt, reactivate or deprovision. */
  async function deliver(target: ScimTarget, userId: string): Promise<void> {
    const client = scimClient({ url: target.url, token: target.token, timeoutMs: target.timeoutMs, fetch: target.fetch });
    const user = (await adapter.findOne({ model: "user", where: [{ field: "id", value: userId }] })) as ProvisionedUser | null;
    let link = await findLink(keyOf(target.id, userId));

    if (await wanted(target, user)) {
      const scim = (target.mapUser ?? defaultScimUser)(user as ProvisionedUser);
      if (link) {
        try {
          await client.replace(link.remoteId, scim);
        } catch (e) {
          // Removed at the app since: create it again.
          if (!(e instanceof ScimError && e.status === 404)) throw e;
          link = null;
        }
      }
      let remoteId = link?.remoteId;
      if (!remoteId) {
        try {
          remoteId = await client.create(scim);
        } catch (e) {
          // Already there (provisioned by hand, or a link lost): adopt it.
          if (!(e instanceof ScimError && e.status === 409)) throw e;
          const found = await client.findByUserName(scim.userName);
          if (!found) throw new ScimError(`${scim.userName}: the app says it exists but can't find it`, 409, false);
          await client.replace(found, scim);
          remoteId = found;
        }
      }
      await saveLink(target, userId, { remoteId, userName: scim.userName, active: true });
      return;
    }

    if (!link || !link.active) return;
    if ((target.deprovision ?? "deactivate") === "delete") {
      await client.remove(link.remoteId);
      await adapter.deleteMany({ model: LINK_MODEL, where: [{ field: "key", value: link.key }] });
      return;
    }
    try {
      await client.setActive(link.remoteId, false);
    } catch (e) {
      if (!(e instanceof ScimError && e.status === 404)) throw e;
    }
    await saveLink(target, userId, { remoteId: link.remoteId, userName: link.userName, active: false });
  }

  /**
   * Deliver one job, if no one else holds it. A job bumped during delivery (the user changed
   * again) is delivered again straight away, up to a few rounds, so the latest state goes out.
   */
  async function run(job: Job, round = 0): Promise<Outcome> {
    const now = Date.now();
    const claimed = await adapter.updateMany({
      model: JOB_MODEL,
      where: [{ field: "id", value: job.id }, { field: "lockedUntil", value: new Date(now), operator: "lt" }],
      update: { lockedUntil: new Date(now + LEASE_MS) },
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
    try {
      await deliver(target, current.userId);
    } catch (e) {
      const attempts = current.attempts + 1;
      const err = e instanceof ScimError ? e : new ScimError((e as Error).message, null, true);
      const giveUp = !err.retryable || attempts >= maxAttempts;
      const wait = Math.max(err.retryAfterMs ?? 0, backoff(attempts));
      (giveUp ? log.error : log.warn)(`[scim] ${target.id}: user ${current.userId}: ${err.message}${giveUp ? " (failed; retried on the user's next change)" : ` (attempt ${attempts}; retry in ${Math.round(wait / 1000)} s)`}`);
      const recorded = await adapter.updateMany({
        model: JOB_MODEL,
        where: [{ field: "id", value: current.id }, { field: "version", value: current.version }],
        update: { attempts, lastError: err.message.slice(0, 1000), lockedUntil: EPOCH, failed: giveUp, nextAttemptAt: new Date(Date.now() + wait), updatedAt: new Date() },
      });
      // Bumped during delivery (a new change, already due now): free it and try the new state.
      if (recorded === 0) {
        await release(current.id);
        if (round < MAX_ROUNDS) return run(current, round + 1);
      }
      return giveUp ? "failed" : "retry";
    }
    const deleted = await adapter.deleteMany({ model: JOB_MODEL, where: [{ field: "id", value: current.id }, { field: "version", value: current.version }] });
    // Bumped during delivery: keep the job, free it, and deliver the new change now.
    if (deleted === 0) {
      await release(current.id);
      if (round < MAX_ROUNDS) return run(current, round + 1);
    }
    return "done";
  }

  const release = (id: string) => adapter.updateMany({ model: JOB_MODEL, where: [{ field: "id", value: id }], update: { lockedUntil: EPOCH } });

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
    const job = (await adapter.findOne({ model: JOB_MODEL, where: [{ field: "key", value: keyOf(targetId, userId) }] })) as Job | null;
    if (!job || job.failed || new Date(job.nextAttemptAt).getTime() > Date.now()) return null;
    return run(job);
  }

  /** The users linked at a target (active or not), for deprovisioning a whole organization. */
  async function linkedUsers(targetId: string): Promise<string[]> {
    const links = (await adapter.findMany({ model: LINK_MODEL, where: [{ field: "targetId", value: targetId }], limit: 10_000 })) as Link[];
    return links.filter((l) => l.targetId === targetId).map((l) => l.userId);
  }

  return { enqueue, run, runDue, runFor, linkedUsers, targets };
}
