// A deleted user stayed in their groups at the app: their groups were found through their member
// rows, which SQL databases delete with the user before the delete hook runs, so no group was
// queued. The groups are now noted before the delete and updated after it.
import { describe, expect, it } from "vitest";
import { createHost } from "../support/host";

type Host = Awaited<ReturnType<typeof createHost>>;

async function owner(h: Host) {
  const s = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(s.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  return { cookie: res.headers.getSetCookie().map((c: string) => c.split(";")[0]).join("; ") };
}

async function orgWithAda(h: Host) {
  const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: await owner(h) });
  const ada = await h.user("Ada Lovelace");
  await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "member" } });
  await h.settle();
  return ada;
}

describe("a deleted user leaves their groups", () => {
  it("SCIM: the group loses the deleted member", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true }] });
    const ada = await orgWithAda(h);
    expect([...h.app.groups.values()][0]!.members).toHaveLength(2);
    await h.ctx.internalAdapter.deleteUser(ada.id);
    await h.settle();
    expect([...h.app.groups.values()][0]!.members).toHaveLength(1);
    expect(await h.jobs()).toEqual([]);
  });

  it("webhook: the next group.upsert no longer lists the deleted member", async () => {
    const h = await createHost({ targets: [{ id: "hook", type: "webhook", groups: true }] });
    const ada = await orgWithAda(h);
    expect([...h.webhook.groups.values()][0]!.members).toContain(ada.id);
    await h.ctx.internalAdapter.deleteUser(ada.id);
    await h.settle();
    expect([...h.webhook.groups.values()][0]!.members).not.toContain(ada.id);
  });
});
