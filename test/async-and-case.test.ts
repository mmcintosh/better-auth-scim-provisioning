// An app may answer a create with 202, accepted and done later (RFC 9967's asynchronous requests),
// even though we didn't ask: the create is retried, and the retry finds the account (or group)
// instead of making another. And SCIM's attribute names are case insensitive (RFC 7643 §2.1): an
// app that answers `resources` or `ID` is read as one that answers `Resources` and `id`.
import { describe, expect, it } from "vitest";
import { SCIM_USER_SCHEMA, ScimError, scimClient, scimKeys } from "../src/scim-client";
import { createHost } from "./support/host";
import { mockScim } from "./support/mock-scim";

type Host = Awaited<ReturnType<typeof createHost>>;

async function owner(h: Host) {
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  return { headers: { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } };
}

const posts = (h: Host, path: string) => h.app.requests.filter((r) => r.method === "POST" && r.path === path).length;

describe("a create answered 202 (accepted, done later)", () => {
  it("the client says so, retryably, with the app's transaction id", async () => {
    const sp = mockScim();
    const client = scimClient({ url: sp.url, token: sp.token, fetch: sp.fetch });
    sp.fail({ accepted: true });
    const e = await client.create({ schemas: [SCIM_USER_SCHEMA], userName: "ada@example.com", externalId: "u1", active: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ScimError);
    expect(e).toMatchObject({ status: 202, retryable: true, message: expect.stringContaining("transaction txn-1") });
    sp.fail({ accepted: true });
    await expect(client.createGroup({ schemas: [], displayName: "Acme", members: [] })).rejects.toMatchObject({ status: 202, retryable: true });
  });

  it("a user's account is found on the retry and linked: one account, one create", async () => {
    const h = await createHost({ retry: { baseDelayMs: 0 } });
    h.app.failOn("POST", /^\/Users$/, { accepted: true });
    const ada = await h.user("Ada Lovelace");
    await h.settle();
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect([...h.app.users.values()].map((u) => u.userName)).toEqual([ada.email]);
    expect(posts(h, "/Users")).toBe(1);
    const account = [...h.app.users.values()][0]!;
    expect(await h.ctx.adapter.findMany({ model: "scimProvisioningLink" })).toEqual([expect.objectContaining({ userId: ada.id, remoteId: account.id, active: true })]);
    expect((await h.jobs()).filter((j) => j.failed)).toEqual([]);
    // Later changes reach it.
    await h.ctx.internalAdapter.updateUser(ada.id, { name: "Ada King" });
    await h.settle();
    expect(h.app.users.get(account.id)?.displayName).toBe("Ada King");
  });

  it("a group is found on the retry and linked: one group, one create", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true }], retry: { baseDelayMs: 0 } });
    const o = await owner(h);
    h.app.failOn("POST", /^\/Groups$/, { accepted: true });
    await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.settle();
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect([...h.app.groups.values()].map((g) => g.displayName)).toEqual(["Acme"]);
    expect(posts(h, "/Groups")).toBe(1);
    const group = [...h.app.groups.values()][0]!;
    expect(await h.ctx.adapter.findMany({ model: "scimProvisioningGroupLink" })).toEqual([expect.objectContaining({ remoteId: group.id })]);
    expect((await h.jobs()).filter((j) => j.failed)).toEqual([]);
  });
});

describe("attribute names in any case", () => {
  it("the client reads lists, users, groups and errors whatever their case", async () => {
    const sp = mockScim({ lowercaseKeys: true });
    const client = scimClient({ url: sp.url, token: sp.token, fetch: sp.fetch });
    const id = await client.create({ schemas: [SCIM_USER_SCHEMA], userName: "ada@example.com", externalId: "u1", name: { givenName: "Ada", familyName: "Lovelace" }, active: true });
    expect(await client.findByUserName("ada@example.com")).toEqual({ id, externalId: "u1", active: true });
    expect((await client.listUsers(null, 10)).users).toEqual([{ id, userName: "ada@example.com", externalId: "u1", active: true }]);
    const group = await client.createGroup({ schemas: [], displayName: "Acme", members: [{ value: id }] });
    expect(await client.findGroupByName("Acme")).toEqual({ id: group, externalId: null });
    expect(await client.groupMembers(group)).toEqual([id]);
    // An error's detail and scimType, spelled otherwise.
    const odd = scimClient({ url: "https://app.example.com/scim/v2", token: "t", fetch: async () => new Response(JSON.stringify({ Detail: "userName taken", SCIMTYPE: "uniqueness" }), { status: 409 }) });
    await expect(odd.create({ schemas: [SCIM_USER_SCHEMA], userName: "x@example.com", active: true })).rejects.toMatchObject({ scimType: "uniqueness", message: expect.stringContaining("userName taken") });
  });

  it("only the names we read are respelled; spelled both ways, the exact spelling wins", () => {
    expect(scimKeys({ resources: [{ ID: "1", USERNAME: "a", custom: { Nested: 1 } }], TOTALRESULTS: 1 })).toEqual({ Resources: [{ id: "1", userName: "a", custom: { Nested: 1 } }], totalResults: 1 });
    expect(scimKeys({ resources: ["lower"], Resources: ["exact"] })).toEqual({ Resources: ["exact"] });
    expect(scimKeys({ Resources: ["exact"], resources: ["lower"] })).toEqual({ Resources: ["exact"] });
  });

  it("an app that lowercases everything is provisioned as any other", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true, lowercaseKeys: true }] });
    const o = await owner(h);
    await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.settle();
    expect((await h.jobs()).filter((j) => j.failed || Number(j.attempts) > 0)).toEqual([]);
    expect([...h.app.groups.values()].map((g) => g.members.length)).toEqual([1]);
    const drift = (await h.auth.api.scimProvisioningDrift({ body: { targetId: "app" } })) as { items: unknown[] };
    expect(drift.items).toEqual([]);
  });
});
