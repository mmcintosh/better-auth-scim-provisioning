// The target registry (step 2): targets stored in the database, their credentials sealed, tied to
// one organization, looked up at delivery.
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { scimProvisioning } from "../src";
import { publicUrl, seal, TARGET_MODEL, type StoredCredentials, type StoredSettings, unseal } from "../src/registry";
import { createHost } from "./support/host";
import { mockScim } from "./support/mock-scim";

const KEY = "test-secret-that-is-at-least-32-characters-long";

/** A host with the registry on, a stored-target app, and an organization to own targets. */
async function setup(o: { cacheSeconds?: number } = {}) {
  const remote = mockScim();
  const h = await createHost({ targets: [], registry: { fetch: remote.fetch, ...(o.cacheSeconds === undefined ? {} : { cacheSeconds: o.cacheSeconds }) } });
  const org = (n: string) => h.ctx.adapter.create<Record<string, unknown>, { id: string }>({ model: "organization", data: { name: n, slug: n.toLowerCase(), createdAt: new Date() } });
  const store = async (targetId: string, organizationId: string, settings: StoredSettings = {}, credentials: StoredCredentials = { token: remote.token }, enabled = true) =>
    h.ctx.adapter.create({
      model: TARGET_MODEL,
      data: { targetId, organizationId, type: settings.type ?? "scim", config: JSON.stringify({ url: "https://app.example.com/scim/v2", ...settings }), sealed: await seal(KEY, targetId, organizationId, credentials), enabled, createdAt: new Date(), updatedAt: new Date() },
    });
  const join = async (userId: string, organizationId: string) => {
    await h.auth.api.addMember({ body: { userId, organizationId, role: "member" } });
    await h.settle();
  };
  return { h, remote, org, store, join };
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
});

describe("stored targets", () => {
  it("receive their organization's members only", async () => {
    const { h, remote, org, store, join } = await setup();
    const acme = await org("Acme");
    const globex = await org("Globex");
    await store("acme-app", acme.id);
    const ada = await h.user("Ada Lovelace");
    const bob = await h.user("Bob Builder");
    await join(ada.id, acme.id);
    await join(bob.id, globex.id);
    expect([...remote.users.values()].map((u) => u.displayName)).toEqual(["Ada Lovelace"]);
    // Bob's changes queue nothing for Acme's app: it isn't his organization's.
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

  it("a profile is applied by name, and the stored organization can't be overridden", async () => {
    const { h, remote, org, store, join } = await setup();
    const acme = await org("Acme");
    const globex = await org("Globex");
    // organizationId isn't a stored setting: refused, so the row is paused, never sent Globex's users.
    await store("sneaky", acme.id, { organizationId: globex.id } as never);
    await store("aws", acme.id, { profile: "awsIamIdentityCenter" });
    const ada = await h.user("Ada Lovelace");
    await join(ada.id, globex.id);
    expect(remote.users.size).toBe(0);
    await join(ada.id, acme.id);
    expect(remote.users.size).toBe(1);
    expect(remote.requests.some((r) => r.method === "PATCH" || r.method === "POST")).toBe(true);
  });

  it("a disabled target keeps its jobs without sending, and delivers them once enabled", async () => {
    const { h, remote, org, store, join } = await setup({ cacheSeconds: 0 });
    const acme = await org("Acme");
    await store("acme-app", acme.id, {}, undefined, false);
    const ada = await h.user("Ada Lovelace");
    await join(ada.id, acme.id);
    // Not listed while disabled, so nothing is queued for it by a change...
    expect(remote.users.size).toBe(0);
    await h.ctx.adapter.update({ model: TARGET_MODEL, where: [{ field: "targetId", value: "acme-app" }], update: { enabled: true } });
    await h.auth.api.scimProvisioningReconcile({ body: {} });
    await h.settle();
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect([...remote.users.values()].map((u) => u.displayName)).toEqual(["Ada Lovelace"]);
  });

  it("a queued job for a paused target waits rather than being dropped, and goes out once enabled", async () => {
    const { h, remote, org, store, join } = await setup({ cacheSeconds: 0 });
    const acme = await org("Acme");
    await store("acme-app", acme.id);
    const ada = await h.user("Ada Lovelace");
    remote.fail({ status: 503 });
    await join(ada.id, acme.id); // queued, its first attempt failed
    await h.ctx.adapter.update({ model: TARGET_MODEL, where: [{ field: "targetId", value: "acme-app" }], update: { enabled: false } });
    const due = () => h.ctx.adapter.updateMany({ model: "scimProvisioningJob", where: [{ field: "failed", value: false }], update: { nextAttemptAt: new Date(0), lockedUntil: new Date(0) } });
    await due();
    await h.auth.api.scimProvisioningRun({ body: {} });
    const jobs = await h.jobs();
    expect(jobs).toHaveLength(1);
    expect(new Date(jobs[0]!.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(jobs[0]).toMatchObject({ attempts: 1 }); // not counted as an attempt
    await h.ctx.adapter.update({ model: TARGET_MODEL, where: [{ field: "targetId", value: "acme-app" }], update: { enabled: true } });
    await due();
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect([...remote.users.values()].map((u) => u.displayName)).toEqual(["Ada Lovelace"]);
  });

  it("credentials that no longer open pause the target and say why", async () => {
    const { h, remote, org, join } = await setup();
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
  });

  it("a target stored after the list was cached still gets its jobs delivered", async () => {
    const { h, remote, org, store, join } = await setup({ cacheSeconds: 3600 });
    const acme = await org("Acme");
    await h.user("Warm Cache"); // loads the (empty) list
    await store("acme-app", acme.id);
    const ada = await h.user("Ada Lovelace");
    await join(ada.id, acme.id);
    // The cached list doesn't have it, so a change doesn't queue it; a job queued by id is delivered.
    await h.auth.api.scimProvisioningQueue({ body: { userId: ada.id, targetId: "acme-app" } });
    await h.settle();
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect([...remote.users.values()].map((u) => u.displayName)).toEqual(["Ada Lovelace"]);
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
  it.each([
    ["https://app.example.com/scim/v2", null],
    ["http://app.example.com/scim/v2", "must be https"],
    ["https://localhost/scim", "must be a public host"],
    ["https://intranet/scim", "must be a public host"],
    ["https://db.internal/scim", "must be a public host"],
    ["https://printer.local/scim", "must be a public host"],
    ["https://127.0.0.1/scim", "must not be a private, loopback or link-local address"],
    ["https://10.1.2.3/scim", "must not be a private, loopback or link-local address"],
    ["https://169.254.169.254/latest", "must not be a private, loopback or link-local address"],
    ["https://172.20.0.1/scim", "must not be a private, loopback or link-local address"],
    ["https://192.168.1.1/scim", "must not be a private, loopback or link-local address"],
    ["https://100.64.0.1/scim", "must not be a private, loopback or link-local address"],
    ["https://[::1]/scim", "must not be a private, loopback or link-local address"],
    ["https://[fd00::1]/scim", "must not be a private, loopback or link-local address"],
    ["https://[::ffff:10.0.0.1]/scim", "must not be a private, loopback or link-local address"],
    ["https://8.8.8.8/scim", null],
    ["https://u:p@app.example.com/scim", "must have no credentials or fragment"],
    ["https://app.example.com/scim?x=1", "must have no query"],
  ])("%s", (url, problem) => expect(publicUrl(url)).toBe(problem));

  it("allowHosts makes exceptions", () => expect(publicUrl("https://scim.internal/v2", ["scim.internal"])).toBeNull());
});
