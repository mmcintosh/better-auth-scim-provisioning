// Review S1-2 (Medium): the membership hook took any result holding a member row as a change, so
// reads like getActiveMember (called on page loads) sent a SCIM request each time.
import { describe, expect, it } from "vitest";
import { createHost } from "../support/host";

describe("S1-2: reading membership doesn't provision", () => {
  it("getActiveMember sends nothing to the app", async () => {
    const h = await createHost({ targets: [{ id: "org-app", organizationId: "org-acme" }] });
    const res = await h.auth.api.signUpEmail({ body: { email: "m@example.com", password: "correct-horse-battery", name: "Member Person" }, asResponse: true });
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const me = (await h.ctx.internalAdapter.findUserByEmail("m@example.com"))!.user;
    await h.ctx.internalAdapter.updateUser(me.id, { emailVerified: true });
    await h.ctx.adapter.create({ model: "organization", data: { id: "org-acme", name: "Acme", slug: "acme", createdAt: new Date() }, forceAllowId: true });
    await h.auth.api.addMember({ body: { userId: me.id, organizationId: "org-acme", role: "member" } });
    await h.settle();
    expect(h.app.users.size).toBe(1);
    await h.auth.api.setActiveOrganization({ body: { organizationId: "org-acme" }, headers: { cookie } });
    await h.settle();
    const before = h.app.requests.length;
    for (let i = 0; i < 3; i++) await h.auth.api.getActiveMember({ headers: { cookie } });
    await h.settle();
    expect(h.app.requests.length).toBe(before);
  });
});
