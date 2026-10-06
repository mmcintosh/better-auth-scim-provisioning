// Found in review: deleting an organization queued its members for deprovisioning (at targets
// scoped to it) only in background work after the response. On Workers that work ends with
// waitUntil's budget, and members not queued by then stayed active at the app until a reconcile.
// They're now queued before the delete's response; the deliveries still run in the background.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("every member of a deleted organization is queued by the time the delete returns", async () => {
  const h = await createHost({ targets: [{ id: "app", organizationId: "org_1" }] });
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  const headers = { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  await h.ctx.adapter.create({ model: "organization", data: { id: "org_1", name: "Acme", slug: "acme", createdAt: new Date() }, forceAllowId: true });
  await h.ctx.adapter.create({ model: "member", data: { organizationId: "org_1", userId: signUp.user.id, role: "owner", createdAt: new Date() } });
  for (let i = 0; i < 40; i++) {
    const u = await h.user(`Person Number${i}`);
    await h.ctx.adapter.create({ model: "member", data: { organizationId: "org_1", userId: u.id, role: "member", createdAt: new Date() } });
  }
  await h.auth.api.scimProvisioningReconcile({ body: {} });
  await h.auth.api.scimProvisioningRun({ body: { limit: 500 } });
  await h.settle();
  expect([...h.app.users.values()].filter((u) => u.active)).toHaveLength(41);
  expect(await h.jobs()).toHaveLength(0);

  await h.auth.api.deleteOrganization({ body: { organizationId: "org_1" }, headers });
  // Before any background work: all 41 are queued (the work could be cut off from here on).
  expect(await h.jobs()).toHaveLength(41);
  await h.settle();
  expect([...h.app.users.values()].filter((u) => u.active)).toHaveLength(0);
});
