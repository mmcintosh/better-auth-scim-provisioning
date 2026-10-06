// The target registry: targets stored in the database, their credentials sealed, tied to one
// organization, looked up when used (by id for a delivery, by organization for a change).
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins";
import { describe, expect, it, vi } from "vitest";
import { scimProvisioning } from "../src";
import { type Adapter, PAUSED_UNTIL } from "../src/outbox";
import { guardedFetch, publicUrl, registrySource, seal, type StoredCredentials, type StoredSettings, TARGET_MODEL, unseal } from "../src/registry";
import { createHost } from "./support/host";
import { mockScim } from "./support/mock-scim";

const KEY = "test-secret-that-is-at-least-32-characters-long";

/** A host with the registry on, a stored-target app, and organizations to own targets (made directly, no hooks). */
async function setup() {
  const remote = mockScim();
  const h = await createHost({ targets: [], registry: { fetch: remote.fetch } });
  const org = (n: string) => h.ctx.adapter.create<Record<string, unknown>, { id: string }>({ model: "organization", data: { name: n, slug: n.toLowerCase(), createdAt: new Date() } });
  const store = async (targetId: string, organizationId: string, settings: StoredSettings = {}, credentials: StoredCredentials = { token: remote.token }, enabled = true) =>
    h.ctx.adapter.create({
      model: TARGET_MODEL,
      data: { targetId, organizationId, type: settings.type ?? "scim", config: JSON.stringify({ url: "https://app.example.com/scim/v2", ...settings }), sealed: await seal(KEY, targetId, organizationId, credentials), enabled, createdAt: new Date(), updatedAt: new Date() },
    });
  const setEnabled = (targetId: string, enabled: boolean) => h.ctx.adapter.update({ model: TARGET_MODEL, where: [{ field: "targetId", value: targetId }], update: { enabled } });
  const join = async (userId: string, organizationId: string) => {
    await h.auth.api.addMember({ body: { userId, organizationId, role: "member" } });
    await h.settle();
  };
  const jobsAt = async (targetId: string) => (await h.jobs()).filter((j) => j.targetId === targetId);
  return { h, remote, org, store, setEnabled, join, jobsAt };
}

describe("sealed credentials", () => {
  it("open only for the target and organization they were sealed for, and only with the key", async () => {
    const sealed = await seal(KEY, "t1", "org1", { token: "secret-token" });
    expect(sealed).not.toContain("secret-token");
    expect(await unseal(KEY, { targetId: "t1", organizationId: "org1", sealed })).toEqual({ token: "secret-token" });
    await expect(unseal(KEY, { targetId: "t2", organizationId: "org1", sealed })).rejects.toThrow(/belong to another target/);
    await expect(unseal(KEY, { targetId: "t1", organizationId: "org2", sealed })).rejects.toThrow(/belong to another target/);
    await expect(unseal("another-secret-that-is-at-least-32-characters", { targetId: "t1", organizationId: "org1", sealed })).rejects.toThrow(/can't be decrypted/);
  });

  it("sealed with a rotated-out secret: sealed again with the current one when read, so the old secret can be retired", async () => {
    const { h, org } = await setup();
    const acme = await org("Acme");
    const old = { keys: new Map([[1, "old-secret-that-is-at-least-32-characters-long"]]), currentVersion: 1 };
    const rotated = { keys: new Map([[2, "new-secret-that-is-at-least-32-characters-long"], [1, "old-secret-that-is-at-least-32-characters-long"]]), currentVersion: 2 };
    await h.ctx.adapter.create({ model: TARGET_MODEL, data: { targetId: "t1", organizationId: acme.id, type: "scim", config: JSON.stringify({ url: "https://app.example.com/scim/v2" }), sealed: await seal(old, "t1", acme.id, { token: "tok" }), enabled: true, createdAt: new Date(), updatedAt: new Date() } });
    const source = registrySource([], h.ctx.adapter as unknown as Adapter, rotated, {}, { error: () => {} });
    expect(await source.get("t1")).toMatchObject({ token: "tok" });
    const [row] = await h.ctx.adapter.findMany<{ sealed: string }>({ model: TARGET_MODEL });
    expect(row!.sealed.startsWith("$ba$2$")).toBe(true);
    const retired = { keys: new Map([[2, "new-secret-that-is-at-least-32-characters-long"]]), currentVersion: 2 };
    expect(await unseal(retired, { targetId: "t1", organizationId: acme.id, sealed: row!.sealed })).toEqual({ token: "tok" });
  });
});

describe("stored targets", () => {
  it("receive their organization's members only, and nothing is even queued for others", async () => {
    const { h, remote, org, store, join } = await setup();
    const acme = await org("Acme");
    const globex = await org("Globex");
    await store("acme-app", acme.id);
    const ada = await h.user("Ada Lovelace");
    const bob = await h.user("Bob Builder");
    await join(ada.id, acme.id);
    await join(bob.id, globex.id);
    expect([...remote.users.values()].map((u) => u.displayName)).toEqual(["Ada Lovelace"]);
    const create = vi.spyOn(h.ctx.adapter, "create");
    await h.ctx.internalAdapter.updateUser(bob.id, { name: "Bob Rebuilt" });
    await h.settle();
    expect(create.mock.calls.filter(([a]) => a.model === "scimProvisioningJob")).toEqual([]);
  });

  it("a user with an account there who's no longer a member is deactivated (the account, not the membership, decides)", async () => {
    const { h, remote, org, store, join } = await setup();
    const acme = await org("Acme");
    await store("acme-app", acme.id);
    const ada = await h.user("Ada Lovelace");
    await join(ada.id, acme.id);
    // Removed behind the plugin's back: her next change still reaches Acme's app, as she has an account there.
    await h.ctx.adapter.deleteMany({ model: "member", where: [{ field: "userId", value: ada.id }] });
    await h.ctx.internalAdapter.updateUser(ada.id, { name: "Ada King" });
    await h.settle();
    expect([...remote.users.values()][0]).toMatchObject({ active: false });
  });

  it("a member of more than 100 organizations still reaches every one's target (no default page size)", async () => {
    const { h, remote, org, store } = await setup();
    const ada = await h.user("Ada Lovelace");
    let last = "";
    for (let i = 0; i < 101; i++) {
      const o = await org(`Org${i}`);
      await h.ctx.adapter.create({ model: "member", data: { organizationId: o.id, userId: ada.id, role: "member", createdAt: new Date() } });
      last = o.id;
    }
    await store("last-app", last);
    await h.ctx.internalAdapter.updateUser(ada.id, { name: "Ada King" });
    await h.settle();
    expect([...remote.users.values()].map((u) => u.displayName)).toEqual(["Ada King"]);
  });

  it("a profile is applied by name, and the stored organization can't be overridden", async () => {
    const { h, remote, org, store, join } = await setup();
    const acme = await org("Acme");
    const globex = await org("Globex");
    // organizationId isn't a stored setting: the row is paused, never sent Globex's users.
    await store("sneaky", acme.id, { organizationId: globex.id } as never);
    await store("slack", acme.id, { profile: "slack" });
    const ada = await h.user("Ada Lovelace");
    await join(ada.id, globex.id);
    expect(remote.users.size).toBe(0);
    await join(ada.id, acme.id);
    // Slack's userName: the email's local part.
    expect([...remote.users.values()].map((u) => u.userName)).toEqual([ada.email.split("@")[0]]);
  });

  it("changes while a target is disabled are queued and wait; they're never due in the meantime", async () => {
    const { h, remote, org, store, setEnabled, join, jobsAt } = await setup();
    const acme = await org("Acme");
    await store("acme-app", acme.id);
    const ada = await h.user("Ada Lovelace");
    await join(ada.id, acme.id);
    await setEnabled("acme-app", false);
    await h.ctx.internalAdapter.updateUser(ada.id, { banned: true });
    await h.settle();
    expect(await jobsAt("acme-app")).toHaveLength(1);
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect(new Date((await jobsAt("acme-app"))[0]!.nextAttemptAt as Date).getTime()).toBe(PAUSED_UNTIL.getTime());
    expect([...remote.users.values()][0]).toMatchObject({ active: true }); // not sent while disabled
    await setEnabled("acme-app", true);
    await h.ctx.adapter.updateMany({ model: "scimProvisioningJob", where: [{ field: "targetId", value: "acme-app" }], update: { nextAttemptAt: new Date() } }); // what resume does
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect([...remote.users.values()][0]).toMatchObject({ active: false });
  });

  it("a disabled target's jobs don't hold up anyone else's in the scheduled run", async () => {
    const { h, remote, org, store, setEnabled } = await setup();
    const acme = await org("Acme");
    await store("acme-app", acme.id);
    await setEnabled("acme-app", false);
    for (let i = 0; i < 60; i++) await h.ctx.adapter.create({ model: "scimProvisioningJob", data: { key: `acme-app:u${i}`, targetId: "acme-app", userId: `u${i}`, version: 1, attempts: 0, nextAttemptAt: new Date(0), lockedUntil: new Date(0), failed: false, createdAt: new Date(), updatedAt: new Date() } });
    await h.auth.api.scimProvisioningRun({ body: { limit: 100 } }); // parks them
    const globex = await org("Globex");
    await store("globex-app", globex.id);
    const ada = await h.user("Ada Lovelace");
    await h.ctx.adapter.create({ model: "member", data: { organizationId: globex.id, userId: ada.id, role: "member", createdAt: new Date() } });
    remote.fail({ status: 503 });
    await h.auth.api.scimProvisioningQueue({ body: { userId: ada.id, targetId: "globex-app" } });
    await h.settle();
    await h.ctx.adapter.updateMany({ model: "scimProvisioningJob", where: [{ field: "targetId", value: "globex-app" }], update: { nextAttemptAt: new Date(0) } });
    expect(await h.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 1, busy: 0 });
    expect(remote.users.size).toBe(1);
  });

  it("credentials that no longer open pause the target, say why, and its jobs wait", async () => {
    const { h, remote, org, join, jobsAt } = await setup();
    const error = vi.spyOn(h.ctx.logger, "error");
    const acme = await org("Acme");
    await h.ctx.adapter.create({
      model: TARGET_MODEL,
      data: { targetId: "acme-app", organizationId: acme.id, type: "scim", config: JSON.stringify({ url: "https://app.example.com/scim/v2" }), sealed: await seal("another-secret-that-is-at-least-32-characters", "acme-app", acme.id, { token: remote.token }), enabled: true, createdAt: new Date(), updatedAt: new Date() },
    });
    const ada = await h.user("Ada Lovelace");
    await join(ada.id, acme.id);
    expect(remote.users.size).toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("can't be decrypted"));
    expect(await jobsAt("acme-app")).toHaveLength(1);
  });

  it("a target is seen by every server the moment it's stored (nothing is cached as a list)", async () => {
    const { h, remote, org, store, join } = await setup();
    const acme = await org("Acme");
    const ada = await h.user("Ada Lovelace");
    await join(ada.id, acme.id);
    await store("acme-app", acme.id); // as another server would: straight into the database
    await h.ctx.internalAdapter.updateUser(ada.id, { name: "Ada King" });
    await h.settle();
    expect([...remote.users.values()].map((u) => u.displayName)).toEqual(["Ada King"]);
  });

  it("an error looking up targets never fails the organization write it follows", async () => {
    const { h, org } = await setup();
    const acme = await org("Acme");
    const ada = await h.user("Ada Lovelace");
    const error = vi.spyOn(h.ctx.logger, "error");
    const findMany = h.ctx.adapter.findMany.bind(h.ctx.adapter);
    vi.spyOn(h.ctx.adapter, "findMany").mockImplementation(((a: { model: string }) => (a.model === TARGET_MODEL ? Promise.reject(new Error("database hiccup")) : findMany(a as never))) as never);
    await expect(h.auth.api.addMember({ body: { userId: ada.id, organizationId: acme.id, role: "member" } })).resolves.toBeTruthy();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("could not queue"), expect.anything());
  });
});

describe("setup", () => {
  it("the registry's table exists only with the registry", async () => {
    const tables = async (registry: boolean) => {
      const auth = betterAuth({ database: new DatabaseSync(":memory:") as never, secret: KEY, telemetry: { enabled: false }, plugins: [organization(), scimProvisioning({ targets: [], ...(registry ? { registry: {} } : {}) })] });
      const { toBeCreated } = await getMigrations((await auth.$context).options);
      return toBeCreated.map((t) => t.table);
    };
    expect(await tables(true)).toContain(TARGET_MODEL);
    expect(await tables(false)).not.toContain(TARGET_MODEL);
  });

  it("the registry needs the organization plugin", async () => {
    const auth = betterAuth({ database: new DatabaseSync(":memory:") as never, secret: KEY, telemetry: { enabled: false }, plugins: [scimProvisioning({ targets: [], registry: {} })] });
    await expect(auth.$context).rejects.toThrow(/registry needs Better Auth's organization plugin/);
  });
});

describe("publicUrl", () => {
  const PRIVATE = "must not be a private, loopback, link-local or reserved address";
  it.each([
    ["https://app.example.com/scim/v2", null],
    ["https://8.8.8.8/scim", null],
    ["https://[2606:4700::1111]/scim", null],
    ["http://app.example.com/scim/v2", "must be https"],
    ["https://app.example.com:6379/scim", "must use the standard https port (443)"],
    ["https://app.example.com:443/scim", null],
    ["https://localhost/scim", "must be a public host"],
    ["https://localhost./scim", "must be a public host"],
    ["https://LOCALHOST/scim", "must be a public host"],
    ["https://intranet/scim", "must be a public host"],
    ["https://db.internal/scim", "must be a public host"],
    ["https://printer.local/scim", "must be a public host"],
    ["https://nas.lan/scim", "must be a public host"],
    ["https://nas.home.arpa/scim", "must be a public host"],
    ["https://kubernetes.default.svc/scim", "must be a public host"],
    ...[
      "127.0.0.1", "10.1.2.3", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "198.18.0.1", "192.0.0.1", "192.0.2.1", "203.0.113.5", "0.0.0.0",
      "2130706433", "0x7f.1",
      "[::]", "[::1]", "[fd00::1]", "[fe80::1]", "[fec0::1]", "[ff02::1]", "[100::1]",
      "[::ffff:10.0.0.1]", "[::a00:1]", "[::ffff:0:7f00:1]", "[64:ff9b::a9fe:a9fe]", "[64:ff9b:1::a00:1]", "[2002:a00:1::1]", "[2001:0:4136:e378::1]", "[2001:db8::1]",
    ].map((h) => [`https://${h}/scim`, PRIVATE] as [string, string]),
    ["https://u:p@app.example.com/scim", "must have no credentials or fragment"],
    ["https://app.example.com/scim?x=1", "must have no query"],
  ])("%s", (url, problem) => expect(publicUrl(url)).toBe(problem));

  it("allowHosts makes exceptions, ports included", () => {
    expect(publicUrl("https://scim.internal/v2", ["scim.internal"])).toBeNull();
    expect(publicUrl("https://scim.internal:8443/v2", ["scim.internal"])).toBeNull();
  });

  it("a name that resolves to a private address is refused when the request is made", async () => {
    const inner = vi.fn(async () => new Response(null));
    await expect(guardedFetch([], inner)("https://localhost/scim/v2/Users")).rejects.toThrow(/resolves to a private address/);
    expect(inner).not.toHaveBeenCalled();
    await guardedFetch(["localhost"], inner)("https://localhost/scim/v2/Users");
    expect(inner).toHaveBeenCalledOnce();
  });
});
