// The external review before 0.1.0 (D-009). Each test failed before its fix.
import { describe, expect, it } from "vitest";
import { defaultScimUser } from "../../src";
import { parseAuthFile } from "../../src/doctor";
import { type Adapter, outbox } from "../../src/outbox";
import { createHost } from "../support/host";

type Host = Awaited<ReturnType<typeof createHost>>;

async function owner(h: Host) {
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  return { headers: { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } };
}

const at = (h: Host) => ({ "content-type": "application/scim+json", authorization: `Bearer ${h.app.token}` });

describe("external review", () => {
  it("X-1: a hand-made group isn't taken over after a timed-out first create (apps without externalId)", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true, keepsExternalId: false, timeoutMs: 200 }], retry: { baseDelayMs: 0 } });
    const o = await owner(h);
    const hand = (await (await h.app.fetch(`${h.app.url}/Users`, { method: "POST", headers: at(h), body: JSON.stringify({ userName: "hand@example.com", name: { givenName: "Hand", familyName: "Made" } }) })).json()) as { id: string };
    await h.app.fetch(`${h.app.url}/Groups`, { method: "POST", headers: at(h), body: JSON.stringify({ displayName: "Acme", members: [{ value: hand.id }] }) });
    h.app.fail({ timeout: true });
    await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
    await h.settle();
    await h.auth.api.scimProvisioningRun({ body: {} });
    await h.settle();
    expect([...h.app.groups.values()]).toEqual([expect.objectContaining({ displayName: "Acme", members: [{ value: hand.id }] })]);
  });

  it("X-2: with a custom userName, an unowned account is adopted only if its userName is the user's verified email", async () => {
    const h = await createHost({ targets: [{ id: "app", mapUser: (u) => ({ ...defaultScimUser(u), userName: u.name.toLowerCase() }) }] });
    await h.app.fetch(`${h.app.url}/Users`, { method: "POST", headers: at(h), body: JSON.stringify({ userName: "admin", emails: [{ value: "real-admin@example.com" }], name: { givenName: "Real", familyName: "Admin" } }) });
    const attacker = await h.ctx.internalAdapter.createUser({ email: "attacker@example.com", name: "Admin", emailVerified: true }, { method: "admin" });
    await h.settle();
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ userName: "admin", emails: [{ value: "real-admin@example.com" }] })]);
    expect(await h.jobs()).toEqual([expect.objectContaining({ userId: attacker.id, failed: true })]);
  });

  it("X-3: groups can be a filter, so not every organization a user creates becomes a group", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: (org: { slug: string | null }) => (org.slug ?? "").startsWith("team-") } as never] });
    const o = await owner(h);
    await h.auth.api.createOrganization({ body: { name: "Administrators", slug: "administrators" }, headers: o.headers });
    await h.auth.api.createOrganization({ body: { name: "Team Red", slug: "team-red" }, headers: o.headers });
    await h.settle();
    expect([...h.app.groups.values()].map((g) => g.displayName)).toEqual(["Team Red"]);
  });

  it("X-4: the lease outlasts the longest delivery (find and create twice, 401 retries, a token request)", async () => {
    const h = await createHost({ targets: [{ id: "app", timeoutMs: 60_000 }] });
    const u = await h.user();
    const release = h.app.hold();
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Changed Name" });
    await new Promise((r) => setTimeout(r, 50));
    const [job] = await h.jobs();
    expect(new Date(job!.lockedUntil as Date).getTime() - Date.now()).toBeGreaterThan(12 * 60_000);
    release();
    await h.settle();
  });

  it("X-5: check's --auth file may hold the auth object or { auth }, and a wrong one is a clear error", () => {
    const basic = { type: "basic", username: "u", password: "p" };
    expect(parseAuthFile(JSON.stringify(basic))).toEqual(basic);
    expect(parseAuthFile(JSON.stringify({ auth: basic }))).toEqual(basic);
    expect(() => parseAuthFile(JSON.stringify({ auth: { type: "oauth2", clientId: "x" } }))).toThrow(/tokenUrl/);
    expect(() => parseAuthFile("{")).toThrow(/JSON/);
  });

  it("X-6: an error in the host's own code (mapUser) fails the job after maxAttempts, not every 6 hours forever", async () => {
    let throwing = false;
    const h = await createHost({ targets: [{ id: "app", mapUser: (u) => { if (throwing) throw new Error("mapUser broke"); return defaultScimUser(u); } }], retry: { baseDelayMs: 0, maxAttempts: 2 } });
    const u = await h.user();
    throwing = true;
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Changed Name" });
    await h.settle();
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect(await h.jobs()).toEqual([expect.objectContaining({ failed: true, attempts: 2, lastError: expect.stringContaining("mapUser broke") })]);
  });

  it("X-7: a group's failure is logged as a group, not as a user", async () => {
    const h = await createHost();
    const lines: string[] = [];
    const log = { warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
    const box = outbox({ targets: [{ id: "app", url: `${h.app.url}/wrong`, token: h.app.token, fetch: h.app.fetch, groups: true }] }, h.ctx.adapter as unknown as Adapter, log);
    await h.ctx.adapter.create({ model: "organization", data: { id: "org-1", name: "Acme", slug: "acme", createdAt: new Date() }, forceAllowId: true });
    await box.enqueue("app", "org-1", { kind: "group" });
    await box.runFor("app", "org-1", "group");
    expect(lines.join("\n")).toContain("group org-1");
    expect(lines.join("\n")).not.toContain("user org-1");
  });
});
