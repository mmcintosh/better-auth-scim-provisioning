// One test user's whole life in a real Google Workspace, read back from the Directory API after
// each step, then deleted there so nothing is left behind (and its licence is freed). Runs only
// with GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_ADMIN_EMAIL and GOOGLE_TEST_DOMAIN set
// (in .env.live); GOOGLE_ORG_UNIT (e.g. "/SCIM Test") is where the test user is made.
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins";
import { afterAll, describe, expect, it } from "vitest";
import { scimProvisioning } from "../../src";
import { credentials } from "../../src/credentials";
import { GOOGLE_DIRECTORY_URL, googleWorkspaceClient } from "../../src/google";
import type { GoogleWorkspaceTarget } from "../../src/types";

const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
// A PEM in an env file usually has its line breaks written as "\n".
const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const adminEmail = process.env.GOOGLE_ADMIN_EMAIL;
const domain = process.env.GOOGLE_TEST_DOMAIN;
const orgUnitPath = process.env.GOOGLE_ORG_UNIT || undefined;
const configured = !!(clientEmail && privateKey && adminEmail && domain);

describe.skipIf(!configured)("live Google Workspace lifecycle", () => {
  const stamp = Date.now().toString(36);
  const email = `scim-live-${stamp}@${domain}`;
  const email2 = `scim-live-${stamp}-2@${domain}`;
  const target: GoogleWorkspaceTarget = { id: "workspace", type: "google-workspace", google: { clientEmail: clientEmail!, privateKey: privateKey!, adminEmail: adminEmail!, orgUnitPath } };
  // Built only when the tests run: without credentials the file is skipped, not broken.
  const client = configured ? googleWorkspaceClient(target) : (null as unknown as ReturnType<typeof googleWorkspaceClient>);
  const creds = configured
    ? credentials({ type: "google", clientEmail: clientEmail!, privateKey: privateKey!, subject: adminEmail!, scopes: ["https://www.googleapis.com/auth/admin.directory.user"] }, {})
    : (null as unknown as ReturnType<typeof credentials>);
  const pending = new Set<Promise<unknown>>();
  const created = new Set<string>();

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
      plugins: [admin(), scimProvisioning({ targets: [target], retry: { baseDelayMs: 1000 } })],
    });
    const ctx = await auth.$context;
    await (await getMigrations(ctx.options)).runMigrations();
    return { auth, ctx };
  };

  /** The user as Google has it now (by id or email), or null. */
  const remote = async (key: string) => {
    const res = await fetch(`${GOOGLE_DIRECTORY_URL}/users/${encodeURIComponent(key)}`, { headers: { ...(await creds.headers()), accept: "application/json" } });
    return res.ok ? ((await res.json()) as Record<string, any>) : null;
  };

  afterAll(async () => {
    for (const id of created) await client.remove(id).catch((e) => console.log(`cleanup of ${id} failed: ${(e as Error).message}`));
    for (const e of [email, email2]) {
      const left = await remote(e).catch(() => null);
      console.log(`cleanup ${e}: ${left ? `STILL THERE (${left.id}, ${left.primaryEmail})` : "nothing left in the Workspace"}`);
    }
  });

  it("creates, renames, changes email, suspends, unsuspends, deletes; refuses a reused email and an alias", async () => {
    const { auth, ctx } = await setup();
    const jobs = () => ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningJob" });
    /** Every background delivery, then the scheduled run until nothing is due (Google's directory can lag a moment). */
    const settle = async () => {
      for (let i = 0; i < 15; i++) {
        while (pending.size) await Promise.allSettled([...pending]);
        if (!(await jobs()).some((j) => !j.failed)) return;
        await new Promise((r) => setTimeout(r, 2000));
        await auth.api.scimProvisioningRun({ body: {} });
      }
    };
    const link = async (userId: string) => (await ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningLink" })).find((l) => l.userId === userId);
    const log = (step: string, g: Record<string, any> | null) =>
      console.log(`${step}: primaryEmail=${g?.primaryEmail} suspended=${g?.suspended} name=${JSON.stringify(g?.name)} orgUnitPath=${g?.orgUnitPath} externalIds=${JSON.stringify(g?.externalIds)} aliases=${JSON.stringify(g?.aliases)}`);
    const ours = (g: Record<string, any> | null) => g?.externalIds?.find((x: any) => x.type === "custom" && x.customType === "better-auth")?.value;

    // 1. Created, verified: in the org unit, marked ours.
    const u = await ctx.internalAdapter.createUser({ email, name: "Scim Live Tester", emailVerified: true }, { method: "admin" });
    await settle();
    const l = await link(u.id);
    if (!l?.remoteId) throw new Error(`not provisioned: ${JSON.stringify(await jobs())}`);
    created.add(l.remoteId);
    let g = await remote(l.remoteId);
    log("1 created", g);
    expect(await jobs()).toEqual([]);
    expect(g).toMatchObject({ primaryEmail: email, suspended: false, name: { givenName: "Scim", familyName: "Live Tester" } });
    expect(ours(g)).toBe(u.id);
    if (orgUnitPath) expect(g?.orgUnitPath).toBe(orgUnitPath);

    // 2. Renamed: the names change, the org unit doesn't.
    await ctx.internalAdapter.updateUser(u.id, { name: "Scim Renamed Tester" });
    await settle();
    g = await remote(l.remoteId);
    log("2 renamed", g);
    expect(await jobs()).toEqual([]);
    expect(g?.name).toMatchObject({ givenName: "Scim", familyName: "Renamed Tester" });
    if (orgUnitPath) expect(g?.orgUnitPath).toBe(orgUnitPath);

    // 3. Email changed: a new primary email for the same account (Google keeps the old one as an alias).
    await ctx.internalAdapter.updateUser(u.id, { email: email2 });
    await settle();
    g = await remote(l.remoteId);
    log("3 new email", g);
    expect(await jobs()).toEqual([]);
    expect(g?.primaryEmail).toBe(email2);

    // 4. Banned: suspended.
    await ctx.internalAdapter.updateUser(u.id, { banned: true });
    await settle();
    g = await remote(l.remoteId);
    log("4 banned", g);
    expect(g?.suspended).toBe(true);

    // 5. Unbanned: active again.
    await ctx.internalAdapter.updateUser(u.id, { banned: false });
    await settle();
    g = await remote(l.remoteId);
    log("5 unbanned", g);
    expect(g?.suspended).toBe(false);

    // 6. Deleted here: suspended there, account kept (deprovision "deactivate").
    await ctx.internalAdapter.deleteUser(u.id);
    await settle();
    g = await remote(l.remoteId);
    log("6 deleted", g);
    expect(g?.suspended).toBe(true);

    // 7. Someone new with that email: refused, not given the old account.
    const other = await ctx.internalAdapter.createUser({ email: email2, name: "Someone Else", emailVerified: true }, { method: "admin" });
    await settle();
    g = await remote(l.remoteId);
    log("7 reused email", g);
    const job7 = (await jobs()).find((j) => j.userId === other.id);
    console.log(`7 job: failed=${job7?.failed} lastError=${job7?.lastError}`);
    expect(job7).toMatchObject({ failed: true });
    expect(ours(g)).toBe(u.id);
    expect(g?.suspended).toBe(true);

    // 8. Someone new with the first email, now that account's alias: refused, nothing created.
    const third = await ctx.internalAdapter.createUser({ email, name: "Alias Person", emailVerified: true }, { method: "admin" });
    await settle();
    const job8 = (await jobs()).find((j) => j.userId === third.id);
    console.log(`8 job: failed=${job8?.failed} lastError=${job8?.lastError}`);
    for (const x of await ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningLink" })) if (x.remoteId) created.add(x.remoteId);
    expect(job8).toMatchObject({ failed: true });
    expect((await remote(email))?.id).toBe(l.remoteId);
  });
});
