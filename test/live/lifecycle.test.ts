// One test user's whole life against a real SCIM service (SCIM_URL, SCIM_TOKEN), read back from
// the service after each step, then removed there so nothing is left behind.
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins";
import { afterAll, describe, expect, it } from "vitest";
import { scimProvisioning } from "../../src";
import { scimClient } from "../../src/scim-client";

const url = process.env.SCIM_URL;
const token = process.env.SCIM_TOKEN;

describe.skipIf(!url || !token)("live SCIM lifecycle", () => {
  const stamp = Date.now().toString(36);
  const email = `scim-live-${stamp}@example.com`;
  // Built only when the tests run: without credentials the file is skipped, not broken.
  const client = url && token ? scimClient({ url, token }) : (null as unknown as ReturnType<typeof scimClient>);
  const pending = new Set<Promise<unknown>>();
  const created: string[] = [];

  const setup = async () => {
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "live-secret-that-is-at-least-32-characters-long",
      telemetry: { enabled: false },
      database: new DatabaseSync(":memory:"),
      emailAndPassword: { enabled: true },
      advanced: {
        backgroundTasks: {
          handler: (p: Promise<unknown>) => {
            const tracked = p.finally(() => pending.delete(tracked));
            pending.add(tracked);
          },
        },
      },
      plugins: [admin(), scimProvisioning({ targets: [{ id: "live", url: url!, token: token! }], retry: { baseDelayMs: 1000 } })],
    });
    const ctx = await auth.$context;
    await (await getMigrations(ctx.options)).runMigrations();
    return { auth, ctx };
  };
  const settle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
  /** The user as the service has it now. */
  const remote = async (id: string) => {
    const res = await fetch(`${url!.replace(/\/+$/, "")}/Users/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}`, accept: "application/scim+json" } });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
  };

  afterAll(async () => {
    for (const id of created) await client.remove(id).catch((e) => console.log(`cleanup of ${id} failed: ${(e as Error).message}`));
    const left = await client.findByUserName(email).catch(() => null);
    console.log(`cleanup: ${left ? `STILL THERE (${left.id})` : "nothing left at the service"}`);
  });

  it("creates, renames, changes email, bans, unbans, deletes; refuses a reused email", async () => {
    const { auth, ctx } = await setup();
    const jobs = () => ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningJob" });
    const link = async () => (await ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningLink" }))[0];
    const log = (step: string, r: { status: number; body: Record<string, any> | null }) =>
      console.log(`${step}: ${r.status} userName=${r.body?.userName} active=${r.body?.active} name=${JSON.stringify(r.body?.name)} displayName=${r.body?.displayName} externalId=${r.body?.externalId}`);

    // 1. Created, verified.
    const u = await ctx.internalAdapter.createUser({ email, name: "Scim Live Tester", emailVerified: true }, { method: "admin" });
    await settle();
    expect(await jobs()).toEqual([]);
    const l = await link();
    if (!l) throw new Error("no link: the user wasn't provisioned");
    created.push(l.remoteId);
    let r = await remote(l.remoteId);
    log("1 created", r);
    expect(r.body).toMatchObject({ userName: email, active: true, externalId: u.id });

    // 2. Renamed.
    await ctx.internalAdapter.updateUser(u.id, { name: "Scim Renamed Tester" });
    await settle();
    r = await remote(l.remoteId);
    log("2 renamed", r);
    expect(await jobs()).toEqual([]);
    expect(r.body?.displayName ?? r.body?.name?.formatted).toBe("Scim Renamed Tester");

    // 3. Email changed: a new userName for the same account.
    const email2 = `scim-live-${stamp}-2@example.com`;
    await ctx.internalAdapter.updateUser(u.id, { email: email2 });
    await settle();
    r = await remote(l.remoteId);
    log("3 new email", r);
    expect(await jobs()).toEqual([]);
    expect(r.body?.userName).toBe(email2);

    // 4. Banned: deactivated.
    await ctx.internalAdapter.updateUser(u.id, { banned: true });
    await settle();
    r = await remote(l.remoteId);
    log("4 banned", r);
    expect(r.body?.active).toBe(false);

    // 5. Unbanned: active again.
    await ctx.internalAdapter.updateUser(u.id, { banned: false });
    await settle();
    r = await remote(l.remoteId);
    log("5 unbanned", r);
    expect(r.body?.active).toBe(true);

    // 6. Deleted: deactivated, account kept.
    await ctx.internalAdapter.deleteUser(u.id);
    await settle();
    r = await remote(l.remoteId);
    log("6 deleted", r);
    expect(r.body?.active).toBe(false);

    // 7. Someone new signs up with that email: refused, not given the old account (S1-1).
    const other = await ctx.internalAdapter.createUser({ email: email2, name: "Someone Else", emailVerified: true }, { method: "admin" });
    await settle();
    r = await remote(l.remoteId);
    log("7 reused email", r);
    const job = (await jobs()).find((j) => j.userId === other.id);
    console.log(`7 job: failed=${job?.failed} lastError=${job?.lastError}`);
    expect(r.body).toMatchObject({ externalId: u.id, active: false });
    expect(job).toMatchObject({ failed: true });
    void auth;
  });
});
