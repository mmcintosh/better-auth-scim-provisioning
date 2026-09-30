import { describe, expect, it } from "vitest";
import { scimProvisioning } from "../src";
import { createHost } from "./support/host";

const appUsers = (app: { users: Map<string, unknown> }) => [...app.users.values()] as Record<string, any>[];

describe("provisioning a user's life", () => {
  it("a verified user is created at the app, with names split and externalId set", async () => {
    const h = await createHost();
    const u = await h.user("Ada King Lovelace");
    expect(appUsers(h.app)).toEqual([
      expect.objectContaining({ userName: u.email, externalId: u.id, active: true, name: expect.objectContaining({ givenName: "Ada King", familyName: "Lovelace" }), displayName: "Ada King Lovelace" }),
    ]);
    expect(await h.links()).toEqual([expect.objectContaining({ targetId: "app", userId: u.id, active: true })]);
    expect(await h.jobs()).toEqual([]);
  });

  it("an unverified user isn't provisioned until verified", async () => {
    const h = await createHost();
    const u = await h.user("Grace Hopper", false);
    expect(h.app.users.size).toBe(0);
    await h.ctx.internalAdapter.updateUser(u.id, { emailVerified: true });
    await h.settle();
    expect(appUsers(h.app)).toEqual([expect.objectContaining({ userName: u.email })]);
  });

  it("a one-word name fills both names (apps like AWS require both)", async () => {
    const h = await createHost();
    await h.user("Cher");
    expect(appUsers(h.app)[0]?.name).toMatchObject({ givenName: "Cher", familyName: "Cher" });
  });

  it("changes are replaced at the app, including a new email as userName, with one user kept", async () => {
    const h = await createHost();
    const u = await h.user();
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Byron", email: "ada@byron.example" });
    await h.settle();
    expect(appUsers(h.app)).toEqual([expect.objectContaining({ userName: "ada@byron.example", displayName: "Ada Byron" })]);
    expect(h.app.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("a ban deactivates, an unban reactivates, and a deletion deactivates", async () => {
    const h = await createHost();
    const u = await h.user();
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(appUsers(h.app)[0]?.active).toBe(false);
    await h.ctx.internalAdapter.updateUser(u.id, { banned: false });
    await h.settle();
    expect(appUsers(h.app)[0]?.active).toBe(true);
    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect(appUsers(h.app)).toEqual([expect.objectContaining({ userName: u.email, active: false })]);
    expect(await h.links()).toEqual([expect.objectContaining({ active: false })]);
  });

  it("deprovision: delete removes the user at the app and the link", async () => {
    const h = await createHost({ targets: [{ id: "app", deprovision: "delete" }] });
    const u = await h.user();
    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect(h.app.users.size).toBe(0);
    expect(await h.links()).toEqual([]);
  });

  it("a user who already exists at the app is adopted, not duplicated", async () => {
    const h = await createHost();
    const existing = await h.user("Placeholder", false);
    // Provisioned by hand at the app before Better Auth knew.
    await h.app.fetch(`${h.app.url}/Users`, { method: "POST", headers: { authorization: `Bearer ${h.app.token}` }, body: JSON.stringify({ userName: existing.email.toUpperCase(), name: { givenName: "Old", familyName: "Entry" }, active: false }) });
    await h.ctx.internalAdapter.updateUser(existing.id, { emailVerified: true, name: "Linus Torvalds" });
    await h.settle();
    expect(appUsers(h.app)).toEqual([expect.objectContaining({ displayName: "Linus Torvalds", active: true, externalId: existing.id })]);
  });

  it("a user removed at the app since is created again", async () => {
    const h = await createHost();
    const u = await h.user();
    h.app.users.clear();
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Again" });
    await h.settle();
    expect(appUsers(h.app)).toEqual([expect.objectContaining({ displayName: "Ada Again" })]);
  });
});

describe("holding up", () => {
  it("a 429 is retried after Retry-After, and delivered by the scheduled run", async () => {
    const h = await createHost({ retry: { baseDelayMs: 0 } });
    h.app.fail({ status: 429, retryAfter: "0" });
    const u = await h.user();
    expect(h.app.users.size).toBe(0);
    expect(await h.jobs()).toEqual([expect.objectContaining({ attempts: 1, failed: false, lastError: expect.stringContaining("429") })]);
    expect(await h.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 1 });
    expect(appUsers(h.app)).toEqual([expect.objectContaining({ userName: u.email })]);
    expect(await h.jobs()).toEqual([]);
  });

  it("backs off: a failed attempt isn't due again until its delay has passed", async () => {
    const h = await createHost({ retry: { baseDelayMs: 60_000 } });
    h.app.fail({ status: 503 });
    await h.user();
    expect(await h.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 0, retry: 0 });
    expect(h.app.users.size).toBe(0);
  });

  it("an error that won't fix itself fails the job until the user changes again", async () => {
    const h = await createHost({ retry: { baseDelayMs: 0 } });
    h.app.fail({ status: 400, detail: "bad attribute" });
    const u = await h.user();
    expect(await h.jobs()).toEqual([expect.objectContaining({ failed: true, attempts: 1 })]);
    expect(await h.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 0 });
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Fixed Name" });
    await h.settle();
    expect(appUsers(h.app)).toEqual([expect.objectContaining({ displayName: "Fixed Name" })]);
  });

  it("gives up after maxAttempts", async () => {
    const h = await createHost({ retry: { baseDelayMs: 0, maxAttempts: 3 } });
    h.app.fail({ status: 500 }, { status: 500 }, { status: 500 });
    await h.user();
    await h.auth.api.scimProvisioningRun({ body: {} });
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect(await h.jobs()).toEqual([expect.objectContaining({ attempts: 3, failed: true })]);
  });

  it("two workers on the same job: one delivers, the other is told it's busy", async () => {
    const h = await createHost({ retry: { baseDelayMs: 0 } });
    h.app.fail({ status: 503 });
    await h.user();
    const job = (await h.jobs())[0] as any;
    const [a, b] = await Promise.all([h.auth.api.scimProvisioningRun({ body: {} }), h.auth.api.scimProvisioningRun({ body: {} })]);
    expect(a.done + b.done).toBe(1);
    expect(a.busy + b.busy).toBe(1);
    expect(h.app.users.size).toBe(1);
    expect(job).toBeTruthy();
  });

  it("a change during delivery is delivered too (the latest state wins)", async () => {
    const h = await createHost();
    const u = await h.user("First Name");
    const release = h.app.hold();
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Second Name" }); // delivery starts, then waits at the app
    await new Promise((r) => setTimeout(r, 20));
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Third Name" }); // bumps the job while it's claimed
    release();
    await h.settle();
    // The delivery in flight sent "Second Name", saw the job bumped, and went round again at once.
    expect(h.app.requests.filter((r) => r.method === "PUT").map((r) => (r.body as { displayName: string }).displayName)).toEqual(["First Name", "Second Name", "Third Name"].slice(1));
    expect(appUsers(h.app)[0]?.displayName).toBe("Third Name");
    expect(await h.jobs()).toEqual([]);
  });

  it("a failure to queue never fails the user's own write", async () => {
    const h = await createHost();
    const u = await h.user();
    h.db.exec('DROP TABLE "scimProvisioningJob"');
    const updated = await h.ctx.internalAdapter.updateUser(u.id, { name: "Still Saved" });
    expect(updated?.name).toBe("Still Saved");
    expect((await h.ctx.internalAdapter.findUserById(u.id))?.name).toBe("Still Saved");
  });
});

describe("organizations and reconcile", () => {
  it("an organization target provisions its members only, and deprovisions on removal", async () => {
    const h = await createHost({ targets: [{ id: "org-app", organizationId: "org-acme" }] });
    const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Owner Person" }, asResponse: true });
    const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const owner = (await h.ctx.internalAdapter.findUserByEmail("owner@example.com"))!.user;
    await h.ctx.adapter.create({ model: "organization", data: { id: "org-acme", name: "Acme", slug: "acme", createdAt: new Date() }, forceAllowId: true });
    await h.ctx.adapter.create({ model: "member", data: { organizationId: "org-acme", userId: owner.id, role: "owner", createdAt: new Date() } });
    const outsider = await h.user("Out Sider");
    const member = await h.user("In Sider");
    expect(h.app.users.size).toBe(0); // verified, but not members

    await h.auth.api.addMember({ body: { userId: member.id, organizationId: "org-acme", role: "member" } });
    await h.settle();
    expect(appUsers(h.app)).toEqual([expect.objectContaining({ userName: member.email, active: true })]);

    await h.auth.api.removeMember({ body: { memberIdOrEmail: member.email, organizationId: "org-acme" }, headers: { cookie } });
    await h.settle();
    expect(appUsers(h.app)).toEqual([expect.objectContaining({ userName: member.email, active: false })]);
    expect(outsider.id).toBeTruthy();
  });

  it("reconcile queues every user for a new target, and the run delivers them", async () => {
    const h = await createHost();
    await h.user("One Person");
    await h.user("Two Person");
    h.app.users.clear();
    await h.ctx.adapter.deleteMany({ model: "scimProvisioningLink", where: [] });
    expect(await h.auth.api.scimProvisioningReconcile({ body: {} })).toEqual({ queued: 2 });
    expect(await h.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 2 });
    expect(h.app.users.size).toBe(2);
  });
});

describe("options", () => {
  it("refuses bad targets", () => {
    expect(() => scimProvisioning({ targets: [{ id: "a b", url: "https://x.test/scim/v2", token: "t" }] })).toThrow(/targets\.0\.id/);
    expect(() => scimProvisioning({ targets: [{ id: "a", url: "http://x.test/scim/v2", token: "t" }] })).toThrow(/https/);
    expect(() => scimProvisioning({ targets: [{ id: "a", url: "https://x.test", token: "" }] })).toThrow(/token/);
    expect(() => scimProvisioning({ targets: [{ id: "a", url: "https://x.test", token: "t" }, { id: "a", url: "https://y.test", token: "t" }] })).toThrow(/unique/);
    expect(() => scimProvisioning({ targets: [{ id: "a", url: "http://localhost:8080/scim/v2", token: "t" }] })).not.toThrow();
  });
});
