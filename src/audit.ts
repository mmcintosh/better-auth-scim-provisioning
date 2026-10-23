// The audit history (the `audit` option): who connected, changed, removed or decommissioned which
// target, and when, kept in the database and listed newest first. Written after the change it
// records, never in its way: a write that fails is logged (the change's own warn line stays).
import type { Adapter } from "./outbox";
import type { AuditAction, AuditEvent, AuditOptions } from "./types";

/** The audit history, one row per event (only with the `audit` option). */
export const AUDIT_MODEL = "scimProvisioningAuditEvent";
/** Events a list returns at most. */
export const AUDIT_PAGE_MAX = 500;
/** How long the host's onEvent gets. */
const ON_EVENT_TIMEOUT_MS = 5_000;
/** How often old events are removed (with `keepDays`), at most: by the scheduled run. */
const PRUNE_EVERY_MS = 3_600_000;

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
        data: { key: keyAt(at), createdAt: at, targetId: e.targetId, organizationId: e.organizationId, actor: e.actor, action: e.action, detail: JSON.stringify(e.detail).slice(0, 4000) },
      });
    } catch (err) {
      log.error(`[scim] audit: couldn't record ${e.action} of target ${e.targetId}: ${(err as Error).message}`);
    }
    if (o.onEvent) {
      try {
        await Promise.race([o.onEvent(event), new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ON_EVENT_TIMEOUT_MS / 1000} s`)), ON_EVENT_TIMEOUT_MS))]);
      } catch (err) {
        log.error(`[scim] audit.onEvent threw: ${(err as Error).message}`);
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
      await adapter.deleteMany({ model: AUDIT_MODEL, where: [{ field: "createdAt", value: new Date(Date.now() - o.keepDays * 86_400_000), operator: "lt" }] });
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
