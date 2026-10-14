// Microsoft Entra ID targets (`type: "entra-id"`): users created, updated, disabled and deleted
// through Microsoft Graph, signed in with the app registration's client credentials, our id as the
// onPremisesImmutableId (the federated sign-in's link), with the same adoption rules, retries and
// 404 checks as SCIM targets, and Graph's own ways: no password on a federated domain, the
// recycle bin holding the immutableId, and replicas that lag for seconds after a write.
import { describe, expect, it } from "vitest";
import { scimProvisioning } from "../src";
import { forgetTokens } from "../src/credentials";
import { mailNickname } from "../src/entra";
import { type Adapter, outbox } from "../src/outbox";
import { createHost } from "./support/host";

const E = { id: "entra", type: "entra-id" as const };
const atGraph = (h: Awaited<ReturnType<typeof createHost>>) => [...h.graph.users.values()];

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
    expect(await h.jobs()).toEqual([]);
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
    expect(await h.links()).toEqual([]);

    // Back: the create meets the immutableId in the bin, and the account is restored and updated.
    await h.ctx.internalAdapter.updateUser(u.id, { banned: false, name: "Ada Byron" });
    await h.settle();
    expect(h.graph.bin.size).toBe(0);
    expect(atGraph(h)).toEqual([expect.objectContaining({ id, userPrincipalName: u.email, onPremisesImmutableId: u.id, displayName: "Ada Byron", accountEnabled: true })]);
    expect(await h.links()).toEqual([expect.objectContaining({ remoteId: id, active: true })]);
    expect(await h.jobs()).toEqual([]);
  });

  it("back moments after a delete, while Graph still reads the account as live: retried, then restored from the bin", async () => {
    const h = await createHost({ targets: [{ ...E, deprovision: "delete" }], graphDeleteLag: 2 });
    const u = await h.user("Ada Lovelace");
    const id = atGraph(h)[0]!.id;
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    await h.ctx.internalAdapter.updateUser(u.id, { banned: false, name: "Ada Byron" });
    await h.settle();
    expect(await h.jobs()).toEqual([expect.objectContaining({ userId: u.id, failed: false, lastError: expect.stringContaining("on its way to the recycle bin") })]);
    for (let i = 0; i < 5 && (await h.jobs()).length; i++) {
      h.db.prepare('UPDATE "scimProvisioningJob" SET "nextAttemptAt" = 0').run();
      await h.auth.api.scimProvisioningRun({ body: {} });
      await h.settle();
    }
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
    expect(await h.jobs()).toEqual([expect.objectContaining({ userId: u.id, failed: true, lastError: expect.stringContaining("restore: 400 Another object with the same value for property userPrincipalName") })]);
  });

  it("a create whose reply was lost: found by its immutableId and linked, never made twice", async () => {
    const h = await createHost({ targets: [E] });
    const u = await h.user("Ada Lovelace");
    const id = atGraph(h)[0]!.id;
    h.db.prepare('DELETE FROM "scimProvisioningLink"').run();
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Byron" });
    await h.settle();
    expect(atGraph(h)).toEqual([expect.objectContaining({ id, displayName: "Ada Byron" })]);
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
    expect(Object.fromEntries(h.graph.tokenRequests[0]!.body)).toEqual({ grant_type: "client_credentials", client_id: h.graph.clientId, client_secret: h.graph.clientSecret, scope: "https://graph.microsoft.com/.default" });
  });

  it("a wrong client secret is retried with a message, never failing users for good", async () => {
    forgetTokens();
    const h = await createHost({ targets: [E] });
    const box = outbox(
      { targets: [{ ...E, url: h.graph.url, entra: { tenantId: h.graph.tenantId, clientId: h.graph.clientId, clientSecret: "wrong", tokenUrl: h.graph.tokenUrl }, fetch: h.graph.fetch }] },
      h.ctx.adapter as unknown as Adapter,
      { warn() {}, error() {} },
    );
    const u = await h.ctx.internalAdapter.createUser({ email: "x@example.com", name: "X Person", emailVerified: true }, { method: "admin" });
    await h.settle();
    h.graph.users.clear();
    await box.enqueue("entra", u.id, { now: true });
    expect(await box.runFor("entra", u.id)).toBe("retry");
    expect((await h.jobs())[0]).toMatchObject({ failed: false });
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

  it("mailNickname: the local part, cleaned to what Graph accepts", () => {
    expect(mailNickname("ada.lovelace@example.com")).toBe("ada.lovelace");
    expect(mailNickname("o'neil (ops)@example.com")).toBe("o'neilops");
    expect(mailNickname("..dots..here..@example.com")).toBe("dots.here");
    expect(mailNickname("élodie@example.com")).toBe("lodie");
    expect(mailNickname("@example.com")).toBe("user");
    expect(mailNickname(`${"a".repeat(70)}@example.com`)).toHaveLength(64);
  });

  it("options: entra is required with a GUID tenant id; token, auth and groups aren't allowed; url is optional", () => {
    const entra = { tenantId: "29b0bd5f-aad2-40d4-aa21-576bdbffac40", clientId: "c", clientSecret: "s" };
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
  });
});
