// App profiles, each checked against a model of what the app documents (test/support/mock-scim.ts,
// `like`), and against the plain standard where nothing differs.
import { describe, expect, it } from "vitest";
import { atlassian, awsIamIdentityCenter, githubEnterprise, slack, slackUserName } from "../src";
import { createHost } from "./support/host";

type Host = Awaited<ReturnType<typeof createHost>>;

async function owner(h: Host) {
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  return { headers: { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } };
}

/** An organization with `n` provisioned members besides its owner, added straight to the database. */
async function orgWith(h: Host, n: number) {
  const o = await owner(h);
  const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const u = await h.ctx.internalAdapter.createUser({ email: `m${i}@example.com`, name: `Member Number${i}`, emailVerified: true }, { method: "admin" });
    await h.ctx.adapter.create({ model: "member", data: { organizationId: org!.id, userId: u.id, role: "member", createdAt: new Date() } });
    ids.push(u.id);
  }
  await h.settle();
  return { o, org: org!, ids };
}

const drain = async (h: Host) => {
  for (let i = 0; i < 6 && (await h.jobs()).length; i++) await h.auth.api.scimProvisioningRun({ body: {} });
  await h.settle();
};
const only = (h: Host) => [...h.app.groups.values()];
const awsCompat = awsIamIdentityCenter({ id: "x", url: "https://x.test/scim/v2", token: "t" }).compat;

describe("AWS IAM Identity Center", () => {
  it("without the profile, groups fail there (no PUT on groups)", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true, like: "aws" }] });
    const o = await owner(h);
    await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    const a = await h.user("Ada Lovelace");
    await h.ctx.adapter.create({ model: "member", data: { organizationId: only(h)[0]!.externalId as string, userId: a.id, role: "member", createdAt: new Date() } });
    await h.auth.api.scimProvisioningReconcile({ body: {} });
    await drain(h);
    expect((await h.jobs()).some((j) => j.kind === "group" && String(j.lastError).includes("unsupported"))).toBe(true);
  });

  it("with it: a 150-member group in batches of 100, members read over cursor pages, removals and a rename", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true, like: "aws", pageSize: 40, compat: awsCompat }] });
    const { o, org, ids } = await orgWith(h, 150);
    await h.auth.api.scimProvisioningReconcile({ body: {} });
    await drain(h);
    expect(only(h)).toHaveLength(1);
    expect(only(h)[0]!.members).toHaveLength(151);

    for (const id of ids.slice(0, 120)) await h.ctx.adapter.deleteMany({ model: "member", where: [{ field: "userId", value: id }] });
    await h.auth.api.updateOrganization({ body: { organizationId: org.id, data: { name: "Acme Corp" } }, headers: o.headers });
    await h.settle();
    await drain(h);
    expect(only(h).map((g) => [g.displayName, g.members.length])).toEqual([["Acme Corp", 31]]);
    expect((await h.jobs()).filter((j) => j.failed)).toEqual([]);
  });
});

describe("Atlassian", () => {
  it("without the profile, a rename fails there", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true, like: "atlassian" }] });
    const { o, org } = await orgWith(h, 1);
    await h.auth.api.updateOrganization({ body: { organizationId: org.id, data: { name: "Acme Corp" } }, headers: o.headers });
    await h.settle();
    expect((await h.jobs()).find((j) => j.kind === "group")).toMatchObject({ failed: true, lastError: expect.stringContaining("Renaming") });
  });

  it("with it: a rename creates the new group with its members, then deletes the old", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true, like: "atlassian", compat: atlassian({ id: "x", url: "https://x.test/scim/v2", token: "t" }).compat }] });
    const { o, org } = await orgWith(h, 2);
    const before = only(h)[0]!;
    await h.auth.api.updateOrganization({ body: { organizationId: org.id, data: { name: "Acme Corp" } }, headers: o.headers });
    await h.settle();
    expect(only(h).map((g) => [g.displayName, g.members.length])).toEqual([["Acme Corp", 3]]);
    expect(only(h)[0]!.id).not.toBe(before.id);
    expect(await h.ctx.adapter.findMany({ model: "scimProvisioningGroupLink" })).toEqual([expect.objectContaining({ remoteId: only(h)[0]!.id, displayName: "Acme Corp" })]);
  });
});

describe("Slack", () => {
  it("userNames fit Slack's rules: the email's local part, lowercase, . _ - only, at most 21 characters", async () => {
    expect(slackUserName("Jane.Doe+Slack@example.com")).toBe("jane.doe_slack");
    expect(slackUserName("a.very.long.name.indeed@example.com")).toBe("a.very.long.name.inde");
    const t = slack({ id: "slack", url: "https://api.slack.com/scim/v2", token: "xoxp" });
    const h = await createHost({ targets: [{ id: "app", mapUser: t.mapUser }] });
    await h.ctx.internalAdapter.createUser({ email: "Grace.Hopper@example.com", name: "Grace Hopper", emailVerified: true }, { method: "admin" });
    await h.settle();
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ userName: "grace.hopper", emails: [expect.objectContaining({ value: "grace.hopper@example.com" })] })]);
  });
});

describe("GitHub Enterprise Managed Users", () => {
  it("only deactivates: delete mode is refused, because GitHub's DELETE can't be undone", () => {
    expect(githubEnterprise({ id: "gh", url: "https://api.github.com/scim/v2/enterprises/acme", token: "ghp" }).deprovision).toBe("deactivate");
    expect(() => githubEnterprise({ id: "gh", url: "https://api.github.com/scim/v2/enterprises/acme", token: "ghp", deprovision: "delete" })).toThrow(/permanently/);
  });
});

it("a target's own settings win over its profile's", () => {
  const t = awsIamIdentityCenter({ id: "aws", url: "https://x.test/scim/v2", token: "t", compat: { maxGroupMembersPerRequest: 25 } });
  expect(t.compat).toEqual({ groupUpdate: "patch", groupMembers: "users-filter", maxGroupMembersPerRequest: 25 });
  const mine = (u: { email: string }) => ({ schemas: [], userName: `me-${u.email}`, active: true });
  expect(slack({ id: "s", url: "https://x.test/scim/v2", token: "t", mapUser: mine }).mapUser).toBe(mine);
});
