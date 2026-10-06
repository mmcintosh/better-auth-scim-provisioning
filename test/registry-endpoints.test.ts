// The target registry's API: who may manage which organization's targets, what's accepted,
// what's shown (never credentials), and what each change does to delivery.
import { describe, expect, it, vi } from "vitest";
import type { TargetRegistryOptions } from "../src";
import { createHost } from "./support/host";
import { mockScim } from "./support/mock-scim";

async function setup(registry: Omit<TargetRegistryOptions, "fetch"> = {}) {
  const remote = mockScim();
  const h = await createHost({ targets: [], registry: { fetch: remote.fetch, canManage: ({ user }) => user.email === "root@example.com", ...registry } });
  /** A signed-in user's headers. */
  const signIn = async (email: string, name = email.split("@")[0]!) => {
    const up = await h.auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email, password: "correct-horse-battery" }, asResponse: true });
    return { id: up.user.id, email, headers: new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) };
  };
  const owner = await signIn("olive@example.com");
  const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: owner.headers }))!;
  const other = await signIn("oscar@example.com");
  const globex = (await h.auth.api.createOrganization({ body: { name: "Globex", slug: "globex" }, headers: other.headers }))!;
  await h.settle();
  const scim = { settings: { name: "Acme's app", url: "https://app.example.com/scim/v2" }, credentials: { token: remote.token } };
  const create = (headers: Headers, organizationId: string, body: Record<string, unknown> = scim) => h.auth.api.scimProvisioningCreateTarget({ body: { organizationId, ...body } as never, headers });
  const update = (headers: Headers, body: Record<string, unknown>) => h.auth.api.scimProvisioningUpdateTarget({ body: body as never, headers });
  const users = () => [...remote.users.values()].map((u) => [u.displayName, u.active] as const);
  return { h, remote, signIn, owner, acme, other, globex, scim, create, update, users };
}

const status = (p: Promise<unknown>) => p.then(() => 200, (e: { statusCode?: number }) => e.statusCode);

describe("who may manage targets", () => {
  it("an organization's owner, for its own organization only; others' targets are 404, not 403", async () => {
    const { h, owner, acme, other, globex, create, update } = await setup();
    const { target } = await create(owner.headers, acme.id);
    expect(await status(create(owner.headers, globex.id))).toBe(403);
    expect(await status(update(other.headers, { id: target.id, enabled: false }))).toBe(404);
    expect(await status(h.auth.api.scimProvisioningDeleteTarget({ body: { id: target.id }, headers: other.headers }))).toBe(404);
    expect(await status(h.auth.api.scimProvisioningCheckTarget({ body: { id: target.id }, headers: other.headers }))).toBe(404);
    expect(await status(h.auth.api.scimProvisioningTargetStatus({ body: { id: target.id }, headers: other.headers }))).toBe(404);
    expect((await h.auth.api.scimProvisioningListTargets({ headers: other.headers })).targets).toEqual([]);
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

  it("not while banned, and not as someone else (impersonating)", async () => {
    const { h, signIn, owner, acme, create } = await setup();
    const root = await signIn("root@example.com");
    // The owner's own session, as the admin plugin marks one an administrator impersonates.
    await h.ctx.adapter.updateMany({ model: "session", where: [{ field: "userId", value: owner.id }], update: { impersonatedBy: root.id } });
    expect(await status(create(owner.headers, acme.id))).toBe(403);
    await h.ctx.adapter.updateMany({ model: "session", where: [{ field: "userId", value: owner.id }], update: { impersonatedBy: null } });
    expect(await status(create(owner.headers, acme.id))).toBe(200);
    await h.ctx.internalAdapter.updateUser(owner.id, { banned: true });
    expect([401, 403]).toContain(await status(create(owner.headers, acme.id))); // Better Auth ends a banned user's session first
  });

  it("the host's administrators (canManage) manage every organization's", async () => {
    const { h, signIn, owner, acme, globex, create } = await setup();
    const root = await signIn("root@example.com");
    await create(owner.headers, acme.id);
    await create(root.headers, globex.id);
    expect((await h.auth.api.scimProvisioningListTargets({ headers: root.headers })).targets.map((t) => t.organizationId).sort()).toEqual([acme.id, globex.id].sort());
    expect((await h.auth.api.scimProvisioningListTargets({ headers: owner.headers })).targets.map((t) => t.organizationId)).toEqual([acme.id]);
  });

  it("organizationRoles chooses which roles manage ([] leaves it to canManage)", async () => {
    const owners = await setup({ organizationRoles: ["owner"] });
    const admin = await owners.signIn("ann@example.com");
    await owners.h.auth.api.addMember({ body: { userId: admin.id, organizationId: owners.acme.id, role: "admin" } });
    expect(await status(owners.create(admin.headers, owners.acme.id))).toBe(403);
    expect(await status(owners.create(owners.owner.headers, owners.acme.id))).toBe(200);
    const none = await setup({ organizationRoles: [] });
    expect(await status(none.create(none.owner.headers, none.acme.id))).toBe(403);
  });

  it("without registry the routes answer 404", async () => {
    const h = await createHost({ targets: [{ id: "app" }] });
    await h.auth.api.signUpEmail({ body: { email: "o@example.com", password: "correct-horse-battery", name: "O" } });
    const res = await h.auth.api.signInEmail({ body: { email: "o@example.com", password: "correct-horse-battery" }, asResponse: true });
    const headers = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
    expect(await status(h.auth.api.scimProvisioningListTargets({ headers }))).toBe(404);
  });
});

describe("what's accepted and shown", () => {
  it("credentials never come back; a webhook URL shows its origin only (Slack's and Azure's carry secrets)", async () => {
    const { h, owner, acme, create, remote } = await setup();
    const { target } = await create(owner.headers, acme.id);
    expect(target).toMatchObject({ organizationId: acme.id, type: "scim", enabled: true, credentials: { kind: "bearer" }, settings: { name: "Acme's app", url: "https://app.example.com/scim/v2" } });
    const hook = await create(owner.headers, acme.id, { settings: { type: "webhook", url: "https://hooks.example.net/services/T0/B0/s3cretpath?code=s3cret" }, credentials: { secret: "w".repeat(32) } });
    expect(hook.target.settings.url).toBe("https://hooks.example.net/…");
    const listed = JSON.stringify(await h.auth.api.scimProvisioningListTargets({ headers: owner.headers }));
    for (const secret of [remote.token, "s3cret", "w".repeat(32)]) expect(listed).not.toContain(secret);
  });

  it.each([
    ["http", { settings: { url: "http://app.example.com/scim/v2" }, credentials: { token: "t" } }, /must be https/],
    ["a private address", { settings: { url: "https://10.0.0.5/scim/v2" }, credentials: { token: "t" } }, /private/],
    ["cloud metadata", { settings: { url: "https://169.254.169.254/latest" }, credentials: { token: "t" } }, /private/],
    ["an internal name", { settings: { url: "https://scim.internal/v2" }, credentials: { token: "t" } }, /public host/],
    ["another port", { settings: { url: "https://app.example.com:6379/v2" }, credentials: { token: "t" } }, /port/],
    ["another organization", { settings: { url: "https://app.example.com/scim/v2", organizationId: "x" }, credentials: { token: "t" } }, /organizationId/],
    ["code", { settings: { url: "https://app.example.com/scim/v2", mapUser: "x" }, credentials: { token: "t" } }, /mapUser/],
    ["the wrong credentials", { settings: { type: "webhook", url: "https://app.example.com/hook" }, credentials: { token: "t" } }, /webhook target takes secret/],
    ["an oauth2 token URL inside", { settings: { url: "https://app.example.com/scim/v2" }, credentials: { auth: { type: "oauth2", tokenUrl: "https://127.0.0.1/token", clientId: "c", clientSecret: "s" } } }, /tokenUrl/],
    ["a profile on a webhook", { settings: { type: "webhook", url: "https://app.example.com/hook", profile: "slack" }, credentials: { secret: "w".repeat(32) } }, /profile: for scim targets only/],
    ["huge credentials", { settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: "t".repeat(10_000) } }, /size limits/],
  ])("refuses %s", async (_, body, problem) => {
    const { owner, acme, create } = await setup();
    const e = await create(owner.headers, acme.id, body).catch((x) => x);
    expect(e.statusCode).toBe(400);
    expect(JSON.stringify(e.body)).toMatch(problem);
  });

  it("allowHosts lets an internal host through", async () => {
    const { owner, acme, create, remote } = await setup({ allowHosts: ["scim.internal"] });
    expect(await status(create(owner.headers, acme.id, { settings: { url: "https://scim.internal/v2" }, credentials: { token: remote.token } }))).toBe(200);
  });

  it("caps an organization's targets", async () => {
    const { owner, acme, create } = await setup({ maxTargetsPerOrganization: 1 });
    await create(owner.headers, acme.id);
    expect(await status(create(owner.headers, acme.id))).toBe(409);
  });

  it("lists a page at a time", async () => {
    const { h, owner, acme, create } = await setup();
    for (let i = 0; i < 3; i++) await create(owner.headers, acme.id);
    const first = await h.auth.api.scimProvisioningListTargets({ query: { limit: 2 }, headers: owner.headers });
    const rest = await h.auth.api.scimProvisioningListTargets({ query: { limit: 2, offset: 2 }, headers: owner.headers });
    expect([first.targets.length, first.more, rest.targets.length, rest.more]).toEqual([2, true, 1, false]);
  });
});

describe("what each change does", () => {
  it("a new target gets the organization's members at once", async () => {
    const { h, owner, acme, create, users } = await setup();
    await create(owner.headers, acme.id);
    await h.settle();
    expect(users()).toEqual([["olive", true]]);
  });

  it("a fixed token: what failed goes again; the check says what's wrong in broad terms only", async () => {
    const { h, remote, owner, acme, create, update, users } = await setup();
    const { target } = await create(owner.headers, acme.id, { settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: "wrong" } });
    await h.settle();
    expect(users()).toEqual([]);
    expect(await h.auth.api.scimProvisioningCheckTarget({ body: { id: target.id }, headers: owner.headers })).toEqual({ ok: false, problem: "the credentials were refused", status: 401 });
    expect(await h.auth.api.scimProvisioningTargetStatus({ body: { id: target.id }, headers: owner.headers })).toMatchObject({ waiting: 1, accounts: 0 }); // a 401 is retried
    await update(owner.headers, { id: target.id, credentials: { token: remote.token } });
    await h.settle();
    expect(users()).toEqual([["olive", true]]);
    expect(await h.auth.api.scimProvisioningCheckTarget({ body: { id: target.id }, headers: owner.headers })).toEqual({ ok: true });
  });

  it("changing where a target sends needs its credentials again (they never go anywhere new); the type can't change", async () => {
    const { h, remote, owner, acme, create, update } = await setup();
    const { target } = await create(owner.headers, acme.id);
    const e = await update(owner.headers, { id: target.id, settings: { url: "https://collector.attacker.example/scim" } }).catch((x) => x);
    expect(e.statusCode).toBe(400);
    expect(JSON.stringify(e.body)).toMatch(/needs its credentials given again/);
    expect(await status(update(owner.headers, { id: target.id, settings: { url: "https://other.example.com/scim" }, credentials: { token: remote.token } }))).toBe(200);
    expect(await status(update(owner.headers, { id: target.id, settings: { url: "https://other.example.com/scim", name: "Renamed" } }))).toBe(200);
    expect(await status(update(owner.headers, { id: target.id, settings: { type: "webhook", url: "https://x.example.com" }, credentials: { secret: "w".repeat(32) } }))).toBe(400);
    void h;
  });

  it("a settings change applies to everyone at once (groups turned on)", async () => {
    const { h, remote, owner, acme, create, update } = await setup();
    const { target } = await create(owner.headers, acme.id);
    await h.settle();
    expect(remote.groups.size).toBe(0);
    await update(owner.headers, { id: target.id, settings: { name: "Acme's app", url: "https://app.example.com/scim/v2", groups: true } });
    await h.settle();
    expect([...remote.groups.values()].map((g) => g.displayName)).toEqual(["Acme"]);
  });

  it("while disabled, a removal and a deletion wait; enabling sends them (nobody stays active)", async () => {
    const { h, signIn, owner, acme, create, update, users } = await setup();
    const mia = await signIn("mia@example.com", "Mia Member");
    const dee = await signIn("dee@example.com", "Dee Leted");
    for (const u of [mia, dee]) await h.auth.api.addMember({ body: { userId: u.id, organizationId: acme.id, role: "member" } });
    const { target } = await create(owner.headers, acme.id);
    await h.settle();
    expect(users().map(([, active]) => active)).toEqual([true, true, true]);
    await update(owner.headers, { id: target.id, enabled: false });
    await h.auth.api.removeMember({ body: { memberIdOrEmail: mia.email, organizationId: acme.id }, headers: owner.headers });
    await h.ctx.internalAdapter.deleteUser(dee.id);
    await h.settle();
    expect(users().map(([, active]) => active)).toEqual([true, true, true]); // nothing sent while disabled
    await update(owner.headers, { id: target.id, enabled: true });
    await h.settle();
    expect(Object.fromEntries(users())).toEqual({ olive: true, "Mia Member": false, "Dee Leted": false });
  });

  it("an organization deleted while its target is disabled: a host administrator re-enables it, and its members are deprovisioned", async () => {
    const { h, signIn, owner, acme, create, update, users } = await setup();
    const root = await signIn("root@example.com");
    const { target } = await create(owner.headers, acme.id);
    await h.settle();
    await update(owner.headers, { id: target.id, enabled: false });
    await h.auth.api.deleteOrganization({ body: { organizationId: acme.id }, headers: owner.headers });
    await h.settle();
    expect(users()).toEqual([["olive", true]]);
    // Queued already, and waiting: nothing depends on someone re-enabling it to know who to deprovision.
    expect((await h.jobs()).filter((j) => j.targetId === target.id && j.userId === owner.id)).toHaveLength(1);
    expect(await status(update(owner.headers, { id: target.id, enabled: true }))).toBe(403); // no longer anyone's to manage
    await update(root.headers, { id: target.id, enabled: true });
    await h.settle();
    expect(users()).toEqual([["olive", false]]);
  });

  it("a team change reaches only its own organization's target", async () => {
    const { h, owner, other, acme, globex, create, scim } = await setup();
    const groups = { ...scim, settings: { ...scim.settings, teamGroups: true } };
    const a = await create(owner.headers, acme.id, groups);
    const g = await create(other.headers, globex.id, groups);
    await h.settle();
    const teamLinks = async (targetId: string) => (await h.ctx.adapter.findMany<{ key: string; targetId: string }>({ model: "scimProvisioningGroupLink" })).filter((l) => l.targetId === targetId && l.key.includes(":team:")).length;
    const created = vi.spyOn(h.ctx.adapter, "create");
    const before = [await teamLinks(a.target.id), await teamLinks(g.target.id)];
    await h.auth.api.createTeam({ body: { name: "Eng", organizationId: acme.id }, headers: owner.headers });
    await h.settle();
    expect([await teamLinks(a.target.id), await teamLinks(g.target.id)]).toEqual([before[0]! + 1, before[1]]);
    // Not even a job at Globex's target.
    expect(created.mock.calls.filter(([c]) => c.model === "scimProvisioningJob" && (c.data as { targetId: string }).targetId === g.target.id)).toEqual([]);
  });

  it("removing a target removes its jobs and records, and leaves the accounts at the app", async () => {
    const { h, remote, owner, acme, create } = await setup();
    const { target } = await create(owner.headers, acme.id);
    await h.settle();
    expect(await h.links()).toHaveLength(1);
    await h.auth.api.scimProvisioningDeleteTarget({ body: { id: target.id }, headers: owner.headers });
    expect(await h.links()).toEqual([]);
    expect(await h.jobs()).toEqual([]);
    expect(remote.users.size).toBe(1);
    expect((await h.auth.api.scimProvisioningListTargets({ headers: owner.headers })).targets).toEqual([]);
  });
});
