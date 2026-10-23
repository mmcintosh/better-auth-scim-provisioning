// The audit history (the `audit` option): who connected, changed, removed or decommissioned which
// target, and when, kept in the database and listed newest first. Written after the change it
// records, never in its way: a write that fails is logged (the change's own warn line stays).
import { type Adapter, IN_BATCH } from "./outbox";
import type { AuditAction, AuditEvent, AuditOptions } from "./types";

/** The audit history, one row per event (only with the `audit` option). */
export const AUDIT_MODEL = "scimProvisioningAuditEvent";
/** Events a list returns at most. */
export const AUDIT_PAGE_MAX = 500;
/** How long the host's onEvent gets. */
const ON_EVENT_TIMEOUT_MS = 5_000;
/** How often old events are removed (with `keepDays`), at most: by the scheduled run. */
const PRUNE_EVERY_MS = 3_600_000;
/** Events removed per batch, and batches per prune: the rest go an hour later. */
const PRUNE_BATCH = 500;
const PRUNE_BATCHES = 10;
/** The most of an event's detail kept: a list past this many items keeps the first ones and says how many more. */
const DETAIL_ITEMS = 20;
const DETAIL_MAX = 4000;

/** An event's detail, short enough to keep whole: long lists cut to their first items (with `<key>More`: how many more). */
function bounded(detail: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(detail).length <= DETAIL_MAX) return detail;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (Array.isArray(v) && v.length > DETAIL_ITEMS) {
      out[k] = v.slice(0, DETAIL_ITEMS);
      out[`${k}More`] = v.length - DETAIL_ITEMS;
    } else out[k] = typeof v === "string" && v.length > 256 ? `${v.slice(0, 256)}…` : v;
  }
  return JSON.stringify(out).length <= DETAIL_MAX ? out : { truncated: true };
}

interface Row {
  key: string;
  createdAt: Date | string;
  targetId: string;
  organizationId?: string | null;
  actor: string;
  action: string;
  detail?: string | null;
}

/**
 * A sortable, unique key: the time, then randomness. Every key has the same shape, so they compare
 * the same way under any collation (they differ first at a digit or a lowercase hex letter).
 */
const keyAt = (at: Date) => `${at.toISOString()}~${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
const KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z~[0-9a-f]{16}$/;

export type AuditInput = Omit<AuditEvent, "at">;

export function auditLog(options: boolean | AuditOptions | undefined, adapter: Adapter, log: { error: (m: string) => void }) {
  const on = options === true || (typeof options === "object" && options !== null);
  const o: AuditOptions = typeof options === "object" && options !== null ? options : {};
  let prunedAt = 0;

  /** Records an event (a no-op without the option); never throws. */
  async function record(e: AuditInput): Promise<void> {
    if (!on) return;
    const at = new Date();
    const event: AuditEvent = { at: at.toISOString(), ...e };
    try {
      await adapter.create({
        model: AUDIT_MODEL,
        data: { key: keyAt(at), createdAt: at, targetId: e.targetId, organizationId: e.organizationId, actor: e.actor, action: e.action, detail: JSON.stringify(bounded(e.detail)) },
      });
    } catch (err) {
      log.error(`[scim] audit: couldn't record ${e.action} of target ${e.targetId}: ${(err as Error).message}`);
    }
    if (o.onEvent) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([o.onEvent(event), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${ON_EVENT_TIMEOUT_MS / 1000} s`)), ON_EVENT_TIMEOUT_MS)))]);
      } catch (err) {
        log.error(`[scim] audit.onEvent threw: ${(err as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Events, newest first: of one organization's targets, or one target's (a removed target's
   * too), or all; `after` is the last page's `next`.
   */
  async function list(q: { targetId?: string | undefined; organizationId?: string | undefined; after?: string | undefined; limit?: number | undefined }) {
    const limit = Math.min(q.limit ?? 100, AUDIT_PAGE_MAX);
    if (q.after !== undefined && !KEY.test(q.after)) throw new Error("after: pass the `next` a previous page returned");
    const where: { field: string; value: unknown; operator?: "lt" }[] = [];
    if (q.targetId !== undefined) where.push({ field: "targetId", value: q.targetId });
    if (q.organizationId !== undefined) where.push({ field: "organizationId", value: q.organizationId });
    if (q.after !== undefined) where.push({ field: "key", value: q.after, operator: "lt" });
    const rows = (await adapter.findMany({ model: AUDIT_MODEL, where, limit: limit + 1, sortBy: { field: "key", direction: "desc" } })) as Row[];
    // Exact matches only: a case-insensitive collation mustn't widen a filter.
    const kept = rows.filter((r) => (q.targetId === undefined || r.targetId === q.targetId) && (q.organizationId === undefined || r.organizationId === q.organizationId));
    const page = kept.slice(0, limit);
    const items: AuditEvent[] = page.map((r) => ({
      at: new Date(r.createdAt).toISOString(),
      targetId: r.targetId,
      organizationId: r.organizationId ?? null,
      actor: r.actor,
      action: r.action as AuditAction,
      detail: parse(r.detail),
    }));
    return { items, next: rows.length > limit ? (page[page.length - 1]?.key ?? null) : null };
  }

  /** With `keepDays`: removes older events, at most once an hour (the scheduled run calls it). */
  async function prune(): Promise<void> {
    if (!on || !o.keepDays || Date.now() - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = Date.now();
    try {
      // In batches, so a large first prune doesn't become one long statement (D1's time limit, MySQL's locks).
      const before = new Date(Date.now() - o.keepDays * 86_400_000);
      for (let i = 0; i < PRUNE_BATCHES; i++) {
        const old = (await adapter.findMany({ model: AUDIT_MODEL, where: [{ field: "createdAt", value: before, operator: "lt" }], limit: PRUNE_BATCH })) as Row[];
        for (let j = 0; j < old.length; j += IN_BATCH) await adapter.deleteMany({ model: AUDIT_MODEL, where: [{ field: "key", value: old.slice(j, j + IN_BATCH).map((r) => r.key), operator: "in" }] });
        if (old.length < PRUNE_BATCH) break;
      }
    } catch (err) {
      log.error(`[scim] audit: couldn't remove old events: ${(err as Error).message}`);
    }
  }

  return { on, record, list, prune };
}

function parse(detail: string | null | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(detail ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
