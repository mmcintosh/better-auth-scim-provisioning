// Google Workspace groups: organizations, teams and roles as Google Groups, each at an address
// derived from its externalId (stable across renames), marked ours in its description, with
// members added and removed one at a time and read back a page at a time.
import { describe, expect, it } from "vitest";
import { createHost } from "./support/host";

type Host = Awaited<ReturnType<typeof createHost>>;
const G = { id: "workspace", type: "google-workspace" as const };

async function owner(h: Host) {
  const s = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(s.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  return { id: s.user.id, headers: { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } };
}
const googleId = (h: Host, email: string) => [...h.google.users.values()].find((u) => u.primaryEmail === email)?.id;
const groupAt = (h: Host, email: string) => [...h.google.groups.values()].find((g) => g.email === email);

describe("Google Workspace groups", () => {
  it("an organization is a Google Group: its address from the organization's id, our marker, its members", async () => {
    const h = await createHost({ targets: [{ ...G, groups: true }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    const ada = await h.user("Ada Lovelace");
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "member" } });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    const g = groupAt(h, `ba-${org!.id.toLowerCase()}@example.com`);
    expect(g).toMatchObject({ name: "Acme", description: expect.stringContaining(`externalId: ${org!.id}`) });
    expect([...g!.members].sort()).toEqual([googleId(h, "owner@example.com"), googleId(h, ada.email)].sort());
  });

  it("teams and roles too; a rename keeps the address; leaving and removal follow", async () => {
    const h = await createHost({ targets: [{ ...G, groups: true, teamGroups: true, roleGroups: ["admin"] }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    const ada = await h.user("Ada Lovelace");
    const bob = await h.user("Bob Babbage");
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "member" } });
    await h.auth.api.addMember({ body: { userId: bob.id, organizationId: org!.id, role: "admin" } });
    const team = await h.auth.api.createTeam({ body: { name: "Red", organizationId: org!.id }, headers: o.headers });
    await h.auth.api.addTeamMember({ body: { teamId: team.id, userId: ada.id }, headers: o.headers });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    const orgGroup = groupAt(h, `ba-${org!.id.toLowerCase()}@example.com`)!;
    const teamGroup = groupAt(h, `ba-team-${team.id.toLowerCase()}@example.com`)!;
    const adminGroup = groupAt(h, `ba-role-${org!.id.toLowerCase()}-admin@example.com`)!;
    expect(teamGroup).toMatchObject({ name: "Acme / Red" });
    expect([...teamGroup.members]).toEqual([googleId(h, ada.email)]);
    expect([...adminGroup.members]).toEqual([googleId(h, bob.email)]);

    await h.auth.api.updateOrganization({ body: { organizationId: org!.id, data: { name: "Acme Corp" } }, headers: o.headers });
    await h.settle();
    expect(groupAt(h, orgGroup.email)).toMatchObject({ id: orgGroup.id, name: "Acme Corp" });
    expect(groupAt(h, teamGroup.email)).toMatchObject({ id: teamGroup.id, name: "Acme Corp / Red" });

    await h.auth.api.removeMember({ body: { memberIdOrEmail: ada.email, organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect([...orgGroup.members].sort()).toEqual([googleId(h, "owner@example.com"), googleId(h, bob.email)].sort());
    expect([...teamGroup.members]).toEqual([]);

    await h.auth.api.deleteOrganization({ body: { organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    expect(h.google.groups.size).toBe(0);
  });

  it("a group at our address that isn't ours (no marker) is refused and left alone", async () => {
    const h = await createHost({ targets: [{ ...G, groups: true }] });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.settle();
    // Remove ours, then put a hand-made group at the same address.
    const ours = [...h.google.groups.values()][0]!;
    h.google.groups.clear();
    h.google.groups.set("hand", { id: "hand", email: ours.email, name: "Someone's", members: new Set(["x"]) });
    h.db.prepare('DELETE FROM "scimProvisioningGroupLink"').run();
    await h.auth.api.updateOrganization({ body: { organizationId: org!.id, data: { name: "Acme 2" } }, headers: o.headers });
    await h.settle();
    expect(h.google.groups.get("hand")).toMatchObject({ name: "Someone's", members: new Set(["x"]) });
    expect(await h.jobs()).toEqual([expect.objectContaining({ kind: "group", failed: true, lastError: expect.stringContaining("isn't this organization's") })]);
  });

  it("a group Google is still creating (members 404 at first) is retried and completes", async () => {
    const h = await createHost({ targets: [{ ...G, groups: true }], googleGroupLag: 2, retry: { baseDelayMs: 0 } });
    const o = await owner(h);
    await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.settle();
    expect((await h.jobs()).every((j) => j.failed === false)).toBe(true);
    for (let i = 0; i < 5 && (await h.jobs()).length; i++) await h.auth.api.scimProvisioningRun({ body: {} });
    expect(await h.jobs()).toEqual([]);
    expect(h.google.groups.size).toBe(1);
    expect([...[...h.google.groups.values()][0]!.members]).toEqual([googleId(h, "owner@example.com")]);
  });

  it("members are read a page at a time: a 90-member group's changes are exact", async () => {
    const h = await createHost({ targets: [{ ...G, groups: true }], googleMembersPageSize: 40 });
    const o = await owner(h);
    const org = await h.auth.api.createOrganization({ body: { name: "Big", slug: "big" }, headers: o.headers });
    const people = [];
    for (let i = 0; i < 89; i++) {
      const p = await h.ctx.internalAdapter.createUser({ email: `p${i}@example.com`, name: `Person N${i}`, emailVerified: true }, { method: "admin" });
      people.push(p);
      await h.auth.api.addMember({ body: { userId: p.id, organizationId: org!.id, role: "member" } });
    }
    await h.settle();
    const g = [...h.google.groups.values()][0]!;
    expect(g.members.size).toBe(90);
    // The member removed is on the last page.
    await h.auth.api.removeMember({ body: { memberIdOrEmail: people.at(-1)!.email, organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(g.members.size).toBe(89);
    expect(g.members.has(googleId(h, people.at(-1)!.email)!)).toBe(false);
  });

  it("the group scope is asked for only with groups; groupDomain and groupEmail name the address", async () => {
    const plain = await createHost({ targets: [G] });
    await plain.user("Ada Lovelace");
    expect(plain.google.tokenRequests.at(-1)!.claims.scope).toBe("https://www.googleapis.com/auth/admin.directory.user");

    const h = await createHost({ targets: [{ ...G, groups: true }] });
    const o = await owner(h);
    expect(String(h.google.tokenRequests.at(-1)!.claims.scope).split(" ")).toEqual(["https://www.googleapis.com/auth/admin.directory.user", "https://www.googleapis.com/auth/admin.directory.group"]);
    void o;
  });

  it("without the group scope in domain-wide delegation, the job says what to fix", async () => {
    const h = await createHost({ targets: [{ ...G, groups: true }], googleGroupScope: false, retry: { baseDelayMs: 60_000 } });
    await h.user("Ada Lovelace");
    const [job] = await h.jobs();
    expect(job).toMatchObject({ failed: false, lastError: expect.stringMatching(/unauthorized_client.*domain-wide delegation allows .*admin\.directory\.group/) });
  });
});
