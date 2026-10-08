// Creating or changing a stored target queues its organization as one job, expanded a page at a
// time by the deliveries: queued inside the request, an organization of a few hundred members ran
// past D1's 1,000 queries per Worker invocation (and the row was left behind). Everyone is still
// queued in the end.
import { describe, expect, it, vi } from "vitest";
import { createHost } from "../support/host";
import { mockScim } from "../support/mock-scim";

describe("registry: an organization queued a page at a time", () => {
  it("600 members: the create request stays small, and every member is delivered once the target is enabled", async () => {
    const remote = mockScim();
    const h = await createHost({ targets: [], registry: { fetch: remote.fetch } });
    const up = await h.auth.api.signUpEmail({ body: { email: "olive@example.com", password: "correct-horse-battery", name: "Olive" } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email: "olive@example.com", password: "correct-horse-battery" }, asResponse: true });
    const headers = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
    const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers }))!;
    // 600 members, written directly (no hooks).
    for (let i = 0; i < 600; i++) {
      const u = await h.ctx.adapter.create<Record<string, unknown>, { id: string }>({ model: "user", data: { email: `m${i}@example.com`, name: `M ${i}`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
      await h.ctx.adapter.create({ model: "member", data: { userId: u.id, organizationId: acme.id, role: "member", createdAt: new Date() } });
    }
    const a = h.ctx.adapter as unknown as Record<string, (...x: unknown[]) => unknown>;
    const spies = ["create", "findOne", "findMany", "update", "updateMany", "delete", "deleteMany", "count"].map((m) => vi.spyOn(a, m as never));
    // Only the request itself: background deliveries are not awaited here.
    await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: remote.token }, enabled: false }, headers });
    const calls = spies.reduce((n, s) => n + s.mock.calls.length, 0);
    // D1: 1,000 queries per Worker invocation (paid), 50 (free). The organization isn't walked here.
    expect(calls).toBeLessThan(50);
    for (const s of spies) s.mockRestore();
    // Enabled: everyone (600 members and the owner) is delivered by the scheduled runs, a page at a time.
    const [row] = await h.ctx.adapter.findMany<{ targetId: string }>({ model: "scimProvisioningTarget" });
    await h.auth.api.scimProvisioningUpdateTarget({ body: { id: row!.targetId, enabled: true }, headers });
    await h.settle();
    for (let i = 0; i < 100 && (await h.jobs()).length; i++) {
      await h.auth.api.scimProvisioningRun({ body: { limit: 100 } });
      await h.settle();
    }
    expect(await h.jobs()).toEqual([]);
    expect(remote.users.size).toBe(601);
  });
});
