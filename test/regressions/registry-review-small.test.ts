// Smaller registry fixes: a profile's refusal is a 400, changes need a fresh session, a host
// reconcile survives an organization deleting a target its cursor names, and a target whose
// credentials couldn't be read recovers on its own once the secret is right.
import { describe, expect, it, vi } from "vitest";
import { type Adapter, UNREADABLE_RETRY_MS } from "../../src/outbox";
import { registrySource, seal, TARGET_MODEL } from "../../src/registry";
import { createHost } from "../support/host";
import { mockScim } from "../support/mock-scim";

async function setup() {
  const remote = mockScim();
  const h = await createHost({ targets: [], registry: { fetch: remote.fetch, canManage: ({ user }) => user.email === "root@example.com" } });
  const signIn = async (email: string) => {
    const up = await h.auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name: email.split("@")[0]! } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email, password: "correct-horse-battery" }, asResponse: true });
    return { id: up.user.id, headers: new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) };
  };
  const owner = await signIn("olive@example.com");
  const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: owner.headers }))!;
  await h.settle();
  return { h, remote, owner, acme, signIn };
}
const status = (p: Promise<unknown>) => p.then(() => 200, (e: { statusCode?: number; status?: unknown }) => e.statusCode ?? 500);

describe("registry: small fixes", () => {
  it("githubEnterprise with deprovision \"delete\" is a 400 with the profile's reason", async () => {
    const { h, owner, acme, remote } = await setup();
    const s = await status(h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings: { url: "https://app.example.com/scim/v2", profile: "githubEnterprise", deprovision: "delete" }, credentials: { token: remote.token } }, headers: owner.headers }));
    expect(s).toBe(400);
  });

  it("a session created 6 days ago (not fresh: freshAge is 1 day) may not connect a target", async () => {
    const { h, owner, acme, remote } = await setup();
    const old = new Date(Date.now() - 6 * 24 * 3600_000);
    await h.ctx.adapter.updateMany({ model: "session", where: [{ field: "userId", value: owner.id }], update: { createdAt: old, updatedAt: old } });
    const s = await status(h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: remote.token } }, headers: owner.headers }));
    // README: "a signed-in user with a fresh session". Better Auth's freshSessionMiddleware answers 403 here.
    expect(s).toBe(403);
  });

  it("a host reconcile goes on when an organization deletes the target its cursor names", async () => {
    const { h, owner, acme, remote } = await setup();
    const a = await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: remote.token } }, headers: owner.headers });
    await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: remote.token } }, headers: owner.headers });
    await h.settle();
    let next: string | null = null;
    for (let i = 0; i < 20; i++) {
      next = (await h.auth.api.scimProvisioningReconcile({ body: { limit: 1, ...(next ? { after: next } : {}) } })).next;
      if (next?.includes(a.target.id)) break;
    }
    expect(next).toContain(a.target.id);
    await h.auth.api.scimProvisioningDeleteTarget({ body: { id: a.target.id }, headers: owner.headers });
    expect(await status(h.auth.api.scimProvisioningReconcile({ body: { limit: 1, after: next! } }))).toBe(200);
  });

  it("jobs held while the credentials couldn't be read go once the secret is back", async () => {
    const { h, remote, acme } = await setup();
    const KEY = "test-secret-that-is-at-least-32-characters-long"; // the host's own secret
    await h.ctx.adapter.create({ model: TARGET_MODEL, data: { targetId: "t1", organizationId: acme.id, type: "scim", config: JSON.stringify({ url: "https://app.example.com/scim/v2" }), sealed: await seal(KEY, "t1", acme.id, { token: remote.token }, { url: "https://app.example.com/scim/v2" }), enabled: true, createdAt: new Date(), updatedAt: new Date() } });
    const adapter = h.ctx.adapter as unknown as Adapter;
    // A deploy with the wrong secret: the target reads as unreadable (paused); a member's change is parked.
    const wrong = registrySource([], adapter, "a-wrong-secret-that-is-at-least-32-characters", { fetch: remote.fetch }, { error: () => {} });
    const { outbox } = await import("../../src/outbox");
    const box1 = outbox({ targets: [] }, adapter, { warn: () => {}, error: () => {} }, wrong);
    const ada = await h.user("Ada Lovelace");
    await h.ctx.adapter.create({ model: "member", data: { userId: ada.id, organizationId: acme.id, role: "member", createdAt: new Date() } });
    await box1.enqueue("t1", ada.id);
    await box1.runDue();
    // The secret is put back (the next deploy). Code comment: "its jobs wait until it's given new credentials (or the secret is back)".
    const right = registrySource([], adapter, KEY, { fetch: remote.fetch }, { error: () => {} });
    const box2 = outbox({ targets: [] }, adapter, { warn: () => {}, error: () => {} }, right);
    const [job] = (await adapter.findMany({ model: "scimProvisioningJob" })) as { nextAttemptAt: Date; attempts: number }[];
    // Not parked for good: tried again within UNREADABLE_RETRY_MS, no attempt counted.
    expect(new Date(job!.nextAttemptAt).getTime()).toBeLessThanOrEqual(Date.now() + UNREADABLE_RETRY_MS);
    expect(job!.attempts).toBe(0);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + UNREADABLE_RETRY_MS + 1000);
      await box2.runDue();
    } finally {
      vi.useRealTimers();
    }
    expect([...remote.users.values()].map((u) => u.displayName)).toContain("Ada Lovelace");
  });
});
