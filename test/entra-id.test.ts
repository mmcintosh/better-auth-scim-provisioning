// Microsoft Entra ID targets (`type: "entra-id"`): users created, updated, disabled and deleted
// through Microsoft Graph, signed in with the app registration's client credentials, our id as the
// onPremisesImmutableId (the federated sign-in's link), with the same adoption rules, retries and
// 404 checks as SCIM targets, and Graph's own ways: no password on a federated domain, the
// recycle bin holding the immutableId, and replicas that lag for seconds after a write.
import { describe, expect, it } from "vitest";
import { defaultScimUser, scimProvisioning } from "../src";
import { forgetTokens } from "../src/credentials";
import { entraIdClient, mailNickname } from "../src/entra";
import { ScimError } from "../src/scim-client";
import { type Adapter, outbox } from "../src/outbox";
import { createHost } from "./support/host";

const E = { id: "entra", type: "entra-id" as const };
type Host = Awaited<ReturnType<typeof createHost>>;
const atGraph = (h: Host) => [...h.graph.users.values()];
/** The user deliveries queued (not the "confirm" checks that follow a deprovisioning). */
const deliveries = async (h: Host) => (await h.jobs()).filter((j) => !j.kind);
/** Everything queued, run now (the confirm checks included), until nothing is left. */
async function drain(h: Host) {
  for (let i = 0; i < 6 && (await h.jobs()).some((j) => !j.failed); i++) {
    h.db.prepare('UPDATE "scimProvisioningJob" SET "nextAttemptAt" = 0').run();
    await h.auth.api.scimProvisioningRun({ body: {} });
    await h.settle();
  }
}

describe("Entra ID", () => {
  it("a user's life: created with our id as immutableId and no password, renamed, disabled with sessions revoked, enabled, disabled when deleted", async () => {
    forgetTokens();
    const h = await createHost({ targets: [E] });
    const u = await h.user("Ada King Lovelace");
    expect(atGraph(h)).toEqual([
      expect.objectContaining({ userPrincipalName: u.email, displayName: "Ada King Lovelace", givenName: "Ada King", surname: "Lovelace", mailNickname: u.email.split("@")[0], accountEnabled: true, onPremisesImmutableId: u.id }),
    ]);
    // A federated domain: the user signs in through the IdP, so no password is set.
    expect(atGraph(h)[0]!.passwordProfile).toBeUndefined();
    const id = atGraph(h)[0]!.id;
    expect(await h.links()).toEqual([expect.objectContaining({ remoteId: id, active: true })]);

    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Byron" });
    await h.settle();
    expect(atGraph(h)[0]).toMatchObject({ displayName: "Ada Byron", givenName: "Ada", surname: "Byron", accountEnabled: true });

    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(atGraph(h)[0]!.accountEnabled).toBe(false);
    expect(h.graph.revoked).toEqual([id]);

    await h.ctx.internalAdapter.updateUser(u.id, { banned: false });
    await h.settle();
    expect(atGraph(h)[0]!.accountEnabled).toBe(true);

    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect(atGraph(h)[0]!.accountEnabled).toBe(false);
    expect(h.graph.revoked).toEqual([id, id]);
    // The job comes back a minute later to check that Graph has the disable; it finds it so, and ends.
    expect(await h.jobs()).toEqual([expect.objectContaining({ userId: u.id, failed: false, nextAttemptAt: expect.any(Date) })]);
    expect(new Date((await h.jobs())[0]!.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now() + 50_000);
    await drain(h);
    expect(await h.jobs()).toEqual([]);
    expect(h.graph.revoked).toEqual([id, id]);
  });

  it("a managed (cloud) domain gets a random password nobody knows", async () => {
    const h = await createHost({ targets: [E] });
    await h.ctx.internalAdapter.createUser({ email: "cloud@managed.example", name: "Cloud Only", emailVerified: true }, { method: "admin" });
    await h.settle();
    expect(atGraph(h)[0]).toMatchObject({ userPrincipalName: "cloud@managed.example", passwordProfile: { password: expect.stringMatching(/.{20,}/), forceChangePasswordNextSignIn: false } });
    expect(await h.jobs()).toEqual([]);
  });

  it("an admin's disabling isn't undone by a rename; only the plugin's own is", async () => {
    const h = await createHost({ targets: [E] });
    const u = await h.user("Ada Lovelace");
    atGraph(h)[0]!.accountEnabled = false;
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Byron" });
    await h.settle();
    expect(atGraph(h)[0]).toMatchObject({ displayName: "Ada Byron", accountEnabled: false });
  });

  it("delete mode: into the recycle bin, never purged; back within 30 days, restored with the same account", async () => {
    const h = await createHost({ targets: [{ ...E, deprovision: "delete" }] });
    const u = await h.user("Ada Lovelace");
    const id = atGraph(h)[0]!.id;
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(atGraph(h)).toEqual([]);
    expect(h.graph.bin.get(id)).toMatchObject({ onPremisesImmutableId: u.id, userPrincipalName: `${id.replace(/-/g, "")}${u.email}` });
    // Kept (inactive) until the check a minute later finds the account gone.
    expect(await h.links()).toEqual([expect.objectContaining({ remoteId: id, active: false })]);
    await drain(h);
    expect(await h.links()).toEqual([]);
    expect(await h.jobs()).toEqual([]);

    // Back: the create meets the immutableId in the bin, and the account is restored and updated.
    await h.ctx.internalAdapter.updateUser(u.id, { banned: false, name: "Ada Byron" });
    await h.settle();
    expect(h.graph.bin.size).toBe(0);
    expect(atGraph(h)).toEqual([expect.objectContaining({ id, userPrincipalName: u.email, onPremisesImmutableId: u.id, displayName: "Ada Byron", accountEnabled: true })]);
    expect(await h.links()).toEqual([expect.objectContaining({ remoteId: id, active: true })]);
    expect(await deliveries(h)).toEqual([]);
    await drain(h);
    expect(await h.jobs()).toEqual([]);
    expect(atGraph(h)).toEqual([expect.objectContaining({ id, accountEnabled: true })]);
  });

  it("back moments after a delete, while Graph still reads the account as live: retried, then restored from the bin", async () => {
    const h = await createHost({ targets: [{ ...E, deprovision: "delete" }], graphDeleteLag: 2 });
    const u = await h.user("Ada Lovelace");
    const id = atGraph(h)[0]!.id;
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    await h.ctx.internalAdapter.updateUser(u.id, { banned: false, name: "Ada Byron" });
    await h.settle();
    expect(await deliveries(h)).toEqual([expect.objectContaining({ userId: u.id, failed: false, lastError: expect.stringContaining("on its way to the recycle bin") })]);
    await drain(h);
    expect(await h.jobs()).toEqual([]);
    expect(atGraph(h)).toEqual([expect.objectContaining({ id, userPrincipalName: u.email, displayName: "Ada Byron", accountEnabled: true })]);
  });

  it("back after delete under a new email, but someone else has the old userPrincipalName now: the restore is refused, and the job fails with Graph's reason", async () => {
    const h = await createHost({ targets: [{ ...E, deprovision: "delete" }] });
    const u = await h.user("Ada Lovelace");
    const id = atGraph(h)[0]!.id;
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    h.graph.users.set("newcomer", { id: "newcomer", userPrincipalName: u.email, displayName: "Newcomer", mailNickname: "n", accountEnabled: true, onPremisesImmutableId: "theirs" });
    // A new address: the create isn't stopped by the userPrincipalName, only by the immutableId in the bin.
    await h.ctx.internalAdapter.updateUser(u.id, { banned: false, email: "ada.new@example.com" });
    await h.settle();
    expect(h.graph.bin.has(id)).toBe(true);
    expect(h.graph.users.get("newcomer")).toMatchObject({ displayName: "Newcomer", onPremisesImmutableId: "theirs" });
    expect(await deliveries(h)).toEqual([expect.objectContaining({ userId: u.id, failed: true, lastError: expect.stringContaining("restore: 400 Another object with the same value for property userPrincipalName") })]);
  });

  it("a disable Graph answers as done but drops (found live) is sent again by the check a minute later", async () => {
    const h = await createHost({ targets: [E] });
    const u = await h.user("Ada Lovelace");
    h.graph.lose.accountEnabled = 1;
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(atGraph(h)[0]!.accountEnabled).toBe(true); // dropped
    expect(await h.links()).toEqual([expect.objectContaining({ active: false })]);
    await drain(h);
    expect(atGraph(h)[0]!.accountEnabled).toBe(false);
    expect(await h.jobs()).toEqual([]);
  });

  it("a delete Graph answers as done but drops is sent again by the check a minute later", async () => {
    const h = await createHost({ targets: [{ ...E, deprovision: "delete" }] });
    const u = await h.user("Ada Lovelace");
    const id = atGraph(h)[0]!.id;
    h.graph.lose.delete = 1;
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(atGraph(h)).toHaveLength(1); // dropped
    await drain(h);
    expect(atGraph(h)).toEqual([]);
    expect(h.graph.bin.has(id)).toBe(true);
    expect(await h.jobs()).toEqual([]);
  });

  it("an enable Graph drops isn't forced later: an admin may have disabled the account (documented)", async () => {
    const h = await createHost({ targets: [E] });
    const u = await h.user("Ada Lovelace");
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    await drain(h);
    h.graph.lose.accountEnabled = 1;
    await h.ctx.internalAdapter.updateUser(u.id, { banned: false });
    await h.settle();
    await drain(h);
    expect(atGraph(h)[0]!.accountEnabled).toBe(false);
    expect(await h.jobs()).toEqual([]);
  });

  it("deleted moments after its create: Graph's 404 is checked by immutableId and retried, never taken as gone", async () => {
    const h = await createHost({ targets: [{ ...E, deprovision: "delete" }], graphLag: 2 });
    const u = await h.user("Ada Lovelace");
    const id = atGraph(h)[0]!.id;
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(atGraph(h)).toHaveLength(1);
    expect(await deliveries(h)).toEqual([expect.objectContaining({ failed: false, lastError: expect.stringContaining("still being created") })]);
    await drain(h);
    expect(atGraph(h)).toEqual([]);
    expect(h.graph.bin.has(id)).toBe(true);
    expect(await h.jobs()).toEqual([]);
  });

  it("a timed ban: a dropped disable is checked a minute later, not when the ban ends; then the job waits for the ban's end", async () => {
    const h = await createHost({ targets: [E] });
    const u = await h.user("Ada Lovelace");
    h.graph.lose.accountEnabled = 1;
    const until = new Date(Date.now() + 30 * 86_400_000);
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true, banExpires: until });
    await h.settle();
    expect(atGraph(h)[0]!.accountEnabled).toBe(true); // dropped
    const next = async () => new Date((await h.jobs())[0]!.nextAttemptAt as Date).getTime();
    expect(await next()).toBeLessThan(Date.now() + 120_000);
    const runOnce = async () => {
      h.db.prepare('UPDATE "scimProvisioningJob" SET "nextAttemptAt" = 0').run();
      await h.auth.api.scimProvisioningRun({ body: {} });
      await h.settle();
    };
    await runOnce();
    expect(atGraph(h)[0]!.accountEnabled).toBe(false); // disabled again
    await runOnce();
    expect(await next()).toBe(until.getTime()); // confirmed: back to waiting for the ban's end
  });

  it("back before the check runs: the return and the check are one job, so a returning user is never disabled again", async () => {
    const h = await createHost({ targets: [E] });
    const u = await h.user("Ada Lovelace");
    h.graph.lose.accountEnabled = 1;
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    await h.ctx.internalAdapter.updateUser(u.id, { banned: false });
    await h.settle();
    await drain(h);
    expect(atGraph(h)[0]!.accountEnabled).toBe(true);
    expect(await h.links()).toEqual([expect.objectContaining({ active: true })]);
    expect(await h.jobs()).toEqual([]);
  });

  it("with a custom externalId (mapUser), a delete Graph drops is still sent again", async () => {
    const h = await createHost({ targets: [{ ...E, deprovision: "delete", mapUser: (user) => ({ ...defaultScimUser(user), externalId: `emp-${user.id}` }) }] });
    const u = await h.user("Ada Lovelace");
    expect(atGraph(h)[0]!.onPremisesImmutableId).toBe(`emp-${u.id}`);
    h.graph.lose.delete = 1;
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(atGraph(h)).toHaveLength(1); // dropped
    await drain(h);
    expect(atGraph(h)).toEqual([]);
    expect(await h.jobs()).toEqual([]);
  });

  it("an error after the account was made (its manager refused) keeps the link, so a later ban still disables it", async () => {
    const h = await createHost({ targets: [{ ...E, enterprise: { manager: "managerId" } }], userFields: { managerId: { type: "string" } } });
    const boss = await h.user("Di Boss");
    h.graph.refuse.manager = true;
    const u = await h.ctx.internalAdapter.createUser({ email: "cy@example.com", name: "Cy Report", emailVerified: true, managerId: boss.id } as never, { method: "admin" });
    await h.settle();
    const cy = atGraph(h).find((x) => x.userPrincipalName === "cy@example.com")!;
    expect(cy.accountEnabled).toBe(true);
    expect((await h.jobs()).find((j) => j.userId === u.id)).toMatchObject({ failed: true });
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(cy.accountEnabled).toBe(false);
  });

  it("an address another object holds (proxyAddresses) fails the job with Graph's reason, never retried as 'can't find it yet'", async () => {
    const h = await createHost({ targets: [E] });
    h.graph.refuse.conflict = "proxyAddresses";
    const u = await h.user("Ada Lovelace");
    expect(await deliveries(h)).toEqual([expect.objectContaining({ userId: u.id, failed: true, lastError: expect.stringContaining("proxyAddresses") })]);
  });

  it("a create whose reply was lost: found by its immutableId and linked, never made twice", async () => {
    const h = await createHost({ targets: [E] });
    const u = await h.user("Ada Lovelace");
    const id = atGraph(h)[0]!.id;
    h.db.prepare('DELETE FROM "scimProvisioningLink"').run();
    // A new address too: only the immutableId conflicts, so the account is found by it.
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Byron", email: "ada.byron@example.com" });
    await h.settle();
    expect(atGraph(h)).toEqual([expect.objectContaining({ id, displayName: "Ada Byron", userPrincipalName: "ada.byron@example.com" })]);
    expect(await h.links()).toEqual([expect.objectContaining({ remoteId: id, active: true })]);
  });

  it("adopt is off by default: an account made by hand with the same userPrincipalName is left alone", async () => {
    const h = await createHost({ targets: [E] });
    h.graph.users.set("hand", { id: "hand", userPrincipalName: "user1@example.com", displayName: "Hand Made", mailNickname: "user1", accountEnabled: true, onPremisesImmutableId: "on-prem-1" });
    h.graph.users.get("hand")!.onPremisesImmutableId = null;
    const u = await h.user("Ada Lovelace");
    expect(h.graph.users.get("hand")).toMatchObject({ displayName: "Hand Made", onPremisesImmutableId: null });
    expect((await h.jobs()).find((j) => j.userId === u.id)).toMatchObject({ failed: true, lastError: expect.stringContaining("false, the default for Entra ID") });
  });

  it("with adopt: true, an account made by hand is taken over and given our immutableId; one that's another user's never is", async () => {
    const h = await createHost({ targets: [{ ...E, adopt: true }] });
    h.graph.users.set("hand", { id: "hand", userPrincipalName: "user1@example.com", displayName: "Hand Made", mailNickname: "user1", accountEnabled: true, onPremisesImmutableId: null });
    const u = await h.user("Ada Lovelace");
    expect(h.graph.users.get("hand")).toMatchObject({ displayName: "Ada Lovelace", onPremisesImmutableId: u.id });

    h.graph.users.set("theirs", { id: "theirs", userPrincipalName: "user2@example.com", displayName: "Other Person", mailNickname: "user2", accountEnabled: true, onPremisesImmutableId: "someone-else" });
    const v = await h.user("Second Person");
    expect(h.graph.users.get("theirs")).toMatchObject({ displayName: "Other Person", onPremisesImmutableId: "someone-else" });
    expect((await h.jobs()).find((j) => j.userId === v.id)).toMatchObject({ failed: true, lastError: expect.stringContaining("belongs to another user") });
  });

  it("Graph's lag after a create: a change seconds later is retried until the account shows, then delivered", async () => {
    const h = await createHost({ targets: [E], graphLag: 3 });
    const u = await h.user("Ada Lovelace");
    expect(atGraph(h)).toHaveLength(1);
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Byron" });
    await h.settle();
    // Not there yet by id: retried, not failed, and no second account made.
    expect(await h.jobs()).toEqual([expect.objectContaining({ userId: u.id, failed: false, lastError: expect.stringContaining("still creating") })]);
    expect(atGraph(h)).toHaveLength(1);
    for (let i = 0; i < 5 && (await h.jobs()).length; i++) {
      h.db.prepare('UPDATE "scimProvisioningJob" SET "nextAttemptAt" = 0').run();
      await h.auth.api.scimProvisioningRun({ body: {} });
      await h.settle();
    }
    expect(atGraph(h)).toEqual([expect.objectContaining({ displayName: "Ada Byron" })]);
    expect(await h.jobs()).toEqual([]);
  });

  it("an address outside the tenant's domains fails the job with Graph's message", async () => {
    const h = await createHost({ targets: [E] });
    const u = await h.ctx.internalAdapter.createUser({ email: "someone@elsewhere.org", name: "Out Side", emailVerified: true }, { method: "admin" });
    await h.settle();
    expect(await h.jobs()).toEqual([expect.objectContaining({ userId: u.id, failed: true, lastError: expect.stringContaining("verified domain") })]);
  });

  it("enterprise attributes: employeeId, department, companyName, employeeOrgData (merged) and the manager; cleared when emptied", async () => {
    const h = await createHost({ targets: [{ ...E, enterprise: true }], userFields: { employeeNumber: { type: "string" }, costCenter: { type: "string" }, organization: { type: "string" }, division: { type: "string" }, department: { type: "string" }, managerId: { type: "string" } } });
    const boss = await h.user("Di Boss");
    const u = await h.user("Cy Report");
    const at = (email: string) => atGraph(h).find((x) => x.userPrincipalName === email)!;
    await h.ctx.internalAdapter.updateUser(u.id, { employeeNumber: "E-1", costCenter: "CC9", organization: "Acme", division: "R&D", department: "Engines", managerId: boss.id });
    await h.settle();
    expect(at(u.email)).toMatchObject({ employeeId: "E-1", department: "Engines", companyName: "Acme", employeeOrgData: { costCenter: "CC9", division: "R&D" }, manager: at(boss.email).id });
    await h.ctx.internalAdapter.updateUser(u.id, { division: null, department: " ", managerId: null });
    await h.settle();
    expect(at(u.email)).toMatchObject({ employeeId: "E-1", department: null, companyName: "Acme", employeeOrgData: { costCenter: "CC9", division: null } });
    expect(at(u.email).manager).toBeUndefined();
    expect(await h.jobs()).toEqual([]);
  });

  it("a manager Graph can't find (yet) is retried, never taken as this user's account being gone", async () => {
    const h = await createHost({ targets: [{ ...E, enterprise: { manager: "managerId" } }], userFields: { managerId: { type: "string" } } });
    const boss = await h.user("Di Boss");
    const u = await h.user("Cy Report");
    const bossAccount = atGraph(h).find((x) => x.userPrincipalName === boss.email)!;
    h.graph.users.delete(bossAccount.id);
    await h.ctx.internalAdapter.updateUser(u.id, { managerId: boss.id });
    await h.settle();
    expect(atGraph(h)).toHaveLength(1);
    expect((await h.jobs()).find((j) => j.userId === u.id)).toMatchObject({ failed: false, lastError: expect.stringContaining("manager's Entra account") });
    h.graph.users.set(bossAccount.id, bossAccount);
    h.db.prepare('UPDATE "scimProvisioningJob" SET "nextAttemptAt" = 0').run();
    await h.auth.api.scimProvisioningRun({ body: {} });
    await h.settle();
    expect(atGraph(h).find((x) => x.userPrincipalName === u.email)!.manager).toBe(bossAccount.id);
  });

  it("signs in with client credentials at the tenant's token endpoint, once for many requests", async () => {
    forgetTokens();
    const h = await createHost({ targets: [E] });
    await h.user("One Person");
    await h.user("Two Person");
    expect(h.graph.tokenRequests).toHaveLength(1);
    expect(Object.fromEntries(h.graph.tokenRequests[0]!.body)).toEqual({ grant_type: "client_credentials", client_id: h.graph.clientId, client_secret: h.graph.clientSecret, scope: "https://graph.microsoft.test/.default" });
  });

  it("a wrong client secret is retried with a message, never failing users for good", async () => {
    forgetTokens();
    const h = await createHost({ targets: [E] });
    const box = outbox(
      { targets: [{ ...E, url: h.graph.url, entra: { tenantId: h.graph.tenantId, clientId: h.graph.clientId, clientSecret: "Zq8~wrong-secret-value", tokenUrl: h.graph.tokenUrl }, fetch: h.graph.fetch }] },
      h.ctx.adapter as unknown as Adapter,
      { warn() {}, error() {} },
    );
    const u = await h.ctx.internalAdapter.createUser({ email: "x@example.com", name: "X Person", emailVerified: true }, { method: "admin" });
    await h.settle();
    h.graph.users.clear();
    await box.enqueue("entra", u.id, { now: true });
    expect(await box.runFor("entra", u.id)).toBe("retry");
    expect((await h.jobs())[0]).toMatchObject({ failed: false });
    expect(String((await h.jobs())[0]!.lastError)).not.toContain("Zq8~wrong-secret-value");
    forgetTokens();
  });

  it("a wrong URL: disabling retries instead of looking done", async () => {
    const h = await createHost({ targets: [E] });
    const u = await h.user();
    const box = outbox(
      { targets: [{ ...E, url: `${h.graph.url}/wrong`, entra: { tenantId: h.graph.tenantId, clientId: h.graph.clientId, clientSecret: h.graph.clientSecret, tokenUrl: h.graph.tokenUrl }, fetch: h.graph.fetch }] },
      h.ctx.adapter as unknown as Adapter,
      { warn() {}, error() {} },
    );
    h.db.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?').run(u.id);
    await box.enqueue("entra", u.id);
    expect(await box.runFor("entra", u.id)).toBe("retry");
    expect(atGraph(h)[0]!.accountEnabled).toBe(true);
    expect(await h.links()).toEqual([expect.objectContaining({ active: true })]);
  });

  describe("the client on its own", () => {
    const token = new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const conflictOn = (holder: string) =>
      json(400, { error: { code: "Request_BadRequest", message: "Another object with the same value for property onPremisesImmutableId already exists.", details: [{ code: "ObjectConflict", target: "onPremisesImmutableId" }, { code: "ConflictingObjects", target: `User_${holder}` }] } });
    const notFound = json(404, { error: { code: "Request_ResourceNotFound", message: "Resource does not exist" } });
    const user = { schemas: [], userName: "ada@example.com", externalId: "ours", active: true, displayName: "Ada" };
    const client = (url: string, routes: (method: string, path: string, body: string | undefined) => Response | undefined, extra: object = {}) => {
      forgetTokens();
      const seen: { url: string; body: string | undefined }[] = [];
      const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const href = String(input);
        seen.push({ url: href, body: init?.body as string | undefined });
        if (href.includes("/oauth2/")) return token.clone();
        return routes(init?.method ?? "GET", new URL(href).pathname.replace(/^\/v1\.0/, ""), init?.body as string | undefined) ?? new Response("no route", { status: 500 });
      }) as typeof globalThis.fetch;
      const c = entraIdClient({ id: "e", type: "entra-id", url, entra: { tenantId: "00000000-0000-4000-8000-000000000001", clientId: "c", clientSecret: "s", ...extra }, fetch } as never);
      return { c, seen };
    };

    it("a holder of the immutableId that isn't ours (live or in the bin) is never taken over", async () => {
      const live = client("https://graph.microsoft.com/v1.0", (m, p) => (m === "POST" && p === "/users" ? conflictOn("x") : p === "/users/x" ? json(200, { id: "x", onPremisesImmutableId: "theirs" }) : undefined));
      await expect(live.c.create(user)).rejects.toThrow(/belongs to another Entra account/);
      const binned = client("https://graph.microsoft.com/v1.0", (m, p) => (m === "POST" && p === "/users" ? conflictOn("x") : p === "/users/x" ? notFound.clone() : p === "/directory/deletedItems/x" ? json(200, { id: "x", onPremisesImmutableId: "theirs" }) : undefined));
      await expect(binned.c.create(user)).rejects.toThrow(/deleted Entra account/);
      expect(binned.seen.some((r) => r.url.endsWith("/restore"))).toBe(false);
    });

    it("a holder Graph names but can't show yet is retried without a status, never as a 409", async () => {
      const { c } = client("https://graph.microsoft.com/v1.0", (m, p) => (m === "POST" && p === "/users" ? conflictOn("x") : p === "/users/x" || p === "/directory/deletedItems/x" ? notFound.clone() : undefined));
      const e = (await c.create(user).catch((x) => x)) as ScimError;
      expect(e).toBeInstanceOf(ScimError);
      expect([e.status, e.retryable]).toEqual([null, true]);
    });

    it("a redirect is never followed, and retried", async () => {
      const { c } = client("https://graph.microsoft.com/v1.0", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
      const e = (await c.setActive("x", false).catch((x) => x)) as ScimError;
      expect([e.status, e.retryable]).toEqual([302, true]);
    });

    it("a national cloud: the token's scope and the manager reference name that cloud's Graph; behind a proxy, the scope option does", async () => {
      const ok = (m: string, p: string) => (p === "/users/x" && m === "GET" ? json(200, { id: "x", onPremisesImmutableId: "ours" }) : new Response(null, { status: 204 }));
      const us = client("https://graph.microsoft.us/v1.0", ok);
      await us.c.replace("x", { ...user, "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { manager: { value: "m" } } } as never);
      expect(new URLSearchParams(us.seen[0]!.body).get("scope")).toBe("https://graph.microsoft.us/.default");
      expect(us.seen.find((r) => r.url.endsWith("/manager/$ref"))!.body).toContain("https://graph.microsoft.us/v1.0/directoryObjects/m");
      const proxied = client("https://graph-proxy.internal.example/v1.0", ok, { scope: "https://graph.microsoft.com/.default" });
      await proxied.c.replace("x", { ...user, "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { manager: { value: "m" } } } as never);
      expect(new URLSearchParams(proxied.seen[0]!.body).get("scope")).toBe("https://graph.microsoft.com/.default");
      expect(proxied.seen.find((r) => r.url.endsWith("/manager/$ref"))!.body).toContain("https://graph.microsoft.com/v1.0/directoryObjects/m");
    });
  });

  it("mailNickname: the local part, cleaned to what Graph accepts", () => {
    expect(mailNickname("ada.lovelace@example.com")).toBe("ada.lovelace");
    expect(mailNickname("o'neil (ops)@example.com")).toBe("o'neilops");
    expect(mailNickname("..dots..here..@example.com")).toBe("dots.here");
    expect(mailNickname("élodie@example.com")).toBe("lodie");
    expect(mailNickname("@example.com")).toBe("user");
    expect(mailNickname(`${"a".repeat(70)}@example.com`)).toHaveLength(64);
  });

  it("options: entra is required with a GUID tenant id; token, auth and groups aren't allowed; url is optional", () => {
    const entra = { tenantId: "00000000-0000-4000-8000-000000000001", clientId: "c", clientSecret: "s" };
    const t = (x: object) => () => scimProvisioning({ targets: [{ id: "e", ...x } as never] });
    expect(t({ type: "entra-id", entra })).not.toThrow();
    expect(t({ type: "entra-id", entra, enterprise: true, deprovision: "delete", adopt: true })).not.toThrow();
    expect(t({ type: "entra-id" })).toThrow(/takes entra/);
    expect(t({ type: "entra-id", entra, token: "t" })).toThrow(/takes entra/);
    expect(t({ type: "entra-id", entra: { ...entra, tenantId: "contoso.onmicrosoft.com" } })).toThrow(/GUID/);
    expect(t({ type: "entra-id", entra, groups: true })).toThrow(/groups aren't supported/);
    expect(t({ type: "entra-id", entra, roleGroups: ["admin"] })).toThrow(/groups aren't supported/);
    expect(t({ type: "entra-id", entra, update: "patch" })).toThrow(/update is for scim/);
    expect(t({ url: "https://app.example.com/scim/v2", token: "t", entra })).toThrow(/entra is for entra-id/);
    expect(t({ type: "entra-id", entra, url: "http://graph.example.com/v1.0" })).toThrow(/https/);
    expect(t({ type: "entra-id", entra: { ...entra, tokenUrl: "http://login.example.com/token" } })).toThrow(/https/);
    expect(t({ type: "entra-id", entra: { ...entra, scope: "graph.microsoft.com" } })).toThrow(/\/\.default/);
    expect(t({ type: "entra-id", url: "https://graph.microsoft.us/v1.0", entra: { ...entra, tokenUrl: "https://login.microsoftonline.us/x/oauth2/v2.0/token" } })).not.toThrow();
  });
});

it("restored from the bin with the attributes the user has now: the reclaim carries them", async () => {
  const h = await createHost({ targets: [{ ...E, deprovision: "delete", attributes: true }], userFields: { title: { type: "string" }, mobile: { type: "string" } } });
  const u = await h.user("Ada Lovelace");
  await h.ctx.internalAdapter.updateUser(u.id, { title: "Analyst", mobile: "+44 7700 900001" });
  await h.settle();
  const id = atGraph(h)[0]!.id;
  expect(atGraph(h)[0]).toMatchObject({ jobTitle: "Analyst", mobilePhone: "+44 7700 900001" });
  await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
  await h.settle();
  await drain(h);
  expect(h.graph.bin.has(id)).toBe(true);
  // Back, with a new title and no mobile: the restore's update sends both, like any other.
  await h.ctx.internalAdapter.updateUser(u.id, { banned: false, title: "Senior Analyst", mobile: null });
  await h.settle();
  expect(h.graph.bin.size).toBe(0);
  expect(atGraph(h)).toEqual([expect.objectContaining({ id, accountEnabled: true, jobTitle: "Senior Analyst", mobilePhone: null })]);
  await drain(h);
  expect(await h.jobs()).toEqual([]);
});
