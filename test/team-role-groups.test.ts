// Teams and roles as groups (`teamGroups`, `roleGroups`): created, kept in sync as members join,
// leave or change roles, renamed, and removed with their team or organization.
import { describe, expect, it } from "vitest";
import { createHost } from "./support/host";

type Host = Awaited<ReturnType<typeof createHost>>;

async function owner(h: Host) {
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  return { id: signUp.user.id, headers: { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } };
}

const idAt = (h: Host, email: string) => [...h.app.users.values()].find((u) => u.userName === email)?.id;
const group = (h: Host, name: string) => {
  const g = [...h.app.groups.values()].find((x) => x.displayName === name);
  return g ? g.members.map((m) => m.value).sort() : undefined;
};
const names = (h: Host) => [...h.app.groups.values()].map((g) => g.displayName).sort();

describe("team groups", () => {
  it("a team is a group with its provisioned members; joins, leaves, rename and removal follow", async () => {
    const h = await createHost({ targets: [{ id: "app", teamGroups: true }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    const ada = await h.user("Ada Lovelace");
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "member" } });
    const team = await h.auth.api.createTeam({ body: { name: "Red", organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(group(h, "Acme / Red")).toEqual([]);

    await h.auth.api.addTeamMember({ body: { teamId: team.id, userId: ada.id }, headers: o.headers });
    await h.settle();
    expect(group(h, "Acme / Red")).toEqual([idAt(h, ada.email)]);

    await h.auth.api.updateTeam({ body: { teamId: team.id, data: { name: "Crimson" } }, headers: o.headers });
    await h.settle();
    expect(group(h, "Acme / Red")).toBeUndefined();
    expect(group(h, "Acme / Crimson")).toEqual([idAt(h, ada.email)]);

    await h.auth.api.removeTeamMember({ body: { teamId: team.id, userId: ada.id }, headers: o.headers });
    await h.settle();
    expect(group(h, "Acme / Crimson")).toEqual([]);

    await h.auth.api.removeTeam({ body: { teamId: team.id, organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(group(h, "Acme / Crimson")).toBeUndefined();
  });

  it("a deprovisioned team member leaves the team's group", async () => {
    const h = await createHost({ targets: [{ id: "app", teamGroups: true }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    const ada = await h.user("Ada Lovelace");
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "member" } });
    const team = await h.auth.api.createTeam({ body: { name: "Red", organizationId: org!.id }, headers: o.headers });
    await h.auth.api.addTeamMember({ body: { teamId: team.id, userId: ada.id }, headers: o.headers });
    await h.settle();
    await h.ctx.internalAdapter.updateUser(ada.id, { banned: true });
    await h.settle();
    expect(group(h, "Acme / Red")).toEqual([]);
  });

  it("teamGroupName names it; a filter chooses which teams", async () => {
    const h = await createHost({ targets: [{ id: "app", teamGroups: (team) => team.name.startsWith("eng-"), teamGroupName: (team, org) => `${org.slug}:${team.name}` }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.auth.api.createTeam({ body: { name: "eng-core", organizationId: org!.id }, headers: o.headers });
    await h.auth.api.createTeam({ body: { name: "sales", organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(names(h)).toEqual(["acme:eng-core"]);
  });
});

describe("role groups", () => {
  it("roleGroups: [\"admin\"]: the admins are a group, and a role change moves people in and out", async () => {
    const h = await createHost({ targets: [{ id: "app", roleGroups: ["admin"] }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    const ada = await h.user("Ada Lovelace");
    const member = await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "admin" } });
    await h.settle();
    expect(names(h)).toEqual(["Acme / admin"]);
    expect(group(h, "Acme / admin")).toEqual([idAt(h, ada.email)]);

    await h.auth.api.updateMemberRole({ body: { memberId: member!.id, role: "member", organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(group(h, "Acme / admin")).toEqual([]);
  });

  it("roleGroups: true: a group per role held, and several roles put a member in several groups", async () => {
    const h = await createHost({ targets: [{ id: "app", roleGroups: true }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    const ada = await h.user("Ada Lovelace");
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: ["admin", "member"] } });
    await h.settle();
    expect(names(h)).toEqual(["Acme / admin", "Acme / member", "Acme / owner"]);
    expect(group(h, "Acme / admin")).toEqual([idAt(h, ada.email)]);
    expect(group(h, "Acme / member")).toEqual([idAt(h, ada.email)]);
    expect(group(h, "Acme / owner")).toEqual([idAt(h, "owner@example.com")]);
  });

  it("roleGroupName names it", async () => {
    const h = await createHost({ targets: [{ id: "app", roleGroups: ["owner"], roleGroupName: (role, org) => `${org.slug}-${role}s` }] });
    const o = await owner(h);
    await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.settle();
    expect(names(h)).toEqual(["acme-owners"]);
  });
});

describe("all kinds together", () => {
  it("deleting the organization removes its own, its teams' and its roles' groups", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true, teamGroups: true, roleGroups: ["owner"] }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.auth.api.createTeam({ body: { name: "Red", organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(names(h)).toEqual(expect.arrayContaining(["Acme", "Acme / Red", "Acme / owner"]));
    await h.auth.api.deleteOrganization({ body: { organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(names(h)).toEqual([]);
    expect(await h.ctx.adapter.findMany({ model: "scimProvisioningGroupLink" })).toEqual([]);
  });

  it("reconcile restores every kind of group removed at the app", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true, teamGroups: true, roleGroups: true }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.auth.api.createTeam({ body: { name: "Red", organizationId: org!.id }, headers: o.headers });
    await h.settle();
    const before = names(h);
    h.app.groups.clear();
    await h.auth.api.scimProvisioningReconcile({ body: {} });
    for (let i = 0; i < 5 && (await h.jobs()).length; i++) await h.auth.api.scimProvisioningRun({ body: {} });
    expect(names(h)).toEqual(before);
    expect(before).toEqual(expect.arrayContaining(["Acme", "Acme / Red", "Acme / owner"]));
  });
});
