// A reconcile page's `limit` bounds the work done per target too: each target costs at least one,
// and an organization's target's groups count. With the registry (a target per organization), one
// `limit: 10` call walked every target, past D1's 1,000 queries, and never returned a cursor.
import { describe, expect, it, vi } from "vitest";
import { seal, TARGET_MODEL } from "../../src/registry";
import { createHost } from "../support/host";

const KEY = "test-secret-that-is-at-least-32-characters-long";

describe("reconcile: limit with many targets", () => {
  it("limit: 10, 300 stored targets with groups: small calls, each returning a cursor, until done", async () => {
    const h = await createHost({ targets: [], registry: {} });
    for (let i = 0; i < 300; i++) {
      const org = await h.ctx.adapter.create<Record<string, unknown>, { id: string }>({ model: "organization", data: { name: `O${i}`, slug: `o${i}`, createdAt: new Date() } });
      const targetId = `t-${String(i).padStart(4, "0")}`;
      await h.ctx.adapter.create({ model: TARGET_MODEL, data: { targetId, organizationId: org.id, type: "scim", config: JSON.stringify({ url: "https://app.example.com/scim/v2", groups: true }), sealed: await seal(KEY, targetId, org.id, { token: "x" }, { url: "https://app.example.com/scim/v2", groups: true }), enabled: false, createdAt: new Date(), updatedAt: new Date() } });
    }
    const a = h.ctx.adapter as unknown as Record<string, unknown>;
    const spies = ["create", "findOne", "findMany", "update", "updateMany", "deleteMany", "count"].map((m) => vi.spyOn(a, m as never));
    const calls = () => spies.reduce((n, s) => n + (s as unknown as { mock: { calls: unknown[] } }).mock.calls.length, 0);
    let queued = 0;
    let rounds = 0;
    for (let next: string | null | undefined; ; ) {
      const before = calls();
      const r = await h.auth.api.scimProvisioningReconcile({ body: { limit: 10, ...(next ? { after: next } : {}) } });
      // Each call's own work is bounded by `limit`, whatever the number of targets (the target list itself aside).
      expect(calls() - before).toBeLessThan(200);
      queued += r.queued;
      rounds++;
      if (!r.next) break;
      next = r.next;
    }
    expect(rounds).toBeGreaterThan(10);
    // Every organization's group, at its target.
    expect(queued).toBe(300);
    // From the groups phase on: each organization's groups count too.
    const fromGroups = await h.auth.api.scimProvisioningReconcile({ body: { limit: 10, after: "g:t-0000:" } });
    expect(fromGroups.queued).toBeLessThanOrEqual(10);
    expect(fromGroups.next).toMatch(/^g:t-00\d\d:$/);
  });

  it("an organization's groups count against the limit: a call stops after the target whose groups used it up", async () => {
    const h = await createHost({ targets: [], registry: {} });
    for (let i = 0; i < 5; i++) {
      const org = await h.ctx.adapter.create<Record<string, unknown>, { id: string }>({ model: "organization", data: { name: `O${i}`, slug: `o${i}`, createdAt: new Date() } });
      if (i === 0) for (let t = 0; t < 30; t++) await h.ctx.adapter.create({ model: "team", data: { name: `T${t}`, organizationId: org.id, createdAt: new Date() } });
      const targetId = `t-${String(i).padStart(4, "0")}`;
      const settings = { url: "https://app.example.com/scim/v2", groups: true, teamGroups: true };
      await h.ctx.adapter.create({ model: TARGET_MODEL, data: { targetId, organizationId: org.id, type: "scim", config: JSON.stringify(settings), sealed: await seal(KEY, targetId, org.id, { token: "x" }, settings), enabled: false, createdAt: new Date(), updatedAt: new Date() } });
    }
    const r = await h.auth.api.scimProvisioningReconcile({ body: { limit: 10, after: "g:t-0000:" } });
    // The first organization's 31 groups (itself and 30 teams), then stopped: not the other four's too.
    expect(r.queued).toBe(31);
    expect(r.next).toBe("G:t-0000:");
  });
});
