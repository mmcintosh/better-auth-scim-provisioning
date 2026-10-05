// Google Workspace groups, live: an organization, a team and a role as Google Groups, with their
// members, through a rename, a member leaving, and the organization's deletion. Checked against
// Google's answers to each change (its reads trail its writes, found with users), then everything
// is deleted: the groups, and the users (which free their licences).
// Needs the Google settings in .env.live (see google-workspace.test.ts), and domain-wide
// delegation allowing https://www.googleapis.com/auth/admin.directory.group too.
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin, organization } from "better-auth/plugins";
import { afterAll, describe, expect, it } from "vitest";
import { scimProvisioning } from "../../src";
import { credentials } from "../../src/credentials";
import { GOOGLE_DIRECTORY_URL } from "../../src/google";
import type { GoogleWorkspaceTarget } from "../../src/types";

const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const adminEmail = process.env.GOOGLE_ADMIN_EMAIL;
const domain = process.env.GOOGLE_TEST_DOMAIN;
const orgUnitPath = process.env.GOOGLE_ORG_UNIT || undefined;
const configured = !!(clientEmail && privateKey && adminEmail && domain);

describe.skipIf(!configured)("live Google Workspace groups", () => {
  const stamp = Date.now().toString(36);
  const email = (n: string) => `scim-live-${stamp}-${n}@${domain}`;
  const pending = new Set<Promise<unknown>>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Every change Google accepted, with what it answered. */
  const writes: { method: string; path: string; status: number; body: Record<string, any> | null }[] = [];
  const recording: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const method = init?.method ?? "GET";
    const u = String(input);
    if (res.ok && method !== "GET" && u.startsWith(GOOGLE_DIRECTORY_URL)) writes.push({ method, path: u.slice(GOOGLE_DIRECTORY_URL.length).split("?")[0]!, status: res.status, body: (await res.clone().json().catch(() => null)) as Record<string, any> | null });
    return res;
  };
  const target: GoogleWorkspaceTarget = { id: "workspace", type: "google-workspace", fetch: recording, groups: true, teamGroups: true, roleGroups: ["admin"], google: { clientEmail: clientEmail!, privateKey: privateKey!, adminEmail: adminEmail!, orgUnitPath } };
  const creds = configured
    ? credentials({ type: "google", clientEmail: clientEmail!, privateKey: privateKey!, subject: adminEmail!, scopes: ["https://www.googleapis.com/auth/admin.directory.user", "https://www.googleapis.com/auth/admin.directory.group"] }, {})
    : (null as unknown as ReturnType<typeof credentials>);
  const api = async (method: string, path: string) => fetch(`${GOOGLE_DIRECTORY_URL}${path}`, { method, headers: { ...(await creds.headers()), accept: "application/json" } });

  afterAll(async () => {
    // Everything of this run's: groups by our address prefix and stamp, users by their address.
    const groups = (await (await api("GET", `/groups?customer=my_customer&maxResults=200`)).json().catch(() => ({}))) as { groups?: { id: string; email: string; description?: string }[] };
    const ours = (groups.groups ?? []).filter((g) => writes.some((w) => w.method === "POST" && w.path === "/groups" && w.body?.id === g.id));
    for (const g of ours) console.log(`cleanup group ${g.email}: ${(await api("DELETE", `/groups/${g.id}`)).status}`);
    for (const w of writes) if (w.method === "POST" && w.path === "/users" && w.body?.id) {
      for (let i = 0; i < 12; i++) {
        const r = await api("DELETE", `/users/${w.body.id}`);
        if (r.ok || r.status === 404) {
          console.log(`cleanup user ${w.body.primaryEmail}: ${r.status}`);
          break;
        }
        await sleep(5000);
      }
    }
  }, 300_000);

  it("an organization, a team and a role as Google Groups: members, rename, leaving, removal", async () => {
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
      plugins: [admin(), organization({ teams: { enabled: true } }), scimProvisioning({ targets: [target], retry: { baseDelayMs: 1000 } })],
    });
    const ctx = await auth.$context;
    await (await getMigrations(ctx.options)).runMigrations();
    const jobs = () => ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningJob" });
    const settle = async () => {
      for (const until = Date.now() + 300_000; Date.now() < until; ) {
        while (pending.size) await Promise.allSettled([...pending]);
        if (!(await jobs()).some((j) => !j.failed)) return;
        await sleep(2000);
        await auth.api.scimProvisioningRun({ body: {} });
      }
    };
    const googleUserId = (address: string) => [...writes].reverse().find((w) => w.path === "/users" && w.body?.primaryEmail === address)?.body?.id as string;
    /** A group's members as the accepted writes leave them. */
    const membersOf = (groupId: string) => {
      const set = new Set<string>();
      for (const w of writes) {
        if (w.method === "POST" && w.path === `/groups/${groupId}/members` && w.body?.id) set.add(w.body.id);
        const del = w.method === "DELETE" ? new RegExp(`^/groups/${groupId}/members/(.+)$`).exec(w.path) : null;
        if (del) set.delete(decodeURIComponent(del[1]!));
      }
      return [...set].sort();
    };
    const groupCreated = (address: string) => writes.find((w) => w.method === "POST" && w.path === "/groups" && w.body?.email === address)?.body;
    const lastName = (groupId: string) => [...writes].reverse().find((w) => w.method === "PATCH" && w.path === `/groups/${groupId}`)?.body?.name;

    const s = await auth.api.signUpEmail({ body: { email: email("owner"), password: "correct-horse-battery", name: "Olive Owner" } });
    await ctx.internalAdapter.updateUser(s.user.id, { emailVerified: true });
    await settle();
    const res = await auth.api.signInEmail({ body: { email: email("owner"), password: "correct-horse-battery" }, asResponse: true });
    const headers = { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
    const org = await auth.api.createOrganization({ body: { name: `SCIM Live ${stamp}`, slug: `scim-live-${stamp}` }, headers });
    const ada = await ctx.internalAdapter.createUser({ email: email("ada"), name: "Ada Lovelace", emailVerified: true }, { method: "admin" });
    const bob = await ctx.internalAdapter.createUser({ email: email("bob"), name: "Bob Babbage", emailVerified: true }, { method: "admin" });
    await auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "member" } });
    await auth.api.addMember({ body: { userId: bob.id, organizationId: org!.id, role: "admin" } });
    const team = await auth.api.createTeam({ body: { name: "Red", organizationId: org!.id }, headers });
    await auth.api.addTeamMember({ body: { teamId: team.id, userId: ada.id }, headers });
    await settle();
    console.log("jobs after setup:", JSON.stringify((await jobs()).map((j) => [j.kind, j.failed, j.lastError])));
    expect(await jobs()).toEqual([]);

    const [gOwner, gAda, gBob] = [googleUserId(email("owner")), googleUserId(email("ada")), googleUserId(email("bob"))];
    const orgGroup = groupCreated(`ba-${org!.id.toLowerCase()}@${domain}`)!;
    const teamGroup = groupCreated(`ba-team-${team.id.toLowerCase()}@${domain}`)!;
    const adminGroup = groupCreated(`ba-role-${org!.id.toLowerCase()}-admin@${domain}`)!;
    console.log("groups:", JSON.stringify([orgGroup, teamGroup, adminGroup].map((g) => g && { email: g.email, name: g.name })));
    expect(orgGroup).toMatchObject({ name: `SCIM Live ${stamp}`, description: expect.stringContaining(`externalId: ${org!.id}`) });
    expect(teamGroup).toMatchObject({ name: `SCIM Live ${stamp} / Red` });
    expect(adminGroup).toMatchObject({ name: `SCIM Live ${stamp} / admin` });
    expect(membersOf(orgGroup.id)).toEqual([gOwner, gAda, gBob].sort());
    expect(membersOf(teamGroup.id)).toEqual([gAda]);
    expect(membersOf(adminGroup.id)).toEqual([gBob]);

    await auth.api.updateOrganization({ body: { organizationId: org!.id, data: { name: `SCIM Live ${stamp} Renamed` } }, headers });
    await settle();
    expect(await jobs()).toEqual([]);
    expect(lastName(orgGroup.id)).toBe(`SCIM Live ${stamp} Renamed`);
    expect(lastName(teamGroup.id)).toBe(`SCIM Live ${stamp} Renamed / Red`);

    await auth.api.removeMember({ body: { memberIdOrEmail: email("ada"), organizationId: org!.id }, headers });
    await settle();
    expect(await jobs()).toEqual([]);
    expect(membersOf(orgGroup.id)).toEqual([gOwner, gBob].sort());
    expect(membersOf(teamGroup.id)).toEqual([]);

    await auth.api.deleteOrganization({ body: { organizationId: org!.id }, headers });
    await settle();
    expect(await jobs()).toEqual([]);
    for (const g of [orgGroup, teamGroup, adminGroup]) expect(writes.some((w) => w.method === "DELETE" && w.path === `/groups/${g.id}`)).toBe(true);
  }, 1_800_000);
});
