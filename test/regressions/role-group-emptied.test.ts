// With roleGroups: true, a role no one holds any more kept its group at the app, empty, though
// the README says it's removed.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("roleGroups true: a role group is removed once no one holds the role", async () => {
  const h = await createHost({ targets: [{ id: "app", roleGroups: true }] });
  const s = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(s.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  const headers = { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers });
  const ada = await h.user("Ada Lovelace");
  const m = await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "admin" } });
  await h.settle();
  expect([...h.app.groups.values()].map((g) => g.displayName)).toContain("Acme / admin");
  await h.auth.api.updateMemberRole({ body: { memberId: m!.id, role: "member", organizationId: org!.id }, headers });
  await h.settle();
  expect([...h.app.groups.values()].map((g) => g.displayName)).not.toContain("Acme / admin");
});
