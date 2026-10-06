// The target registry's API (step 3): who may manage which organization's targets, what's
// accepted, what's shown (never credentials), and what each change does to delivery.
import { describe, expect, it } from "vitest";
import { createHost } from "./support/host";
import { mockScim } from "./support/mock-scim";

async function setup() {
  const remote = mockScim();
  const h = await createHost({ targets: [], registry: { fetch: remote.fetch, cacheSeconds: 0, canManage: ({ user }) => user.email === "root@example.com" } });
  /** A signed-in user's headers. */
  const signIn = async (email: string, name = email.split("@")[0]!) => {
    const up = await h.auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email, password: "correct-horse-battery" }, asResponse: true });
    return { id: up.user.id, headers: new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) };
  };
  const owner = await signIn("olive@example.com");
  const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: owner.headers }))!;
  const other = await signIn("oscar@example.com");
  const globex = (await h.auth.api.createOrganization({ body: { name: "Globex", slug: "globex" }, headers: other.headers }))!;
  await h.settle();
  const scim = { settings: { name: "Acme's app", url: "https://app.example.com/scim/v2" }, credentials: { token: remote.token } };
  const create = (headers: Headers, organizationId: string, body: Record<string, unknown> = scim) => h.auth.api.scimProvisioningCreateTarget!({ body: { organizationId, ...body } as never, headers });
  return { h, remote, signIn, owner, acme, other, globex, scim, create };
}

const status = (p: Promise<unknown>) => p.then(() => 200, (e: { statusCode?: number }) => e.statusCode);

describe("who may manage targets", () => {
  it("an organization's owner, for its own organization only; others' targets are 404, not 403", async () => {
    const { h, owner, acme, other, globex, create } = await setup();
    const { target } = await create(owner.headers, acme.id);
    expect(await status(create(owner.headers, globex.id))).toBe(403);
    expect(await status(h.auth.api.scimProvisioningUpdateTarget!({ body: { id: target.id, enabled: false }, headers: other.headers }))).toBe(404);
    expect(await status(h.auth.api.scimProvisioningDeleteTarget!({ body: { id: target.id }, headers: other.headers }))).toBe(404);
    expect(await status(h.auth.api.scimProvisioningCheckTarget!({ body: { id: target.id }, headers: other.headers }))).toBe(404);
    expect((await h.auth.api.scimProvisioningListTargets!({ headers: other.headers })).targets).toEqual([]);
  });

  it("a plain member can't; a demoted owner can't at once; nobody signed out can", async () => {
    const { h, signIn, owner, acme, create } = await setup();
    const mia = await signIn("mia@example.com");
    await h.auth.api.addMember({ body: { userId: mia.id, organizationId: acme.id, role: "member" } });
    expect(await status(create(mia.headers, acme.id))).toBe(403);
    await h.ctx.adapter.updateMany({ model: "member", where: [{ field: "userId", value: owner.id }], update: { role: "member" } });
    expect(await status(create(owner.headers, acme.id))).toBe(403);
    expect(await status(create(new Headers(), acme.id))).toBe(401);
  });

  it("the host's administrators (canManage) manage every organization's", async () => {
    const { h, signIn, owner, acme, globex, create } = await setup();
    const root = await signIn("root@example.com");
    await create(owner.headers, acme.id);
    await create(root.headers, globex.id);
    expect((await h.auth.api.scimProvisioningListTargets!({ headers: root.headers })).targets.map((t) => t.organizationId).sort()).toEqual([acme.id, globex.id].sort());
    expect((await h.auth.api.scimProvisioningListTargets!({ headers: owner.headers })).targets.map((t) => t.organizationId)).toEqual([acme.id]);
  });
});

describe("what's accepted and shown", () => {
  it("credentials never come back; a webhook URL's query is hidden", async () => {
    const { h, owner, acme, create, remote } = await setup();
    const { target } = await create(owner.headers, acme.id);
    expect(target).toMatchObject({ organizationId: acme.id, type: "scim", enabled: true, credentials: { kind: "bearer" }, settings: { name: "Acme's app" } });
    const hook = await create(owner.headers, acme.id, { settings: { type: "webhook", url: "https://fn.example.net/api/scim?code=s3cret" }, credentials: { secret: "w".repeat(32) } });
    expect(hook.target.settings.url).toBe("https://fn.example.net/api/scim?…");
    const listed = JSON.stringify(await h.auth.api.scimProvisioningListTargets!({ headers: owner.headers }));
    expect(listed).not.toContain(remote.token);
    expect(listed).not.toContain("s3cret");
    expect(listed).not.toContain("w".repeat(32));
  });

  it.each([
    ["http", { settings: { url: "http://app.example.com/scim/v2" }, credentials: { token: "t" } }, /must be https/],
    ["a private address", { settings: { url: "https://10.0.0.5/scim/v2" }, credentials: { token: "t" } }, /private/],
    ["cloud metadata", { settings: { url: "https://169.254.169.254/latest" }, credentials: { token: "t" } }, /private/],
    ["an internal name", { settings: { url: "https://scim.internal/v2" }, credentials: { token: "t" } }, /public host/],
    ["another organization", { settings: { url: "https://app.example.com/scim/v2", organizationId: "x" }, credentials: { token: "t" } }, /organizationId/],
    ["code", { settings: { url: "https://app.example.com/scim/v2", mapUser: "x" }, credentials: { token: "t" } }, /mapUser/],
    ["the wrong credentials", { settings: { type: "webhook", url: "https://app.example.com/hook" }, credentials: { token: "t" } }, /webhook target takes secret/],
    ["an oauth2 token URL inside", { settings: { url: "https://app.example.com/scim/v2" }, credentials: { auth: { type: "oauth2", tokenUrl: "https://127.0.0.1/token", clientId: "c", clientSecret: "s" } } }, /tokenUrl/],
    ["a profile on a webhook", { settings: { type: "webhook", url: "https://app.example.com/hook", profile: "slack" }, credentials: { secret: "w".repeat(32) } }, /profile: for scim targets only/],
  ])("refuses %s", async (_, body, problem) => {
    const { owner, acme, create } = await setup();
    const e = await create(owner.headers, acme.id, body).catch((x) => x);
    expect(e.statusCode).toBe(400);
    expect(JSON.stringify(e.body)).toMatch(problem);
  });

  it("caps an organization's targets", async () => {
    const remote = mockScim();
    const h = await createHost({ targets: [], registry: { fetch: remote.fetch, maxTargetsPerOrganization: 1 } });
    const up = await h.auth.api.signUpEmail({ body: { email: "o@example.com", password: "correct-horse-battery", name: "O" } });
    const res = await h.auth.api.signInEmail({ body: { email: "o@example.com", password: "correct-horse-battery" }, asResponse: true });
    const headers = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
    const org = (await h.auth.api.createOrganization({ body: { name: "A", slug: "a" }, headers }))!;
    void up;
    const body = { organizationId: org.id, settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: remote.token } };
    await h.auth.api.scimProvisioningCreateTarget!({ body: body as never, headers });
    expect(await status(h.auth.api.scimProvisioningCreateTarget!({ body: body as never, headers }))).toBe(409);
  });
});

describe("what each change does", () => {
  it("a new target gets the organization's members at once", async () => {
    const { h, remote, owner, acme, create } = await setup();
    await create(owner.headers, acme.id);
    await h.settle();
    expect([...remote.users.values()].map((u) => u.displayName)).toEqual(["olive"]);
  });

  it("new credentials replace the old; the type can't change", async () => {
    const { h, remote, owner, acme, create } = await setup();
    const { target } = await create(owner.headers, acme.id, { settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: "wrong" } });
    await h.settle();
    expect(remote.users.size).toBe(0);
    expect(await h.auth.api.scimProvisioningCheckTarget!({ body: { id: target.id }, headers: owner.headers })).toMatchObject({ ok: false, status: 401 });
    await h.auth.api.scimProvisioningUpdateTarget!({ body: { id: target.id, credentials: { token: remote.token } }, headers: owner.headers });
    expect(await h.auth.api.scimProvisioningCheckTarget!({ body: { id: target.id }, headers: owner.headers })).toEqual({ ok: true });
    const e = await h.auth.api.scimProvisioningUpdateTarget!({ body: { id: target.id, settings: { type: "webhook", url: "https://x.example.com" } }, headers: owner.headers }).catch((x) => x);
    expect(e.statusCode).toBe(400);
  });

  it("disabling pauses; enabling again queues the organization", async () => {
    const { h, remote, owner, acme, create } = await setup();
    const { target } = await create(owner.headers, acme.id, { ...{ settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: remote.token } }, enabled: false });
    await h.settle();
    expect(remote.users.size).toBe(0);
    await h.auth.api.scimProvisioningUpdateTarget!({ body: { id: target.id, enabled: true }, headers: owner.headers });
    await h.settle();
    expect(remote.users.size).toBe(1);
  });

  it("removing a target removes its jobs and records, and leaves the accounts at the app", async () => {
    const { h, remote, owner, acme, create } = await setup();
    const { target } = await create(owner.headers, acme.id);
    await h.settle();
    expect(await h.links()).toHaveLength(1);
    await h.auth.api.scimProvisioningDeleteTarget!({ body: { id: target.id }, headers: owner.headers });
    expect(await h.links()).toEqual([]);
    expect(await h.jobs()).toEqual([]);
    expect(remote.users.size).toBe(1);
    expect((await h.auth.api.scimProvisioningListTargets!({ headers: owner.headers })).targets).toEqual([]);
  });
});
