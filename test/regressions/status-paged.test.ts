// With a registry, scimProvisioningStatus answers a page of targets (`limit`, `after`): every
// stored target in one call cost 6 queries each, past D1's 1,000 at about 170 organizations.
import { describe, expect, it, vi } from "vitest";
import { seal, TARGET_MODEL } from "../../src/registry";
import { createHost } from "../support/host";

const KEY = "test-secret-that-is-at-least-32-characters-long";

describe("status: many stored targets", () => {
  it("170 stored targets: a page per call, well under 1,000 database calls", async () => {
    const h = await createHost({ targets: [], registry: {} });
    for (let i = 0; i < 170; i++) {
      const org = await h.ctx.adapter.create<Record<string, unknown>, { id: string }>({ model: "organization", data: { name: `O${i}`, slug: `o${i}`, createdAt: new Date() } });
      const targetId = `t-${String(i).padStart(4, "0")}`;
      await h.ctx.adapter.create({ model: TARGET_MODEL, data: { targetId, organizationId: org.id, type: "scim", config: JSON.stringify({ url: "https://app.example.com/scim/v2" }), sealed: await seal(KEY, targetId, org.id, { token: "x" }, { url: "https://app.example.com/scim/v2" }), enabled: true, createdAt: new Date(), updatedAt: new Date() } });
    }
    const a = h.ctx.adapter as unknown as Record<string, unknown>;
    const spies = ["create", "findOne", "findMany", "update", "updateMany", "deleteMany", "count"].map((m) => vi.spyOn(a, m as never));
    const first = await h.auth.api.scimProvisioningStatus({ body: {} });
    const calls = spies.reduce((n, s) => n + (s as unknown as { mock: { calls: unknown[] } }).mock.calls.length, 0);
    expect(calls).toBeLessThan(300);
    expect(first.targets).toHaveLength(25);
    // Every target, a page at a time.
    const seen = [...first.targets!.map((t) => t.id)];
    for (let next = first.next; next; ) {
      const page = await h.auth.api.scimProvisioningStatus({ body: { after: next } });
      seen.push(...page.targets!.map((t) => t.id));
      next = page.next;
    }
    expect(new Set(seen).size).toBe(170);
  });
});
