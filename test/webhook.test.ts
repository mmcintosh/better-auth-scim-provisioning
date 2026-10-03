// Webhook targets (`type: "webhook"`): every change POSTed as a signed event with the full current
// state; receivers check it with verifyWebhookSignature.
import { describe, expect, it } from "vitest";
import { scimProvisioning, verifyWebhookSignature, webhookSignature } from "../src";
import { type Adapter, outbox } from "../src/outbox";
import { createHost } from "./support/host";

const W = { id: "hook", type: "webhook" as const };
const kinds = (h: Awaited<ReturnType<typeof createHost>>) => h.webhook.events.map((e) => e.type);

describe("webhook targets", () => {
  it("a user's life: upserts with the full state, then deactivate; every request signed", async () => {
    const h = await createHost({ targets: [W] });
    const u = await h.user("Ada Lovelace");
    expect(h.webhook.events[0]).toMatchObject({ type: "user.upsert", target: "hook", user: { externalId: u.id, userName: u.email, displayName: "Ada Lovelace", active: true } });
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Byron" });
    await h.settle();
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    await h.ctx.internalAdapter.updateUser(u.id, { banned: false });
    await h.settle();
    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect(kinds(h)).toEqual(["user.upsert", "user.upsert", "user.deactivate", "user.upsert", "user.deactivate"]);
    expect(h.webhook.users.get(u.id)).toMatchObject({ displayName: "Ada Byron", active: false });
    expect(h.webhook.rejected).toEqual([]);
  });

  it("delete mode sends user.delete", async () => {
    const h = await createHost({ targets: [{ ...W, deprovision: "delete" }] });
    const u = await h.user();
    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect(kinds(h)).toEqual(["user.upsert", "user.delete"]);
  });

  it("groups: group.upsert with the members' ids, and group.delete with the organization", async () => {
    const h = await createHost({ targets: [{ ...W, groups: true }] });
    const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
    await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
    const headers = { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers });
    const ada = await h.user("Ada Lovelace");
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "member" } });
    await h.settle();
    expect(h.webhook.groups.get(org!.id)).toEqual({ displayName: "Acme", members: [signUp.user.id, ada.id].sort() });
    await h.auth.api.deleteOrganization({ body: { organizationId: org!.id }, headers });
    await h.settle();
    expect(h.webhook.groups.has(org!.id)).toBe(false);
    expect(kinds(h)).toContain("group.delete");
  });

  it("a receiver's 500 is retried, a 400 fails the job", async () => {
    const h = await createHost({ targets: [W], retry: { baseDelayMs: 0 } });
    h.webhook.fail(500);
    await h.user("One Person");
    expect(await h.jobs()).toEqual([expect.objectContaining({ failed: false, lastStatus: 500 })]);
    expect(await h.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 1 });
    h.webhook.fail(400);
    const v = await h.user("Two Person");
    expect((await h.jobs()).find((j) => j.userId === v.id)).toMatchObject({ failed: true, lastStatus: 400 });
  });

  it("a receiver's 404 is a wrong URL: deprovisioning retries instead of looking done", async () => {
    const h = await createHost({ targets: [W] });
    const u = await h.user();
    const wrong = outbox({ targets: [{ ...W, url: `${h.webhook.url}/wrong`, secret: h.webhook.secret, fetch: h.webhook.fetch }] }, h.ctx.adapter as unknown as Adapter, { warn() {}, error() {} });
    h.db.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?').run(u.id);
    await wrong.enqueue("hook", u.id);
    expect(await wrong.runFor("hook", u.id)).toBe("retry");
    expect(await h.links()).toEqual([expect.objectContaining({ active: true })]);
    expect((await h.jobs())[0]).toMatchObject({ lastError: expect.stringContaining("check the target's url") });
  });

  it("verifyWebhookSignature: refuses a changed body, an old timestamp, and a wrong secret", async () => {
    const secret = "webhook-secret-that-is-at-least-32-characters-long";
    const body = JSON.stringify({ id: "1", type: "user.delete", target: "t", occurredAt: "now", user: { externalId: "u" } });
    const sig = await webhookSignature(secret, body);
    await expect(verifyWebhookSignature({ body, signature: sig, secret })).resolves.toMatchObject({ type: "user.delete" });
    await expect(verifyWebhookSignature({ body: body.replace("delete", "upsert"), signature: sig, secret })).rejects.toThrow(/doesn't match/);
    await expect(verifyWebhookSignature({ body, signature: await webhookSignature(secret, body, Math.floor(Date.now() / 1000) - 600), secret })).rejects.toThrow(/too old/);
    await expect(verifyWebhookSignature({ body, signature: sig, secret: `${secret}x` })).rejects.toThrow(/doesn't match/);
    await expect(verifyWebhookSignature({ body, signature: null, secret })).rejects.toThrow(/missing/);
  });

  it("options: a secret of 32+ characters is required, and no token, auth or google", () => {
    const t = (x: object) => () => scimProvisioning({ targets: [{ id: "w", url: "https://hooks.example.com/x", ...x } as never] });
    expect(t({ type: "webhook", secret: "s".repeat(32) })).not.toThrow();
    expect(t({ type: "webhook", secret: "short" })).toThrow(/32/);
    expect(t({ type: "webhook" })).toThrow(/url and secret/);
    expect(t({ type: "webhook", secret: "s".repeat(32), token: "t" })).toThrow(/url and secret/);
    expect(t({ token: "t", secret: "s".repeat(32) })).toThrow(/secret is for webhook/);
  });
});
