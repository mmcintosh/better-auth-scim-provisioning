// One test user's whole life in a real Google Workspace, checked against what Google answered to
// each change, then deleted there so nothing is left behind (and its licence is freed). Not read
// back: for a new user, Google's reads trail its writes by a minute or more and can even go
// backwards (found live), while each change's answer is the user as Google now has it. Runs only
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
  /** Every create and change Google accepted, with the user it answered with. */
  const writes: { method: string; user: Record<string, any> }[] = [];
  const recording: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const method = init?.method ?? "GET";
    if (res.ok && (method === "POST" || method === "PATCH") && String(input).startsWith(GOOGLE_DIRECTORY_URL)) {
      const user = (await res.clone().json().catch(() => null)) as Record<string, any> | null;
      if (user?.id) writes.push({ method, user });
    }
    return res;
  };
  const target: GoogleWorkspaceTarget = { id: "workspace", type: "google-workspace", fetch: recording, google: { clientEmail: clientEmail!, privateKey: privateKey!, adminEmail: adminEmail!, orgUnitPath } };
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

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** The user as Google has it now (by id or email), or null. A new user takes a few seconds to show by id, so a 404 is asked again for up to 20 s. */
  const remote = async (key: string, wait = true) => {
    for (let i = 0; ; i++) {
      const res = await fetch(`${GOOGLE_DIRECTORY_URL}/users/${encodeURIComponent(key)}`, { headers: { ...(await creds.headers()), accept: "application/json" } });
      if (res.ok) return (await res.json()) as Record<string, any>;
      if (!wait || res.status !== 404 || i >= 10) return null;
      await sleep(2000);
    }
  };

  afterAll(async () => {
    // A user created moments ago can't be deleted yet (412): asked again for up to a minute.
    for (const id of created) {
      for (let i = 0; ; i++) {
        try {
          await client.remove(id);
          break;
        } catch (e) {
          if (i >= 12 || !/412|creation is not complete/.test((e as Error).message)) {
            console.log(`cleanup of ${id} failed: ${(e as Error).message}`);
            break;
          }
          await sleep(5000);
        }
      }
    }
    for (const e of [email, email2]) {
      // A deleted user still shows for a few seconds: looked at until it's gone, for up to 30 s.
      let left = await remote(e, false).catch(() => null);
      for (let i = 0; left && i < 10; i++) {
        await sleep(3000);
        left = await remote(e, false).catch(() => null);
      }
      console.log(`cleanup ${e}: ${left ? `STILL THERE (${left.id}, ${left.primaryEmail})` : "nothing left in the Workspace"}`);
    }
  }, 300_000);

  it("creates, renames, changes email, suspends, unsuspends, deletes; refuses a reused email and an alias", async () => {
    const { auth, ctx } = await setup();
    const jobs = () => ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningJob" });
    /** Every background delivery, then the scheduled run until nothing is due: Google's directory can lag for minutes. */
    const settle = async () => {
      for (const until = Date.now() + 240_000; Date.now() < until; ) {
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
    /** The user as Google answered the last accepted change to it; logged. */
    const seen = (step: string, id: string) => {
      const g = [...writes].reverse().find((w) => w.user.id === id)?.user ?? null;
      log(step, g);
      return g;
    };

    // 1. Created, verified: in the org unit, marked ours.
    const u = await ctx.internalAdapter.createUser({ email, name: "Scim Live Tester", emailVerified: true }, { method: "admin" });
    await settle();
    const l = await link(u.id);
    if (!l?.remoteId) throw new Error(`not provisioned: ${JSON.stringify(await jobs())}`);
    created.add(l.remoteId);
    let g = await seen("1 created", l.remoteId);
    expect(await jobs()).toEqual([]);
    expect(g).toMatchObject({ primaryEmail: email, suspended: false, name: { givenName: "Scim Live", familyName: "Tester" } });
    expect(ours(g)).toBe(u.id);
    if (orgUnitPath) expect(g?.orgUnitPath).toBe(orgUnitPath);

    // 2. Renamed: the names change, the org unit doesn't.
    await ctx.internalAdapter.updateUser(u.id, { name: "Scim Renamed Tester" });
    await settle();
    g = await seen("2 renamed", l.remoteId);
    expect(await jobs()).toEqual([]);
    expect(g?.name).toMatchObject({ givenName: "Scim Renamed", familyName: "Tester" });
    if (orgUnitPath) expect(g?.orgUnitPath).toBe(orgUnitPath);

    // 3. Email changed: a new primary email for the same account (Google keeps the old one as an alias).
    await ctx.internalAdapter.updateUser(u.id, { email: email2 });
    await settle();
    g = await seen("3 new email", l.remoteId);
    expect(await jobs()).toEqual([]);
    expect(g?.primaryEmail).toBe(email2);

    // 4. Banned: suspended.
    await ctx.internalAdapter.updateUser(u.id, { banned: true });
    await settle();
    g = await seen("4 banned", l.remoteId);
    expect(g?.suspended).toBe(true);

    // 5. Unbanned: active again.
    await ctx.internalAdapter.updateUser(u.id, { banned: false });
    await settle();
    g = await seen("5 unbanned", l.remoteId);
    expect(g?.suspended).toBe(false);

    // 6. Deleted here: suspended there, account kept (deprovision "deactivate").
    await ctx.internalAdapter.deleteUser(u.id);
    await settle();
    g = await seen("6 deleted", l.remoteId);
    expect(g?.suspended).toBe(true);

    // 7. Someone new with that email: refused, not given the old account (nothing written to it).
    const before7 = writes.length;
    const other = await ctx.internalAdapter.createUser({ email: email2, name: "Someone Else", emailVerified: true }, { method: "admin" });
    await settle();
    g = await seen("7 reused email", l.remoteId);
    const job7 = (await jobs()).find((j) => j.userId === other.id);
    console.log(`7 job: failed=${job7?.failed} lastError=${job7?.lastError}`);
    expect(job7).toMatchObject({ failed: true });
    expect(writes.slice(before7)).toEqual([]);
    expect(ours(g)).toBe(u.id);
    expect(g?.suspended).toBe(true);

    // 8. Someone new with the first email, now that account's alias: refused, nothing created.
    const before8 = writes.length;
    const third = await ctx.internalAdapter.createUser({ email, name: "Alias Person", emailVerified: true }, { method: "admin" });
    await settle();
    const job8 = (await jobs()).find((j) => j.userId === third.id);
    console.log(`8 job: failed=${job8?.failed} lastError=${job8?.lastError}`);
    for (const x of await ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningLink" })) if (x.remoteId) created.add(x.remoteId);
    expect(job8).toMatchObject({ failed: true });
    expect(writes.slice(before8)).toEqual([]);
  }, 1_800_000);
});
