// Microsoft Entra ID, live, through Microsoft Graph: a user's whole life (created with our id as
// onPremisesImmutableId, renamed, a new email, disabled with sessions revoked, enabled, disabled
// when deleted), delete mode (the recycle bin, then restored when the user is back), the
// Enterprise User attributes with a manager, the `attributes` fields (title, phones, address) set
// and cleared, and drift detection a page at a time through Graph's own next links. Everything is
// read back from Graph, and everything the test made is deleted and purged at the end. Graph's
// replicas lag for seconds after a write, so reads are retried until they agree.
// A deprovisioning is followed by a confirm check a minute later, which this waits for: about 10 minutes in all.
// Runs only with ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET and ENTRA_TEST_DOMAIN (a
// verified domain of the tenant, such as its <name>.onmicrosoft.com) in .env.live: an app
// registration with the Graph application permission User.ReadWrite.All, admin consented. With
// ENTRA_FEDERATED_DOMAIN too, a user is also created on that federated domain (no password).
// Use a test tenant: users are named scim-live-<stamp>-*, and only those are removed.
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins";
import { afterAll, describe, expect, it } from "vitest";
import { scimProvisioning } from "../../src";

const tenantId = process.env.ENTRA_TENANT_ID;
const clientId = process.env.ENTRA_CLIENT_ID;
const clientSecret = process.env.ENTRA_CLIENT_SECRET;
const domain = process.env.ENTRA_TEST_DOMAIN;
const federated = process.env.ENTRA_FEDERATED_DOMAIN;
const configured = !!(tenantId && clientId && clientSecret && domain);
const G = "https://graph.microsoft.com/v1.0";
const SELECT = "id,userPrincipalName,displayName,givenName,surname,accountEnabled,onPremisesImmutableId,employeeId,department,companyName,employeeOrgData,jobTitle,businessPhones,mobilePhone,streetAddress,city,state,postalCode,country";

describe.skipIf(!configured)("live Microsoft Entra ID", { timeout: 600_000 }, () => {
  const stamp = Date.now().toString(36);
  const email = (n: string, d = domain) => `scim-live-${stamp}-${n}@${d}`;
  const pending = new Set<Promise<unknown>>();
  /** Every Entra account the plugin linked, for the cleanup: a lookup by name lags (the last user made was missed). */
  const made = new Set<string>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let token = "";

  const graph = async (method: string, path: string, body?: unknown) => {
    if (!token) {
      const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId!, client_secret: clientSecret!, scope: "https://graph.microsoft.com/.default" }),
      });
      token = ((await res.json()) as { access_token: string }).access_token;
    }
    const res = await fetch(`${G}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : method === "POST" ? { body: "{}" } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any> | null };
  };
  /** The user as Graph has them, once a read agrees with `check` (replicas lag); or null if gone. */
  const read = async (id: string, check: (u: Record<string, any> | null) => boolean = () => true) => {
    let last: Record<string, any> | null = null;
    for (let i = 0; i < 20; i++) {
      const r = await graph("GET", `/users/${id}?$select=${SELECT}`);
      last = r.status === 404 ? null : r.json;
      if (check(last)) return last;
      await sleep(3000);
    }
    return last;
  };
  /** The user's manager's id, once a read gives `want` (replicas lag here too). */
  const managerOf = async (id: string, want: string | null) => {
    let last: string | null = null;
    for (let i = 0; i < 20; i++) {
      last = (await graph("GET", `/users/${id}/manager?$select=id`)).json?.id ?? null;
      if (last === want) return last;
      await sleep(3000);
    }
    return last;
  };

  const setup = async (target: Record<string, unknown>, userFields?: Record<string, { type: "string" }>) => {
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "live-secret-that-is-at-least-32-characters-long",
      telemetry: { enabled: false },
      database: new DatabaseSync(":memory:"),
      emailAndPassword: { enabled: true },
      ...(userFields ? { user: { additionalFields: Object.fromEntries(Object.entries(userFields).map(([k, v]) => [k, { ...v, required: false }])) } } : {}),
      advanced: {
        backgroundTasks: {
          handler: (p: Promise<unknown>) => {
            const tracked = p.finally(() => pending.delete(tracked));
            pending.add(tracked);
          },
        },
      },
      plugins: [admin(), scimProvisioning({ targets: [{ id: "entra", type: "entra-id", entra: { tenantId: tenantId!, clientId: clientId!, clientSecret: clientSecret! }, ...target } as never], retry: { baseDelayMs: 1000 } })],
    });
    const ctx = await auth.$context;
    await (await getMigrations(ctx.options)).runMigrations();
    const jobs = () => ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningJob" });
    /**
     * Every background delivery, then the scheduled run until nothing is left: retries (Graph's lag)
     * are brought forward, but the confirm checks a deprovisioning queues wait their real minute,
     * so they see Graph as it has settled.
     */
    const settle = async () => {
      for (const until = Date.now() + 360_000; Date.now() < until; ) {
        while (pending.size) await Promise.allSettled([...pending]);
        if (!(await jobs()).some((j) => !j.failed)) break;
        await sleep(3000);
        await ctx.adapter.updateMany({ model: "scimProvisioningJob", where: [{ field: "failed", value: false }, { field: "nextAttemptAt", value: new Date(Date.now() + 30_000), operator: "lt" }], update: { nextAttemptAt: new Date(0) } });
        await auth.api.scimProvisioningRun({ body: {} });
      }
    };
    const remoteOf = async (userId: string) => {
      const links = await ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningLink" });
      for (const l of links) if (l.remoteId) made.add(l.remoteId);
      return links.find((l) => l.userId === userId)?.remoteId as string | undefined;
    };
    const user = (email: string, name: string) => ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: "admin" });
    return { auth, ctx, jobs, settle, remoteOf, user };
  };

  afterAll(async () => {
    // Everything named with this run's stamp, live or in the bin: deleted, then purged.
    const prefix = `scim-live-${stamp}-`;
    const named = (await graph("GET", `/users?$filter=${encodeURIComponent(`startswith(userPrincipalName,'${prefix}')`)}&$select=id`)).json?.value ?? [];
    const live = [...new Set([...made, ...named.map((u: { id: string }) => u.id)])];
    // A user made seconds ago can 404 by id (Graph's lag): asked again for a while.
    for (const id of live) {
      for (let i = 0; i < 8 && (await graph("DELETE", `/users/${id}`)).status === 404; i++) {
        if ((await graph("GET", `/directory/deletedItems/${id}?$select=id`)).status === 200) break;
        await sleep(5000);
      }
    }
    await sleep(20_000);
    let purged = 0;
    for (let round = 0; round < 3; round++) {
      const binned = ((await graph("GET", "/directory/deletedItems/microsoft.graph.user?$select=id,userPrincipalName&$top=999")).json?.value ?? []).filter((u: { id: string; userPrincipalName: string }) => u.userPrincipalName.includes(prefix) || made.has(u.id));
      for (const u of binned) if ((await graph("DELETE", `/directory/deletedItems/${u.id}`)).status === 204) purged++;
      if (!binned.length) break;
      await sleep(10_000);
    }
    console.log(`cleanup: ${live.length} live users deleted, ${purged} purged from the bin`);
  }, 600_000);

  it("a user's life: created with our id as immutableId, renamed, new email, disabled, enabled, disabled when deleted", async () => {
    const h = await setup({});
    const u = await h.user(email("ada"), "Ada Lovelace");
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    const id = (await h.remoteOf(u.id))!;
    let r = await read(id, (x) => !!x);
    console.log("1 created", JSON.stringify(r));
    expect(r).toMatchObject({ userPrincipalName: email("ada"), displayName: "Ada Lovelace", givenName: "Ada", surname: "Lovelace", accountEnabled: true, onPremisesImmutableId: u.id });

    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Byron" });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    r = await read(id, (x) => x?.displayName === "Ada Byron");
    expect(r).toMatchObject({ displayName: "Ada Byron", surname: "Byron" });

    await h.ctx.internalAdapter.updateUser(u.id, { email: email("ada2") });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    r = await read(id, (x) => x?.userPrincipalName === email("ada2"));
    expect(r?.userPrincipalName).toBe(email("ada2"));

    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    expect((await read(id, (x) => x?.accountEnabled === false))?.accountEnabled).toBe(false);

    await h.ctx.internalAdapter.updateUser(u.id, { banned: false });
    await h.settle();
    expect((await read(id, (x) => x?.accountEnabled === true))?.accountEnabled).toBe(true);

    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    expect((await read(id, (x) => x?.accountEnabled === false))?.accountEnabled).toBe(false);
  });

  it("delete mode: into the recycle bin, then restored as the same account when the user is back", async () => {
    const h = await setup({ deprovision: "delete" });
    const u = await h.user(email("bo"), "Bo Bell");
    await h.settle();
    const id = (await h.remoteOf(u.id))!;
    expect(await read(id, (x) => !!x)).toMatchObject({ onPremisesImmutableId: u.id });

    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    expect(await read(id, (x) => x === null)).toBeNull();
    const binned = (await graph("GET", `/directory/deletedItems/${id}?$select=id,onPremisesImmutableId`)).json;
    console.log("2 in the bin", JSON.stringify(binned));
    expect(binned).toMatchObject({ id, onPremisesImmutableId: u.id });

    await h.ctx.internalAdapter.updateUser(u.id, { banned: false, name: "Bo Bright" });
    await h.settle();
    console.log("2 back", JSON.stringify(await h.jobs()));
    expect(await h.jobs()).toEqual([]);
    expect(await h.remoteOf(u.id)).toBe(id);
    expect(await read(id, (x) => x?.displayName === "Bo Bright")).toMatchObject({ userPrincipalName: email("bo"), onPremisesImmutableId: u.id, displayName: "Bo Bright", accountEnabled: true });
  });

  it("enterprise attributes and the manager, set and cleared", async () => {
    const fields = { employeeNumber: { type: "string" }, costCenter: { type: "string" }, organization: { type: "string" }, division: { type: "string" }, department: { type: "string" }, managerId: { type: "string" } } as const;
    const h = await setup({ enterprise: true }, fields);
    const boss = await h.user(email("boss"), "Di Boss");
    const u = await h.user(email("cy"), "Cy Report");
    await h.settle();
    await h.ctx.internalAdapter.updateUser(u.id, { employeeNumber: "E-1", costCenter: "CC9", organization: "Acme", division: "R&D", department: "Engines", managerId: boss.id });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    const id = (await h.remoteOf(u.id))!;
    const bossId = (await h.remoteOf(boss.id))!;
    // Graph applies a change in parts (two audit entries), and a replica can show one part before
    // the other (found live): wait for all of it.
    const r = await read(id, (x) => x?.department === "Engines" && x?.employeeOrgData?.costCenter === "CC9" && x?.employeeOrgData?.division === "R&D" && x?.employeeId === "E-1");
    console.log("3 enterprise", JSON.stringify(r));
    expect(r).toMatchObject({ employeeId: "E-1", department: "Engines", companyName: "Acme", employeeOrgData: { costCenter: "CC9", division: "R&D" } });
    expect(await managerOf(id, bossId)).toBe(bossId);

    await h.ctx.internalAdapter.updateUser(u.id, { division: null, department: null, managerId: null });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    expect(await read(id, (x) => x?.department === null && x?.employeeOrgData?.costCenter === "CC9" && x?.employeeOrgData?.division === null)).toMatchObject({ department: null, employeeOrgData: { costCenter: "CC9", division: null } });
    expect(await managerOf(id, null)).toBeNull();
  });

  it("attributes: the title, phones and work address, set and cleared", async () => {
    const fields = { title: { type: "string" }, phone: { type: "string" }, mobile: { type: "string" }, streetAddress: { type: "string" }, locality: { type: "string" }, region: { type: "string" }, postalCode: { type: "string" }, country: { type: "string" } } as const;
    const h = await setup({ attributes: true }, fields);
    const u = await h.user(email("eve"), "Eve Fields");
    await h.settle();
    await h.ctx.internalAdapter.updateUser(u.id, { title: "Engineer", phone: "+44 20 7946 0001", mobile: "+44 7700 900001", streetAddress: "1 Main Street", locality: "London", region: "Greater London", postalCode: "SW1A 1AA", country: "United Kingdom" });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    const id = (await h.remoteOf(u.id))!;
    const r = await read(id, (x) => x?.jobTitle === "Engineer" && x?.mobilePhone === "+44 7700 900001" && x?.country === "United Kingdom");
    console.log("5 attributes", JSON.stringify(r));
    expect(r).toMatchObject({ jobTitle: "Engineer", businessPhones: ["+44 20 7946 0001"], mobilePhone: "+44 7700 900001", streetAddress: "1 Main Street", city: "London", state: "Greater London", postalCode: "SW1A 1AA", country: "United Kingdom" });

    // Cleared in part: the title and the mobile go; the work phone and the address stay.
    await h.ctx.internalAdapter.updateUser(u.id, { title: null, mobile: null });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    expect(await read(id, (x) => x?.jobTitle === null && x?.mobilePhone === null)).toMatchObject({ jobTitle: null, businessPhones: ["+44 20 7946 0001"], mobilePhone: null, city: "London", postalCode: "SW1A 1AA" });

    // Then the rest: an empty list clears the work phone, nulls clear the address.
    await h.ctx.internalAdapter.updateUser(u.id, { phone: null, streetAddress: null, locality: null, region: null, postalCode: null, country: null });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    expect(await read(id, (x) => x?.businessPhones?.length === 0 && x?.country === null)).toMatchObject({ businessPhones: [], streetAddress: null, city: null, state: null, postalCode: null, country: null });
  });

  it("drift: the tenant's accounts a page at a time through Graph's own next links; an account changed by hand is reported", async () => {
    const h = await setup({});
    const u = await h.user(email("gus"), "Gus Drift");
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    const id = (await h.remoteOf(u.id))!;
    expect(await read(id, (x) => !!x)).toMatchObject({ accountEnabled: true });
    type Item = { remoteId: string; finding: string; userId: string | null; active: boolean | null };
    /** The whole directory in pages of one, as a caller would: the `next` handed out drives the paging. */
    const scan = async () => {
      const items: Item[] = [];
      let pages = 0;
      let scanned = 0;
      let after: string | undefined;
      do {
        const page = await h.auth.api.scimProvisioningDrift({ body: { targetId: "entra", limit: 1, ...(after ? { after } : {}) } });
        pages++;
        scanned += page.scanned;
        items.push(...page.items);
        after = page.next ?? undefined;
      } while (after && pages < 500);
      return { items, pages, scanned, ended: !after };
    };
    // Disabled by hand at Entra: a mismatch, once Graph's list shows it (replicas lag).
    expect((await graph("PATCH", `/users/${id}`, { accountEnabled: false })).status).toBe(204);
    let s = await scan();
    for (let i = 0; i < 20 && !s.items.some((x) => x.remoteId === id); i++) {
      await sleep(3000);
      s = await scan();
    }
    console.log(`6 drift: ${s.scanned} accounts over ${s.pages} pages, ${s.items.length} findings`, JSON.stringify(s.items.filter((x) => x.remoteId === id)));
    expect(s.ended).toBe(true);
    expect(s.pages).toBeGreaterThan(1);
    expect(s.scanned).toBeGreaterThanOrEqual(2);
    expect(s.items).toContainEqual(expect.objectContaining({ remoteId: id, finding: "mismatch", active: false, userId: u.id }));
    // The tenant's own accounts, made by hand, are unmanaged: reported, never touched.
    expect(s.items.some((x) => x.finding === "unmanaged")).toBe(true);

    // Enabled again by hand: nothing to report for our account.
    expect((await graph("PATCH", `/users/${id}`, { accountEnabled: true })).status).toBe(204);
    s = await scan();
    for (let i = 0; i < 20 && s.items.some((x) => x.remoteId === id); i++) {
      await sleep(3000);
      s = await scan();
    }
    expect(s.items.some((x) => x.remoteId === id)).toBe(false);
    expect(await read(id, (x) => x?.accountEnabled === true)).toMatchObject({ accountEnabled: true });
  });

  it.skipIf(!federated)("a federated domain: created with the immutableId and no password", async () => {
    const h = await setup({});
    const u = await h.user(email("fed", federated), "Fed Erated");
    await h.settle();
    console.log("4 federated", JSON.stringify(await h.jobs()));
    expect(await h.jobs()).toEqual([]);
    const id = (await h.remoteOf(u.id))!;
    expect(await read(id, (x) => !!x)).toMatchObject({ userPrincipalName: email("fed", federated), onPremisesImmutableId: u.id, accountEnabled: true });
  });
});
