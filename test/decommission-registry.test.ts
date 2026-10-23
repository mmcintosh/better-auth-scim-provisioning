// Decommissioning organizations' own targets (the registry): only owners (or decommissionRoles),
// freshly signed in; preview and confirm; a target that's being retired can't be pointed at another
// app; the delete route says what it leaves behind, and can refuse to; and an account another
// organization's target at the same app still has is left on.
import { describe, expect, it } from "vitest";
import type { TargetRegistryOptions } from "../src";
import { createHost } from "./support/host";
import { mockScim } from "./support/mock-scim";

async function setup(registry: Omit<TargetRegistryOptions, "fetch"> = {}) {
  const remote = mockScim();
  const h = await createHost({ targets: [], decommission: true, registry: { fetch: remote.fetch, ...registry } });
  const signIn = async (email: string) => {
    const up = await h.auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name: email.split("@")[0]! } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email, password: "correct-horse-battery" }, asResponse: true });
    return { id: up.user.id, email, headers: new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) };
  };
  const owner = await signIn("olive@example.com");
  const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: owner.headers }))!;
  const admin = await signIn("ann@example.com");
  await h.auth.api.addMember({ body: { userId: admin.id, organizationId: acme.id, role: "admin" } });
  await h.settle();
  const settings = { url: "https://app.example.com/scim/v2" };
  const { target } = await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings, credentials: { token: remote.token } }, headers: owner.headers });
  await h.settle();
  const decommission = (headers: Headers, body: Record<string, unknown> = {}) => h.auth.api.scimProvisioningDecommissionTarget({ body: { id: target.id, ...body } as never, headers });
  const statusOf = async () => (await h.auth.api.scimProvisioningTargetStatus({ body: { id: target.id }, headers: owner.headers })) as { decommission?: { state: string; accounts: number } | null };
  const drive = async () => {
    for (let i = 0; i < 30 && (await statusOf()).decommission?.state !== "complete"; i++) {
      await h.auth.api.scimProvisioningRun({ body: { limit: 200 } });
      await h.ctx.adapter.updateMany({ model: "scimProvisioningJob", where: [{ field: "targetId", value: target.id }], update: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await h.settle();
    }
  };
  const active = () => [...remote.users.values()].filter((u) => u.active).map((u) => u.userName).sort();
  return { h, remote, signIn, owner, admin, acme, target, settings, decommission, statusOf, drive, active };
}

const status = (p: Promise<unknown>) => p.then(() => 200, (e: { statusCode?: number }) => e.statusCode);

describe("decommissioning an organization's target", () => {
  it("an owner previews, confirms the count, and it deactivates everyone there", async () => {
    const { owner, decommission, statusOf, drive, active } = await setup();
    expect(active()).toEqual(["ann@example.com", "olive@example.com"]);
    expect(await decommission(owner.headers, { preview: true })).toMatchObject({ accounts: 2, groups: 0, decommission: null });
    expect(await status(decommission(owner.headers, { confirm: 1 }))).toBe(400);
    expect(await decommission(owner.headers, { confirm: 2 })).toMatchObject({ decommission: { state: "running", startedBy: `user:${owner.id}` } });
    await drive();
    expect(await statusOf()).toMatchObject({ decommission: { state: "complete", accounts: 0 } });
    expect(active()).toEqual([]);
  });

  it("only owners by default (decommissionRoles widens it), signed in within 15 minutes", async () => {
    const { h, owner, admin, decommission } = await setup();
    // An admin manages the target, but may only look.
    expect(await status(decommission(admin.headers, { confirm: 2 }))).toBe(403);
    expect(await status(decommission(admin.headers, { preview: true }))).toBe(403);
    // Better Auth's own freshness is a day; this needs 15 minutes, except to preview.
    await h.ctx.adapter.updateMany({ model: "session", where: [{ field: "userId", value: owner.id }], update: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    await expect(decommission(owner.headers, { confirm: 2 })).rejects.toThrow(/sign in again/);
    expect(await status(decommission(owner.headers, { preview: true }))).toBe(200);
    const wider = await setup({ decommissionRoles: ["owner", "admin"] });
    expect(await status(wider.decommission(wider.admin.headers, { confirm: 2 }))).toBe(200);
  });

  it("refused for a disabled target; cancelled before it completes, those still wanted are back", async () => {
    const { h, remote, owner, target, decommission, statusOf, active } = await setup();
    await h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, enabled: false }, headers: owner.headers });
    await expect(decommission(owner.headers, { confirm: 2 })).rejects.toThrow(/disabled: enable it first/);
    await h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, enabled: true }, headers: owner.headers });
    await h.settle();
    // Olive's account can't be reached for now: it isn't complete.
    const olive = [...remote.users.values()].find((u) => u.userName === "olive@example.com")!;
    for (let i = 0; i < 10; i++) for (const method of ["PATCH", "PUT"]) remote.failOn(method, new RegExp(`^/Users/${olive.id}$`), { status: 503 });
    await decommission(owner.headers, { confirm: 2 });
    await h.settle();
    expect(active()).toEqual(["olive@example.com"]);
    expect(await statusOf()).toMatchObject({ decommission: { state: "running" } });
    expect(await decommission(owner.headers, { cancel: true })).toMatchObject({ decommission: { state: "cancelled" } });
    await h.settle();
    expect(active()).toEqual(["ann@example.com", "olive@example.com"]);
  });

  it("a target being retired can't be pointed at another app; its credentials can still change", async () => {
    const { h, remote, owner, target, decommission } = await setup();
    await decommission(owner.headers, { confirm: 2 });
    const update = (body: Record<string, unknown>) => h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, ...body } as never, headers: owner.headers });
    await expect(update({ settings: { url: "https://other.example.com/scim/v2" }, credentials: { token: remote.token } })).rejects.toThrow(/can't be pointed at another app/);
    expect(await status(update({ credentials: { token: remote.token } }))).toBe(200);
  });

  it("the delete route says what it leaves behind, and with deleteRequiresDecommission refuses unless abandon: true", async () => {
    const plain = await setup();
    expect(await plain.h.auth.api.scimProvisioningDeleteTarget({ body: { id: plain.target.id }, headers: plain.owner.headers })).toEqual({ deleted: true, abandoned: { accounts: 2, groups: 0 } });
    const strict = await setup({ deleteRequiresDecommission: true });
    const del = (body: Record<string, unknown> = {}) => strict.h.auth.api.scimProvisioningDeleteTarget({ body: { id: strict.target.id, ...body } as never, headers: strict.owner.headers });
    await expect(del()).rejects.toThrow(/2 accounts .* still active at the app: decommission it first/);
    // A record first: the accounts it would leave.
    const { items } = await strict.h.auth.api.scimProvisioningTargetAccounts({ body: { id: strict.target.id }, headers: strict.owner.headers });
    expect(items.map((a) => [a.userName, a.active])).toEqual(expect.arrayContaining([["olive@example.com", true], ["ann@example.com", true]]));
    await strict.decommission(strict.owner.headers, { confirm: 2 });
    await strict.drive();
    expect(await del()).toEqual({ deleted: true, abandoned: { accounts: 0, groups: 0 } });
    expect(await strict.h.ctx.adapter.count({ model: "scimProvisioningDecommission" })).toBe(0);
    const again = await setup({ deleteRequiresDecommission: true });
    expect(await again.h.auth.api.scimProvisioningDeleteTarget({ body: { id: again.target.id, abandon: true }, headers: again.owner.headers })).toMatchObject({ abandoned: { accounts: 2 } });
  });

  it("a purge, by an owner, after it completes", async () => {
    const { owner, admin, decommission, statusOf, drive, remote } = await setup({ decommissionRoles: ["owner"] });
    await expect(decommission(owner.headers, { phase: "purge" })).rejects.toThrow(/after a complete decommission/);
    await decommission(owner.headers, { confirm: 2 });
    await drive();
    expect(await status(decommission(admin.headers, { phase: "purge" }))).toBe(403);
    expect(await decommission(owner.headers, { phase: "purge", preview: true })).toMatchObject({ accounts: 2 });
    await decommission(owner.headers, { phase: "purge" });
    await drive();
    expect(await statusOf()).toMatchObject({ decommission: { phase: "purge", state: "complete" } });
    expect(remote.users.size).toBe(0);
  });

  it("an account another organization's target at the same app still has is left on", async () => {
    const { h, remote, owner, admin, settings, decommission, drive, active } = await setup();
    // Ann is in Globex too, whose target reaches the same app: her account there is both targets'.
    const other = await h.auth.api.signUpEmail({ body: { email: "oscar@example.com", password: "correct-horse-battery", name: "Oscar" } });
    await h.ctx.internalAdapter.updateUser(other.user.id, { emailVerified: true });
    const res = await h.auth.api.signInEmail({ body: { email: "oscar@example.com", password: "correct-horse-battery" }, asResponse: true });
    const oscar = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
    const globex = (await h.auth.api.createOrganization({ body: { name: "Globex", slug: "globex" }, headers: oscar }))!;
    await h.auth.api.addMember({ body: { userId: admin.id, organizationId: globex.id, role: "member" } });
    await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: globex.id, settings, credentials: { token: remote.token } }, headers: oscar });
    await h.settle();
    expect(active()).toEqual(["ann@example.com", "olive@example.com", "oscar@example.com"]);
    await decommission(owner.headers, { confirm: 2 });
    await drive();
    expect(active()).toEqual(["ann@example.com", "oscar@example.com"]);
  });

  it("a purge leaves an account another organization's target at the same app took up since", async () => {
    const { h, remote, owner, admin, settings, decommission, drive, active, signIn } = await setup();
    await decommission(owner.headers, { confirm: 2 });
    await drive();
    expect(active()).toEqual([]);
    // Then Globex connects the same app, Ann among its members: its target takes up her account again.
    const oscar = await signIn("oscar@example.com");
    const globex = (await h.auth.api.createOrganization({ body: { name: "Globex", slug: "globex" }, headers: oscar.headers }))!;
    await h.auth.api.addMember({ body: { userId: admin.id, organizationId: globex.id, role: "member" } });
    await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: globex.id, settings, credentials: { token: remote.token } }, headers: oscar.headers });
    await h.settle();
    expect(active()).toEqual(["ann@example.com", "oscar@example.com"]);
    await decommission(owner.headers, { phase: "purge" });
    await drive();
    expect([...remote.users.values()].map((u) => u.userName).sort()).toEqual(["ann@example.com", "oscar@example.com"]);
    expect(active()).toEqual(["ann@example.com", "oscar@example.com"]);
  });

  it("while it's being decommissioned (or is), only those who may decommission it may remove or pause the target", async () => {
    const { h, owner, admin, target, decommission } = await setup();
    await decommission(owner.headers, { confirm: 2 });
    expect(await status(h.auth.api.scimProvisioningDeleteTarget({ body: { id: target.id, abandon: true }, headers: admin.headers }))).toBe(403);
    expect(await status(h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, enabled: false }, headers: admin.headers }))).toBe(403);
    // A rename is still theirs to make.
    expect(await status(h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, settings: { url: "https://app.example.com/scim/v2", name: "Old app" } }, headers: admin.headers }))).toBe(200);
    expect(await status(h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, enabled: false }, headers: owner.headers }))).toBe(200);
  });

  it("decommissionRoles counts only roles that may manage targets at all", async () => {
    const { admin, decommission } = await setup({ organizationRoles: ["owner"], decommissionRoles: ["owner", "admin"] });
    expect(await status(decommission(admin.headers, { preview: true }))).toBe(403);
  });
});
