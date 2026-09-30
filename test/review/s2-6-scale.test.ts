// Review S2 F-6 (Medium) and F-10 (Low): deleting an organization did its deprovisioning inside
// the admin's request, one delivery per member at once, and a database error there failed the
// request after the organization was already gone. Reconcile ran over every user in one call, and
// "every linked user" silently stopped at 10,000.
import { describe, expect, it } from "vitest";
import { createHost } from "../support/host";

const ORG = "org-acme";

async function orgWithMembers(n: number) {
  const h = await createHost({ targets: [{ id: "org-app", organizationId: ORG }] });
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Owner Person" }, asResponse: true });
  const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const owner = (await h.ctx.internalAdapter.findUserByEmail("owner@example.com"))!.user;
  await h.ctx.adapter.create({ model: "organization", data: { id: ORG, name: "Acme", slug: "acme", createdAt: new Date() }, forceAllowId: true });
  await h.ctx.adapter.create({ model: "member", data: { organizationId: ORG, userId: owner.id, role: "owner", createdAt: new Date() } });
  for (let i = 0; i < n; i++) {
    const m = await h.user(`Member Number${i}`);
    await h.auth.api.addMember({ body: { userId: m.id, organizationId: ORG, role: "member" } });
  }
  await h.settle();
  return { h, cookie };
}

describe("S2-6: organization delete and reconcile scale", () => {
  it("deleting an organization deprovisions its members one at a time, not all at once", async () => {
    const { h, cookie } = await orgWithMembers(3);
    const release = h.app.hold();
    const before = h.app.requests.length;
    await h.auth.api.deleteOrganization({ body: { organizationId: ORG }, headers: { cookie } });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.app.requests.length - before).toBe(1); // one request in flight while the app holds it
    release();
    await h.settle();
    expect([...h.app.users.values()].map((u) => u.active)).toEqual([false, false, false]);
  });

  it("a database error while deprovisioning doesn't fail the organization delete (F-10)", async () => {
    const { h, cookie } = await orgWithMembers(1);
    h.db.exec('DROP TABLE "scimProvisioningLink"');
    await expect(h.auth.api.deleteOrganization({ body: { organizationId: ORG }, headers: { cookie } })).resolves.toBeTruthy();
    await h.settle();
  });

  it("reconcile goes past 10,000 links", async () => {
    const h = await createHost();
    const insert = h.db.prepare('INSERT INTO "scimProvisioningLink" ("id", "key", "targetId", "userId", "remoteId", "userName", "active", "syncedAt") VALUES (?, ?, ?, ?, ?, ?, 0, ?)');
    h.db.exec("BEGIN");
    for (let i = 0; i < 10_001; i++) {
      const userId = `gone-${String(i).padStart(5, "0")}`;
      insert.run(`link-${i}`, `app:${userId}`, "app", userId, `r${i}`, `${userId}@example.com`, Date.now());
    }
    h.db.exec("COMMIT");
    const r = await h.auth.api.scimProvisioningReconcile({ body: {} });
    expect(r).toEqual({ queued: 10_001, next: null });
  });

  it("reconcile in pages: each call takes up to `limit` and says where to go on", async () => {
    const h = await createHost();
    const kept = [await h.user("One Person"), await h.user("Two Person"), await h.user("Three Person")];
    const gone = await h.user("Gone Person");
    await h.ctx.adapter.delete({ model: "user", where: [{ field: "id", value: gone.id }] });
    await h.ctx.adapter.deleteMany({ model: "scimProvisioningJob", where: [] });
    let queued = 0;
    let next: string | null | undefined;
    let calls = 0;
    do {
      const r = await h.auth.api.scimProvisioningReconcile({ body: { limit: 2, ...(next ? { after: next } : {}) } });
      queued += r.queued;
      next = r.next;
      calls++;
    } while (next);
    expect(queued).toBe(4);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect((await h.jobs()).map((j) => j.userId).sort()).toEqual([...kept.map((u) => u.id), gone.id].sort());
  });

  it("reconcile refuses an unknown target", async () => {
    const h = await createHost();
    await expect(h.auth.api.scimProvisioningReconcile({ body: { targetId: "nope" } })).rejects.toThrow(/unknown target/);
  });
});
