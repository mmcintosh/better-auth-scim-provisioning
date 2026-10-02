// Organizations as SCIM groups (`groups: true`): created, kept in sync as members join and leave
// or are deprovisioned, renamed, removed with the organization, and never taking over a group
// that isn't the organization's.
import { describe, expect, it } from "vitest";
import { createHost } from "./support/host";

type Host = Awaited<ReturnType<typeof createHost>>;

/** A verified owner with a session, so organization endpoints can be called as an app would. */
async function owner(h: Host) {
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  const headers = { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  return { id: signUp.user.id, headers };
}

const groupsAt = (h: Host) => [...h.app.groups.values()].map((g) => ({ displayName: g.displayName, externalId: g.externalId, members: g.members.map((m) => m.value).sort() }));
const idAt = (h: Host, email: string) => [...h.app.users.values()].find((u) => u.userName === email)?.id;

describe("groups", () => {
  it("an organization becomes a group with its provisioned members, and follows joins and leaves", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.settle();
    expect(groupsAt(h)).toEqual([{ displayName: "Acme", externalId: org!.id, members: [idAt(h, "owner@example.com")] }]);

    const ada = await h.user("Ada Lovelace");
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "member" } });
    await h.settle();
    expect(groupsAt(h)[0]!.members).toEqual([idAt(h, "owner@example.com"), idAt(h, ada.email)].sort());

    await h.auth.api.removeMember({ body: { memberIdOrEmail: ada.email, organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(groupsAt(h)[0]!.members).toEqual([idAt(h, "owner@example.com")]);
  });

  it("a deprovisioned member leaves the group; reprovisioned, they're back", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    const ada = await h.user("Ada Lovelace");
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "member" } });
    await h.settle();
    await h.ctx.internalAdapter.updateUser(ada.id, { banned: true });
    await h.settle();
    expect(groupsAt(h)[0]!.members).not.toContain(idAt(h, ada.email));
    await h.ctx.internalAdapter.updateUser(ada.id, { banned: false });
    await h.settle();
    expect(groupsAt(h)[0]!.members).toContain(idAt(h, ada.email));
  });

  it("a renamed organization renames its group; a deleted one removes it", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.settle();
    await h.auth.api.updateOrganization({ body: { organizationId: org!.id, data: { name: "Acme Corp" } }, headers: o.headers });
    await h.settle();
    expect(groupsAt(h).map((g) => g.displayName)).toEqual(["Acme Corp"]);
    await h.auth.api.deleteOrganization({ body: { organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(groupsAt(h)).toEqual([]);
    expect(await h.ctx.adapter.findMany({ model: "scimProvisioningGroupLink" })).toEqual([]);
  });

  it("groupName names the group; organizationId limits groups to that organization", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true, groupName: (org) => `team-${org.slug}` }] });
    const o = await owner(h);
    await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.settle();
    expect(groupsAt(h).map((g) => g.displayName)).toEqual(["team-acme"]);

    const h2 = await createHost({ targets: [{ id: "app", groups: true, organizationId: "org-b" }] });
    const o2 = await owner(h2);
    await h2.auth.api.createOrganization({ body: { name: "Not This One", slug: "a" }, headers: o2.headers });
    await h2.settle();
    expect(groupsAt(h2)).toEqual([]);
  });

  it("never takes over a group of the same name that isn't the organization's", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true }] });
    await h.app.fetch(`${h.app.url}/Groups`, { method: "POST", headers: { authorization: `Bearer ${h.app.token}` }, body: JSON.stringify({ displayName: "Acme", members: [] }) });
    const o = await owner(h);
    await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.settle();
    expect(groupsAt(h)).toEqual([{ displayName: "Acme", externalId: undefined, members: [] }]);
    expect((await h.jobs()).find((j) => j.kind === "group")).toMatchObject({ failed: true, lastError: expect.stringContaining("isn't this organization's") });
  });

  it("a group create whose reply was lost is adopted on the retry, not duplicated", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true, keepsExternalId: false }], retry: { baseDelayMs: 0 } });
    const o = await owner(h);
    h.app.fail({ lostReply: true });
    await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.settle();
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect(groupsAt(h)).toHaveLength(1);
    // Adopted, not refused: linked, nothing failed, and a later change reaches it.
    const group = [...h.app.groups.values()][0]!;
    expect(await h.ctx.adapter.findMany({ model: "scimProvisioningGroupLink" })).toEqual([expect.objectContaining({ remoteId: group.id })]);
    expect((await h.jobs()).filter((j) => j.failed)).toEqual([]);
    const ada = await h.user("Ada Lovelace");
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: (await h.ctx.adapter.findOne<{ id: string }>({ model: "organization", where: [] }))!.id, role: "member" } });
    await h.settle();
    expect(groupsAt(h)[0]!.members).toContain(idAt(h, ada.email));
  });

  it("reconcile restores a group removed at the app, and a whole organization converges", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true }], concurrency: 4 });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.settle();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const u = await h.ctx.internalAdapter.createUser({ email: `m${i}@example.com`, name: `Member Number${i}`, emailVerified: true }, { method: "admin" });
      await h.ctx.adapter.create({ model: "member", data: { organizationId: org!.id, userId: u.id, role: "member", createdAt: new Date() } });
      ids.push(u.id);
    }
    await h.settle();
    h.app.groups.clear();
    await h.auth.api.scimProvisioningReconcile({ body: {} });
    for (let i = 0; i < 5 && (await h.jobs()).length; i++) await h.auth.api.scimProvisioningRun({ body: {} });
    await h.settle();
    expect(groupsAt(h)).toHaveLength(1);
    expect(groupsAt(h)[0]!.members).toHaveLength(13);
  });

  it("a wrong URL: the group's delivery retries instead of losing it", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.settle();
    const { outbox } = await import("../src/outbox");
    const wrong = outbox({ targets: [{ id: "app", url: `${h.app.url}/wrong`, token: h.app.token, fetch: h.app.fetch, groups: true }] }, h.ctx.adapter as never, { warn() {}, error() {} });
    await h.ctx.adapter.delete({ model: "organization", where: [{ field: "id", value: org!.id }] });
    await wrong.enqueue("app", org!.id, { kind: "group" });
    expect(await wrong.runFor("app", org!.id, "group")).toBe("retry");
    expect(groupsAt(h)).toHaveLength(1);
    expect(await h.ctx.adapter.findMany({ model: "scimProvisioningGroupLink" })).toHaveLength(1);
  });
});
