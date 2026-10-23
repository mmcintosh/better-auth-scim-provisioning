// A create with a `requestId` is safe to retry: the same request makes one target, and a retry (or
// a second at once) gets that target back, marked `replayed`; a request that asks for something
// else with the same id is refused, as is one whose target was removed since (with `audit`).
import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import { describe, expect, it } from "vitest";
import type { TargetRegistryOptions } from "../src";
import { createHost, schemaOptions } from "./support/host";
import { mockScim } from "./support/mock-scim";

async function setup(o: { audit?: boolean; registry?: Omit<TargetRegistryOptions, "fetch">; memory?: boolean } = {}) {
  const remote = mockScim();
  const h = await createHost({
    targets: [],
    ...(o.audit === false ? {} : { audit: true }),
    registry: { fetch: remote.fetch, ...o.registry },
    // The memory adapter wants each table up front.
    ...(o.memory ? { database: { database: memoryAdapter(Object.fromEntries(Object.values(getAuthTables(schemaOptions() as never)).map((t) => [t.modelName, []]))), migrate: false } } : {}),
  });
  const signIn = async (email: string) => {
    const up = await h.auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name: email.split("@")[0]! } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email, password: "correct-horse-battery" }, asResponse: true });
    return new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
  };
  const owner = await signIn("olive@example.com");
  const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: owner }))!;
  const body = { organizationId: acme.id, settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: remote.token }, requestId: "req-2026-10-23-0001" };
  const create = (b: Record<string, unknown> = {}, headers = owner) =>
    h.auth.api.scimProvisioningCreateTarget({ body: { ...body, ...b } as never, headers }) as Promise<{ target: { id: string }; replayed?: true }>;
  const rows = () => h.ctx.adapter.count({ model: "scimProvisioningTarget" });
  return { h, remote, signIn, owner, acme, body, create, rows };
}

const status = (p: Promise<unknown>) => p.then(() => 200, (e: { statusCode?: number }) => e.statusCode);

describe("a create with a requestId", () => {
  it("made twice is one target: the second is the first, replayed, with no second resync or audit event", async () => {
    const { h, remote, create, rows } = await setup();
    const first = await create();
    await h.settle();
    const posts = remote.requests.filter((r) => r.method === "POST").length;
    const again = await create();
    await h.settle();
    expect(again).toMatchObject({ target: { id: first.target.id }, replayed: true });
    expect(first.replayed).toBeUndefined();
    expect(await rows()).toBe(1);
    expect(remote.requests.filter((r) => r.method === "POST").length).toBe(posts);
    const { items } = await h.auth.api.scimProvisioningAuditEvents({ body: {} });
    expect(items.map((e) => e.action)).toEqual(["target.created"]);
  });

  it("two at once make one target, and both get it", async () => {
    const { create, rows } = await setup();
    const both = await Promise.all([create(), create()]);
    expect(both[0].target.id).toBe(both[1].target.id);
    expect(both.filter((r) => r.replayed)).toHaveLength(1);
    expect(await rows()).toBe(1);
  });

  it("with other settings, credentials or enabled is refused (409); so is one after a change", async () => {
    const { h, remote, owner, create, rows } = await setup();
    const { target } = await create();
    expect(await status(create({ settings: { url: "https://other.example.com/scim/v2" } }))).toBe(409);
    expect(await status(create({ credentials: { token: `${remote.token}-2` } }))).toBe(409);
    expect(await status(create({ enabled: false }))).toBe(409);
    expect(await rows()).toBe(1);
    await h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, enabled: false }, headers: owner });
    expect(await status(create())).toBe(409);
  });

  it("whose target was removed since is refused, with the audit history; without it, makes a new one", async () => {
    const { h, owner, create, rows } = await setup();
    const { target } = await create();
    await h.auth.api.scimProvisioningDeleteTarget({ body: { id: target.id }, headers: owner });
    expect(await status(create())).toBe(409);
    expect(await rows()).toBe(0);
    const plain = await setup({ audit: false });
    const made = await plain.create();
    await plain.h.auth.api.scimProvisioningDeleteTarget({ body: { id: made.target.id }, headers: plain.owner });
    expect(await status(plain.create())).toBe(200);
    expect(await plain.rows()).toBe(1);
  });

  it("is repeated even at the cap, belongs to its organization, and must look like an id", async () => {
    const { h, signIn, create, rows } = await setup({ registry: { maxTargetsPerOrganization: 1 } });
    await create();
    expect(await create()).toMatchObject({ replayed: true });
    expect(await status(create({ requestId: "req-2026-10-23-0002" }))).toBe(409);
    // Another organization's own request, with the same id: its own target.
    const oscar = await signIn("oscar@example.com");
    const globex = (await h.auth.api.createOrganization({ body: { name: "Globex", slug: "globex" }, headers: oscar }))!;
    const theirs = await create({ organizationId: globex.id }, oscar);
    expect(theirs.replayed).toBeUndefined();
    expect(await rows()).toBe(2);
    // Someone else can't replay an organization's create to see its target.
    expect(await status(create({}, oscar))).toBe(403);
    expect(await status(create({ requestId: "short" }))).toBe(400);
    expect(await status(create({ requestId: "has spaces in it" }))).toBe(400);
  });

  it("two at once on a database that doesn't enforce unique fields (MongoDB's, Better Auth's memory adapter): still one", async () => {
    const { create, rows } = await setup({ memory: true });
    const both = await Promise.all([create(), create(), create()]);
    expect(new Set(both.map((r) => r.target.id)).size).toBe(1);
    expect(both.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await rows()).toBe(1);
  });

  it("without one, two creates make two targets, as before", async () => {
    const { create, rows } = await setup();
    await create({ requestId: undefined });
    await create({ requestId: undefined });
    expect(await rows()).toBe(2);
  });
});
