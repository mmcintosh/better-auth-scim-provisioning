// AWS IAM Identity Center, live, with the awsIamIdentityCenter profile: a user's whole life, then
// organizations, teams and roles as groups (members read through the users filter, changed by
// PATCH), and a group of over 100 members (AWS takes at most 100 member changes per request).
// Everything is read back from AWS over SCIM, and everything the test made is deleted at the end.
// Runs only with AWS_SCIM_URL and AWS_SCIM_TOKEN (in .env.live): Identity Center → Settings →
// Identity source → Automatic provisioning.
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin, organization } from "better-auth/plugins";
import { afterAll, describe, expect, it } from "vitest";
import { awsIamIdentityCenter, scimProvisioning } from "../../src";

const url = process.env.AWS_SCIM_URL?.replace(/\/+$/, "");
const token = process.env.AWS_SCIM_TOKEN;
const configured = !!(url && token);

describe.skipIf(!configured)("live AWS IAM Identity Center", () => {
  const stamp = Date.now().toString(36);
  const email = (n: string) => `scim-live-${stamp}-${n}@example.com`;
  const pending = new Set<Promise<unknown>>();
  const made = { users: new Set<string>(), groups: new Set<string>() };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const headers = () => ({ authorization: `Bearer ${token}`, accept: "application/scim+json", "content-type": "application/scim+json" });

  /** A SCIM resource as AWS has it now, or null if it's gone. */
  const get = async (path: string) => {
    const res = await fetch(`${url}${path}`, { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as Record<string, any>;
  };
  /** A group's members, as AWS lists them: GET /Groups doesn't, so through the users filter, a cursor page at a time. */
  const members = async (groupId: string): Promise<string[]> => {
    const ids: string[] = [];
    let cursor = "";
    for (;;) {
      // `cursor` on the first request too, even empty: without it AWS returns one page of at most
      // 100, ignores startIndex and gives no nextCursor (found live, 2026-10-05).
      const q = new URLSearchParams({ filter: `groups.value eq "${groupId}"`, count: "100", cursor });
      const page = (await get(`/Users?${q}`)) as { Resources?: { id: string }[]; nextCursor?: string } | null;
      for (const r of page?.Resources ?? []) ids.push(r.id);
      if (!page?.nextCursor) return ids.sort();
      cursor = page.nextCursor;
    }
  };

  const setup = async (target: Record<string, unknown>) => {
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
      plugins: [admin(), organization({ teams: { enabled: true }, membershipLimit: 500 }), scimProvisioning({ targets: [awsIamIdentityCenter({ id: "aws", url: url!, token: token!, ...target })], retry: { baseDelayMs: 1000 } })],
    });
    const ctx = await auth.$context;
    await (await getMigrations(ctx.options)).runMigrations();
    const jobs = () => ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningJob" });
    /** Every background delivery, then the scheduled run until nothing is due. */
    const settle = async () => {
      for (const until = Date.now() + 300_000; Date.now() < until; ) {
        while (pending.size) await Promise.allSettled([...pending]);
        if (!(await jobs()).some((j) => !j.failed)) break;
        await sleep(1500);
        await auth.api.scimProvisioningRun({ body: {} });
      }
      for (const l of await ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningLink" })) if (l.remoteId) made.users.add(l.remoteId);
      for (const l of await ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningGroupLink" })) if (l.remoteId) made.groups.add(l.remoteId);
    };
    const remoteOf = async (userId: string) => (await ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningLink" })).find((l) => l.userId === userId)?.remoteId as string;
    const groupOf = async (key: string) => (await ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningGroupLink" })).find((l) => l.key === `aws:${key}`)?.remoteId as string | undefined;
    // Each part has its own owner: an owner from an earlier part is another app's user to AWS.
    const owner = async (label: string) => {
      const s = await auth.api.signUpEmail({ body: { email: email(`owner-${label}`), password: "correct-horse-battery", name: "Olive Owner" } });
      await ctx.internalAdapter.updateUser(s.user.id, { emailVerified: true });
      await settle();
      const res = await auth.api.signInEmail({ body: { email: email(`owner-${label}`), password: "correct-horse-battery" }, asResponse: true });
      return { id: s.user.id, headers: { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } };
    };
    const user = (n: string, name: string) => ctx.internalAdapter.createUser({ email: email(n), name, emailVerified: true }, { method: "admin" });
    return { auth, ctx, jobs, settle, remoteOf, groupOf, owner, user };
  };

  afterAll(async () => {
    // Also everything named with this run's stamp: a part that fails before settling hasn't
    // recorded what its background deliveries made (found when one failed at its 101st member).
    const list = async (path: string) => {
      const all: Record<string, any>[] = [];
      for (let start = 1; ; start += 100) {
        const page = (await get(`${path}${path.includes("?") ? "&" : "?"}startIndex=${start}&count=100`).catch(() => null)) as { Resources?: Record<string, any>[]; totalResults?: number } | null;
        all.push(...(page?.Resources ?? []));
        if (!page?.Resources?.length || all.length >= (page.totalResults ?? 0)) return all;
      }
    };
    for (const u of await list("/Users")) if (String(u.userName).startsWith(`scim-live-${stamp}-`)) made.users.add(u.id);
    for (const g of await list("/Groups")) if (String(g.displayName).includes(stamp)) made.groups.add(g.id);
    for (const id of made.groups) await fetch(`${url}/Groups/${id}`, { method: "DELETE", headers: headers() }).catch(() => {});
    for (const id of made.users) await fetch(`${url}/Users/${id}`, { method: "DELETE", headers: headers() }).catch(() => {});
    let left = 0;
    for (const id of made.users) if (await get(`/Users/${id}`).catch(() => null)) left++;
    for (const id of made.groups) if (await get(`/Groups/${id}`).catch(() => null)) left++;
    console.log(`cleanup: ${made.users.size} users and ${made.groups.size} groups deleted; ${left} still there`);
  }, 600_000);

  it("a user's life: created, renamed, new email, banned, unbanned, deleted; a reused email refused", async () => {
    const h = await setup({});
    const u = await h.user("ada", "Ada Lovelace");
    await h.settle();
    const id = await h.remoteOf(u.id);
    let r = await get(`/Users/${id}`);
    console.log("1 created", JSON.stringify({ userName: r?.userName, active: r?.active, name: r?.name, displayName: r?.displayName, externalId: r?.externalId, emails: r?.emails }));
    expect(await h.jobs()).toEqual([]);
    expect(r).toMatchObject({ userName: email("ada"), active: true, displayName: "Ada Lovelace", externalId: u.id, name: { givenName: "Ada", familyName: "Lovelace" } });

    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Byron" });
    await h.settle();
    r = await get(`/Users/${id}`);
    expect(await h.jobs()).toEqual([]);
    expect(r).toMatchObject({ displayName: "Ada Byron", name: { familyName: "Byron" } });

    await h.ctx.internalAdapter.updateUser(u.id, { email: email("ada2") });
    await h.settle();
    r = await get(`/Users/${id}`);
    expect(await h.jobs()).toEqual([]);
    expect(r?.userName).toBe(email("ada2"));

    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect((await get(`/Users/${id}`))?.active).toBe(false);
    await h.ctx.internalAdapter.updateUser(u.id, { banned: false });
    await h.settle();
    expect((await get(`/Users/${id}`))?.active).toBe(true);

    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect((await get(`/Users/${id}`))?.active).toBe(false);

    const other = await h.ctx.internalAdapter.createUser({ email: email("ada2"), name: "Someone Else", emailVerified: true }, { method: "admin" });
    await h.settle();
    const job = (await h.jobs()).find((j) => j.userId === other.id);
    console.log(`reused email: failed=${job?.failed} lastError=${job?.lastError}`);
    expect(job).toMatchObject({ failed: true });
    expect(await get(`/Users/${id}`)).toMatchObject({ externalId: u.id, active: false });
  }, 900_000);

  it("organizations, teams and roles as groups: members, rename, leaving, removal", async () => {
    const h = await setup({ groups: true, teamGroups: true, roleGroups: ["admin"] });
    const o = await h.owner("groups");
    const org = await h.auth.api.createOrganization({ body: { name: `SCIM Live ${stamp}`, slug: `scim-live-${stamp}` }, headers: o.headers });
    const ada = await h.user("g-ada", "Ada Lovelace");
    const bob = await h.user("g-bob", "Bob Babbage");
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "member" } });
    await h.auth.api.addMember({ body: { userId: bob.id, organizationId: org!.id, role: "admin" } });
    const team = await h.auth.api.createTeam({ body: { name: "Red", organizationId: org!.id }, headers: o.headers });
    await h.auth.api.addTeamMember({ body: { teamId: team.id, userId: ada.id }, headers: o.headers });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    const [rOwner, rAda, rBob] = [await h.remoteOf(o.id), await h.remoteOf(ada.id), await h.remoteOf(bob.id)];
    const gOrg = (await h.groupOf(`group:${org!.id}`))!;
    const gTeam = (await h.groupOf(`team:${team.id}`))!;
    const gAdmin = (await h.groupOf(`role:${org!.id}:admin`))!;
    console.log("groups", JSON.stringify({ org: (await get(`/Groups/${gOrg}`))?.displayName, team: (await get(`/Groups/${gTeam}`))?.displayName, admin: (await get(`/Groups/${gAdmin}`))?.displayName }));
    expect((await get(`/Groups/${gOrg}`))?.displayName).toBe(`SCIM Live ${stamp}`);
    expect(await members(gOrg)).toEqual([rOwner, rAda, rBob].sort());
    expect(await members(gTeam)).toEqual([rAda]);
    expect(await members(gAdmin)).toEqual([rBob]);

    await h.auth.api.updateOrganization({ body: { organizationId: org!.id, data: { name: `SCIM Live ${stamp} Renamed` } }, headers: o.headers });
    await h.settle();
    expect((await get(`/Groups/${gOrg}`))?.displayName).toBe(`SCIM Live ${stamp} Renamed`);
    expect((await get(`/Groups/${gTeam}`))?.displayName).toBe(`SCIM Live ${stamp} Renamed / Red`);

    await h.auth.api.removeMember({ body: { memberIdOrEmail: email("g-ada"), organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(await members(gOrg)).toEqual([rOwner, rBob].sort());
    expect(await members(gTeam)).toEqual([]);

    await h.auth.api.deleteOrganization({ body: { organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    for (const g of [gOrg, gTeam, gAdmin]) expect(await get(`/Groups/${g}`)).toBeNull();
  }, 900_000);

  it("a group of over 100 members is created in batches and changed by a diff", async () => {
    const h = await setup({ groups: true });
    const o = await h.owner("big");
    const org = await h.auth.api.createOrganization({ body: { name: `SCIM Live Big ${stamp}`, slug: `scim-live-big-${stamp}` }, headers: o.headers });
    const people = [];
    for (let i = 0; i < 104; i++) {
      const p = await h.user(`big-${i}`, `Big Person${i}`);
      people.push(p);
      await h.auth.api.addMember({ body: { userId: p.id, organizationId: org!.id, role: "member" } });
    }
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    const gOrg = (await h.groupOf(`group:${org!.id}`))!;
    expect(await members(gOrg)).toHaveLength(105);

    for (const p of people.slice(0, 3)) await h.auth.api.removeMember({ body: { memberIdOrEmail: p.email, organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(await members(gOrg)).toHaveLength(102);

    await h.auth.api.deleteOrganization({ body: { organizationId: org!.id }, headers: o.headers });
    await h.settle();
    expect(await get(`/Groups/${gOrg}`)).toBeNull();
  }, 1_800_000);
});
