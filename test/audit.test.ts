// The audit history (`audit`): who connected, changed, removed or decommissioned which target, and
// when, kept in its own table and listed newest first; organizations' administrators see their own
// organization's, removed targets included; never a secret; old events go with `keepDays`.
import { describe, expect, it, vi } from "vitest";
import type { AuditEvent, ScimProvisioningOptions, TargetRegistryOptions } from "../src";
import { createHost } from "./support/host";
import { mockScim } from "./support/mock-scim";

async function setup(o: { audit?: ScimProvisioningOptions["audit"]; registry?: Omit<TargetRegistryOptions, "fetch"> } = {}) {
  const remote = mockScim();
  const h = await createHost({ targets: [], decommission: true, audit: o.audit ?? true, registry: { fetch: remote.fetch, ...o.registry } });
  const signIn = async (email: string) => {
    const up = await h.auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name: email.split("@")[0]! } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email, password: "correct-horse-battery" }, asResponse: true });
    return { id: up.user.id, headers: new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) };
  };
  const owner = await signIn("olive@example.com");
  const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: owner.headers }))!;
  const create = async () => (await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: remote.token } }, headers: owner.headers })).target;
  const events = (body: Record<string, unknown> = {}, headers = owner.headers) => h.auth.api.scimProvisioningTargetEvents({ body: body as never, headers }) as Promise<{ items: AuditEvent[]; next: string | null }>;
  return { h, remote, signIn, owner, acme, create, events };
}

const status = (p: Promise<unknown>) => p.then(() => 200, (e: { statusCode?: number }) => e.statusCode);

describe("the audit history", () => {
  it("records each change to an organization's target, newest first, with who; never a secret", async () => {
    const { h, remote, owner, acme, create, events } = await setup();
    const target = await create();
    await h.settle();
    await h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, credentials: { token: remote.token } }, headers: owner.headers });
    await h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, enabled: false }, headers: owner.headers });
    await h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, enabled: true }, headers: owner.headers });
    await h.settle();
    await h.auth.api.scimProvisioningDecommissionTarget({ body: { id: target.id, confirm: 1 }, headers: owner.headers });
    await h.auth.api.scimProvisioningDecommissionTarget({ body: { id: target.id, cancel: true }, headers: owner.headers });
    await h.settle();
    await h.auth.api.scimProvisioningDeleteTarget({ body: { id: target.id }, headers: owner.headers });
    const { items, next } = await events();
    expect(next).toBeNull();
    expect(items.map((e) => [e.action, e.detail])).toEqual([
      ["target.deleted", { abandoned: { accounts: 1, groups: 0 } }],
      ["decommission.cancelled", { accounts: expect.any(Number), groups: 0 }],
      ["decommission.started", { accounts: 1, groups: 0 }],
      ["target.updated", { changed: ["enabled"], enabled: true }],
      ["target.updated", { changed: ["enabled"], enabled: false }],
      ["target.updated", { changed: ["credentials"], enabled: true }],
      ["target.created", { type: "scim", url: "https://app.example.com/scim/v2", enabled: true }],
    ]);
    for (const e of items) expect(e).toMatchObject({ targetId: target.id, organizationId: acme.id, actor: `user:${owner.id}`, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    // Newest first, and the token is nowhere.
    expect([...items].map((e) => e.at)).toEqual([...items].map((e) => e.at).sort().reverse());
    expect(JSON.stringify(items)).not.toContain(remote.token);
    // One target's (removed, here) by id.
    expect((await events({ id: target.id })).items).toHaveLength(7);
    expect((await events({ id: "t-other" })).items).toEqual([]);
  });

  it("pages by `next`, and refuses a made-up one", async () => {
    const { h, owner, create, events } = await setup();
    const target = await create();
    for (const enabled of [false, true, false]) await h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, enabled }, headers: owner.headers });
    const first = await events({ limit: 3 });
    expect(first.items.map((e) => e.detail.enabled)).toEqual([false, true, false]);
    const second = await events({ limit: 3, after: first.next });
    expect(second).toEqual({ items: [expect.objectContaining({ action: "target.created" })], next: null });
    expect(await status(events({ after: "x' OR 1=1" }))).toBe(400);
  });

  it("an organization's administrators see their own organization's only; a host administrator, any", async () => {
    const { h, signIn, owner, acme, create, events } = await setup({ registry: { canManage: ({ user }) => user.email === "root@example.com" } });
    await create();
    const oscar = await signIn("oscar@example.com");
    await h.auth.api.createOrganization({ body: { name: "Globex", slug: "globex" }, headers: oscar.headers });
    expect((await events({}, oscar.headers)).items).toEqual([]);
    expect(await status(events({ organizationId: acme.id }, oscar.headers))).toBe(403);
    const member = await signIn("mo@example.com");
    await h.auth.api.addMember({ body: { userId: member.id, organizationId: acme.id, role: "member" } });
    expect(await status(events({}, member.headers))).toBe(403);
    const root = await signIn("root@example.com");
    expect((await events({}, root.headers)).items).toHaveLength(1);
    expect((await events({ organizationId: acme.id }, root.headers)).items).toEqual([expect.objectContaining({ action: "target.created", actor: `user:${owner.id}` })]);
  });

  it("records a code target's decommission: started and cancelled by the server, completed by the plugin", async () => {
    const h = await createHost({ decommission: true, audit: true, targets: [{ id: "app", decommission: true }] });
    await h.user();
    const decommission = (body: Record<string, unknown>) => h.auth.api.scimProvisioningDecommission({ body: { targetId: "app", ...body } as never });
    await decommission({ confirm: 0 });
    await decommission({ cancel: true });
    await decommission({ confirm: 0 });
    await h.settle();
    for (let i = 0; i < 10; i++) {
      await h.auth.api.scimProvisioningRun({ body: {} });
      await h.ctx.adapter.updateMany({ model: "scimProvisioningJob", where: [], update: { nextAttemptAt: new Date(Date.now() - 1000) } });
    }
    const { items } = await h.auth.api.scimProvisioningAuditEvents({ body: { targetId: "app" } });
    expect(items.map((e) => [e.action, e.actor, e.organizationId])).toEqual([
      ["decommission.completed", "system", null],
      ["decommission.started", "server", null],
      ["decommission.cancelled", "server", null],
      ["decommission.started", "server", null],
    ]);
  });

  it("hands each event to onEvent; one that throws is logged, not in the way", async () => {
    const onEvent = vi.fn().mockRejectedValueOnce(new Error("SIEM down"));
    const { h, owner, create } = await setup({ audit: { onEvent } });
    const target = await create();
    await h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, enabled: false }, headers: owner.headers });
    expect(onEvent.mock.calls.map(([e]) => (e as AuditEvent).action)).toEqual(["target.created", "target.updated"]);
  });

  it("with keepDays, the scheduled run removes older events", async () => {
    const { h, create, events } = await setup({ audit: { keepDays: 30 } });
    await create();
    const old = new Date(Date.now() - 31 * 86_400_000);
    await h.ctx.adapter.create({ model: "scimProvisioningAuditEvent", data: { key: `${old.toISOString()}~0000000000000000`, createdAt: old, targetId: "t-gone", organizationId: (await events()).items[0]!.organizationId, actor: "user:x", action: "target.deleted", detail: "{}" } });
    expect((await events()).items).toHaveLength(2);
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect((await events()).items.map((e) => e.action)).toEqual(["target.created"]);
  });

  it("without the option: nothing recorded, and the routes say so", async () => {
    const remote = mockScim();
    const h = await createHost({ targets: [], registry: { fetch: remote.fetch } });
    await expect(h.auth.api.scimProvisioningAuditEvents({ body: {} })).rejects.toThrow(/needs the plugin's `audit` option/);
    expect(await h.ctx.adapter.count({ model: "scimProvisioningAuditEvent" }).catch(() => "no table")).toBe("no table");
  });
});
