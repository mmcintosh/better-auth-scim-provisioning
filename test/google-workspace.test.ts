// Google Workspace targets (`type: "google-workspace"`): users created, updated, suspended and
// deleted through the Directory API, signed in as a service account acting as a Workspace admin,
// with the same adoption rules, retries and 404 checks as SCIM targets.
import { describe, expect, it } from "vitest";
import { scimProvisioning } from "../src";
import { forgetTokens } from "../src/credentials";
import { type Adapter, outbox } from "../src/outbox";
import { createHost } from "./support/host";

const G = { id: "workspace", type: "google-workspace" as const };
const atGoogle = (h: Awaited<ReturnType<typeof createHost>>) => [...h.google.users.values()];

describe("Google Workspace", () => {
  it("a user's life: created with both names and our id, renamed, suspended, unsuspended, deleted", async () => {
    forgetTokens();
    const h = await createHost({ targets: [G] });
    const u = await h.user("Ada King Lovelace");
    expect(atGoogle(h)).toEqual([
      expect.objectContaining({ primaryEmail: u.email, name: { givenName: "Ada King", familyName: "Lovelace" }, suspended: false, externalIds: [{ type: "custom", customType: "better-auth", value: u.id }] }),
    ]);
    expect(atGoogle(h)[0]!.password).toBeTruthy(); // required by Google, never used with SSO
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Byron" });
    await h.settle();
    expect(atGoogle(h)[0]!.name).toEqual({ givenName: "Ada", familyName: "Byron" });
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(atGoogle(h)[0]!.suspended).toBe(true);
    await h.ctx.internalAdapter.updateUser(u.id, { banned: false });
    await h.settle();
    expect(atGoogle(h)[0]!.suspended).toBe(false);
    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect(atGoogle(h)[0]!.suspended).toBe(true);
    expect(await h.jobs()).toEqual([]);
  });

  it("delete mode deletes the Workspace user", async () => {
    const h = await createHost({ targets: [{ ...G, deprovision: "delete" }] });
    const u = await h.user();
    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect(atGoogle(h)).toEqual([]);
  });

  it("an update keeps externalIds an admin set, replacing only ours", async () => {
    const h = await createHost({ targets: [G] });
    const u = await h.user("Ada Lovelace");
    atGoogle(h)[0]!.externalIds!.push({ type: "organization", value: "E-1234" });
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Byron" });
    await h.settle();
    expect(atGoogle(h)[0]!.externalIds).toEqual([{ type: "organization", value: "E-1234" }, { type: "custom", customType: "better-auth", value: u.id }]);
  });

  it("adopts a Workspace user made by hand, marking it ours; refuses one that's another user's", async () => {
    const h = await createHost({ targets: [G] });
    h.google.users.set("hand", { id: "hand", primaryEmail: "user1@example.com", name: { givenName: "Hand", familyName: "Made" }, suspended: false });
    const u = await h.user("Ada Lovelace");
    expect(h.google.users.get("hand")).toMatchObject({ externalIds: [{ type: "custom", customType: "better-auth", value: u.id }], name: { givenName: "Ada", familyName: "Lovelace" } });

    h.google.users.set("theirs", { id: "theirs", primaryEmail: "user2@example.com", name: { givenName: "Other", familyName: "Person" }, suspended: false, externalIds: [{ type: "custom", customType: "better-auth", value: "someone-else" }] });
    const v = await h.user("Second Person");
    expect(h.google.users.get("theirs")).toMatchObject({ name: { givenName: "Other", familyName: "Person" } });
    expect((await h.jobs()).find((j) => j.userId === v.id)).toMatchObject({ failed: true, lastError: expect.stringContaining("belongs to another user") });
  });

  it("never takes over an account whose alias is the user's email", async () => {
    const h = await createHost({ targets: [G] });
    h.google.users.set("boss", { id: "boss", primaryEmail: "boss@example.com", name: { givenName: "The", familyName: "Boss" }, suspended: false, aliases: ["user1@example.com"] });
    const u = await h.user("Ada Lovelace");
    expect(h.google.users.get("boss")).toMatchObject({ primaryEmail: "boss@example.com", name: { givenName: "The", familyName: "Boss" } });
    expect(await h.jobs()).toEqual([expect.objectContaining({ userId: u.id, failed: true })]);
  });

  it("an address outside the Workspace's domains fails the job with Google's message", async () => {
    const h = await createHost({ targets: [G] });
    const u = await h.ctx.internalAdapter.createUser({ email: "someone@elsewhere.org", name: "Out Side", emailVerified: true }, { method: "admin" });
    await h.settle();
    expect(await h.jobs()).toEqual([expect.objectContaining({ userId: u.id, failed: true, lastError: expect.stringContaining("Domain not found") })]);
  });

  it("signs in as the service account acting as the admin, once for many requests", async () => {
    forgetTokens();
    const h = await createHost({ targets: [G] });
    await h.user("One Person");
    await h.user("Two Person");
    expect(h.google.tokenRequests).toHaveLength(1);
    expect(h.google.tokenRequests[0]!.claims).toMatchObject({ iss: h.google.clientEmail, sub: h.google.admin, scope: "https://www.googleapis.com/auth/admin.directory.user", aud: h.google.tokenUrl });
  });

  it("a refused delegation is retried with a message, never failing users for good", async () => {
    forgetTokens();
    const h = await createHost({ targets: [G] });
    const box = outbox({ targets: [{ ...G, url: h.google.url, google: { clientEmail: h.google.clientEmail, privateKey: h.google.privateKey, adminEmail: "not-an-admin@example.com", tokenUrl: h.google.tokenUrl }, fetch: h.google.fetch }] }, h.ctx.adapter as unknown as Adapter, { warn() {}, error() {} });
    const u = await h.ctx.internalAdapter.createUser({ email: "x@example.com", name: "X Person", emailVerified: true }, { method: "admin" });
    await h.settle();
    h.google.users.clear();
    await box.enqueue("workspace", u.id, { now: true });
    expect(await box.runFor("workspace", u.id)).toBe("retry");
    expect((await h.jobs())[0]).toMatchObject({ failed: false, lastError: expect.stringContaining("domain-wide delegation") });
    forgetTokens();
  });

  it("a wrong URL: suspending retries instead of looking done", async () => {
    const h = await createHost({ targets: [G] });
    const u = await h.user();
    const box = outbox({ targets: [{ ...G, url: `${h.google.url}/wrong`, google: { clientEmail: h.google.clientEmail, privateKey: h.google.privateKey, adminEmail: h.google.admin, tokenUrl: h.google.tokenUrl }, fetch: h.google.fetch }] }, h.ctx.adapter as unknown as Adapter, { warn() {}, error() {} });
    h.db.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?').run(u.id);
    await box.enqueue("workspace", u.id);
    expect(await box.runFor("workspace", u.id)).toBe("retry");
    expect(atGoogle(h)[0]!.suspended).toBe(false);
    expect(await h.links()).toEqual([expect.objectContaining({ active: true })]);
  });

  it("options: google is required, token/auth and groups aren't allowed, url is optional", () => {
    const google = { clientEmail: "a@b.iam.gserviceaccount.com", privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----", adminEmail: "admin@example.com" };
    const t = (x: object) => () => scimProvisioning({ targets: [{ id: "w", ...x } as never] });
    expect(t({ type: "google-workspace", google })).not.toThrow();
    expect(t({ type: "google-workspace" })).toThrow(/takes google/);
    expect(t({ type: "google-workspace", google, token: "t" })).toThrow(/takes google/);
    expect(t({ type: "google-workspace", google, groups: true })).toThrow(/groups/);
    expect(t({ token: "t" })).toThrow(/url is required/);
  });
});
