// Drift detection: a page of the app's own list of accounts against our records. Accounts nobody
// here manages, ours without a link, and linked ones that differ are reported, with what to do;
// nothing is changed. SCIM apps, Google Workspace and Entra ID can be listed; webhook receivers
// can't. Organizations' administrators get it for their own stored targets.
import { describe, expect, it } from "vitest";
import { createHost } from "./support/host";
import { mockScim } from "./support/mock-scim";

type Item = { remoteId: string; userName: string; externalId: string | null; active: boolean | null; userId: string | null; finding: string; detail: string };
type Host = Awaited<ReturnType<typeof createHost>>;

/** Every page of a target's drift, through the server endpoint. */
async function allDrift(h: Host, targetId: string, limit: number) {
  const items: Item[] = [];
  let next: string | null = null;
  let scanned = 0;
  let pages = 0;
  do {
    const page = (await h.auth.api.scimProvisioningDrift({ body: { targetId, limit, ...(next ? { after: next } : {}) } })) as { items: Item[]; scanned: number; next: string | null };
    items.push(...page.items);
    scanned += page.scanned;
    next = page.next;
    pages++;
    if (pages > 50) throw new Error("drift never ends");
  } while (next);
  return { items, scanned, pages };
}

describe("drift", () => {
  it("SCIM: a page at a time; accounts nobody manages, ours without a link, and linked ones that differ; nothing changed", async () => {
    const h = await createHost({ targets: [{ id: "app" }] });
    const ada = await h.user("Ada Lovelace");
    const bo = await h.user("Bo Bell");
    const cy = await h.user("Cy Clone");
    const di = await h.user("Di Gone");
    const ev = await h.user("Ev Fine");
    const at = (email: string) => [...h.app.users.values()].find((u) => u.userName === email)!;
    // Made by hand at the app, and by another tool (an externalId that's no user here).
    h.app.users.set("hand", { id: "hand", userName: "hand@example.com", active: true });
    h.app.users.set("tool", { id: "tool", userName: "tool@example.com", externalId: "some-other-idp", active: true });
    // Ours, its link lost.
    await h.ctx.adapter.deleteMany({ model: "scimProvisioningLink", where: [{ field: "userId", value: bo.id }] });
    // Deactivated at the app behind our back; renamed at the app.
    at(ada.email).active = false;
    at(cy.email).userName = "cy.clone@example.com";
    // Deleted here, but the deprovisioning didn't get through: the link still says active, and so does the app.
    await h.ctx.internalAdapter.deleteUser(di.id);
    await h.settle();
    await h.ctx.adapter.updateMany({ model: "scimProvisioningLink", where: [{ field: "userId", value: di.id }], update: { active: true } });
    at(di.email).active = true;
    const writes = () => h.app.requests.filter((r) => r.method !== "GET").length;
    const before = writes();

    const { items, scanned, pages } = await allDrift(h, "app", 3);
    expect(scanned).toBe(7);
    expect(pages).toBe(3);
    const by = Object.fromEntries(items.map((i) => [i.userName, i]));
    expect(by["hand@example.com"]).toMatchObject({ finding: "unmanaged", userId: null, externalId: null, active: true, detail: expect.stringContaining("made by hand") });
    expect(by["tool@example.com"]).toMatchObject({ finding: "unmanaged", userId: null, externalId: "some-other-idp", detail: expect.stringContaining("some-other-idp") });
    expect(by[bo.email]).toMatchObject({ finding: "unlinked", userId: bo.id, externalId: bo.id });
    expect(by[ada.email]).toMatchObject({ finding: "mismatch", userId: ada.id, active: false, detail: expect.stringContaining("deactivated at the app, active here") });
    expect(by["cy.clone@example.com"]).toMatchObject({ finding: "mismatch", userId: cy.id, detail: expect.stringContaining(`renamed at the app (we sent ${cy.email})`) });
    expect(by[di.email]).toMatchObject({ finding: "mismatch", userId: di.id, detail: expect.stringContaining("deleted here, and the account is still active") });
    expect(by[ev.email]).toBeUndefined();
    expect(items).toHaveLength(6);
    expect(writes()).toBe(before);
    expect(await h.jobs()).toEqual([]);
  });

  it("the first page's cursor is null; a page's `next` is opaque; an unknown target or a webhook is refused", async () => {
    const h = await createHost({ targets: [{ id: "app" }, { id: "hook", type: "webhook" }] });
    await h.user();
    const page = await h.auth.api.scimProvisioningDrift({ body: { targetId: "app" } });
    expect(page).toEqual({ items: [], scanned: 1, next: null });
    await expect(h.auth.api.scimProvisioningDrift({ body: { targetId: "nope" } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(h.auth.api.scimProvisioningDrift({ body: { targetId: "hook" } })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("webhook") });
  });

  it("Google Workspace: the whole directory, a page at a time; an admin's accounts are unmanaged, a suspension made at Google is a mismatch", async () => {
    const h = await createHost({ targets: [{ id: "gw", type: "google-workspace" }] });
    const ada = await h.user("Ada Lovelace");
    h.google.users.set("admin", { id: "admin", primaryEmail: "admin@example.com", name: { givenName: "Ad", familyName: "Min" }, suspended: false });
    [...h.google.users.values()].find((u) => u.primaryEmail === ada.email)!.suspended = true;
    const { items, scanned, pages } = await allDrift(h, "gw", 1);
    expect([scanned, pages]).toEqual([2, 2]);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userName: "admin@example.com", finding: "unmanaged", externalId: null }),
        expect.objectContaining({ userName: ada.email, finding: "mismatch", active: false, userId: ada.id }),
      ]),
    );
    expect(items).toHaveLength(2);
  });

  it("Entra ID: the whole tenant, a page at a time by nextLink; a synced account is unmanaged, an account disabled in Entra is a mismatch; only a /users cursor is followed", async () => {
    const h = await createHost({ targets: [{ id: "entra", type: "entra-id" }] });
    const ada = await h.user("Ada Lovelace");
    h.graph.users.set("synced", { id: "synced", userPrincipalName: "synced@example.com", displayName: "Synced", mailNickname: "synced", accountEnabled: true, onPremisesImmutableId: "AD-GUID" });
    [...h.graph.users.values()].find((u) => u.userPrincipalName === ada.email)!.accountEnabled = false;
    const { items, scanned, pages } = await allDrift(h, "entra", 1);
    expect([scanned, pages]).toEqual([2, 2]);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userName: "synced@example.com", finding: "unmanaged", externalId: "AD-GUID", detail: expect.stringContaining("AD-GUID") }),
        expect.objectContaining({ userName: ada.email, finding: "mismatch", active: false, userId: ada.id }),
      ]),
    );
    await expect(h.auth.api.scimProvisioningDrift({ body: { targetId: "entra", after: "/groups?$top=1" } })).rejects.toThrow(/unknown cursor/);
    expect(h.graph.requests.some((r) => r.path.startsWith("/groups"))).toBe(false);
  });

  it("organizations' administrators get it for their own stored targets; failures in broad terms; a webhook has none", async () => {
    const remote = mockScim();
    const h = await createHost({ targets: [], registry: { fetch: remote.fetch } });
    const signIn = async (email: string) => {
      const up = await h.auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name: email.split("@")[0]! } });
      await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
      await h.settle();
      const res = await h.auth.api.signInEmail({ body: { email, password: "correct-horse-battery" }, asResponse: true });
      return { id: up.user.id, headers: new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) };
    };
    const owner = await signIn("olive@example.com");
    const other = await signIn("oscar@example.com");
    const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: owner.headers }))!;
    // An administrator of another organization: someone else's target is a 404 to them, not a 403.
    await h.auth.api.createOrganization({ body: { name: "Globex", slug: "globex" }, headers: other.headers });
    const create = (settings: Record<string, unknown>, credentials: Record<string, unknown>) =>
      h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings, credentials } as never, headers: owner.headers });
    const { target } = await create({ name: "app", url: "https://app.example.com/scim/v2" }, { token: remote.token });
    await h.settle();
    for (let i = 0; i < 5; i++) await h.auth.api.scimProvisioningRun({ body: {} });
    await h.settle();
    remote.users.set("hand", { id: "hand", userName: "hand@example.com", active: true });
    const drift = (id: string, headers: Headers, body: Record<string, unknown> = {}) => h.auth.api.scimProvisioningTargetDrift({ body: { id, ...body } as never, headers });
    const page = (await drift(target.id, owner.headers)) as { ok: boolean; items: Item[]; scanned: number; next: string | null };
    expect(page.ok).toBe(true);
    expect(page.scanned).toBe(2);
    expect(page.items).toEqual([expect.objectContaining({ userName: "hand@example.com", finding: "unmanaged" })]);
    await expect(drift(target.id, other.headers)).rejects.toMatchObject({ statusCode: 404 });
    const { target: hook } = await create({ name: "hook", type: "webhook", url: "https://hooks.example.com/scim" }, { secret: "a-secret-that-is-at-least-32-characters" });
    expect(await drift(hook.id, owner.headers)).toEqual({ ok: null, problem: expect.stringContaining("webhook") });
    const { target: wrong } = await create({ name: "wrong", url: "https://app.example.com/scim/v2" }, { token: "wrong" });
    expect(await drift(wrong.id, owner.headers)).toEqual({ ok: false, problem: "the credentials were refused", status: 401 });
  });
});

describe("drift: paging and the edges", () => {
  it("SCIM apps that page by cursor (AWS-style), and ones that leave out totalResults", async () => {
    const h = await createHost({ targets: [{ id: "aws", like: "aws" }, { id: "nototal", noTotal: true }] });
    for (let i = 0; i < 5; i++) await h.user(`User ${i}`);
    const first = await h.auth.api.scimProvisioningDrift({ body: { targetId: "aws", limit: 2 } });
    expect(first.next).toMatch(/^c:/);
    const aws = await allDrift(h, "aws", 2);
    expect([aws.scanned, aws.pages, aws.items]).toEqual([5, 3, []]);
    // A cursor app whose directory fits one page: no next cursor and no totalResults, and the app
    // ignores startIndex. The page asked for next is the same one again: dropped, and the end.
    const one = await createHost({ targets: [{ id: "aws", like: "aws" }] });
    await one.user("Only One");
    await one.user("Only Two");
    expect(await allDrift(one, "aws", 2)).toMatchObject({ scanned: 2, pages: 2, items: [] });
    // Without totalResults: full pages mean more, a short page is the last.
    const nt = await allDrift(h, "nototal", 2);
    expect([nt.scanned, nt.pages, nt.items]).toEqual([5, 3, []]);
  });

  it("a cursor it didn't hand out is refused, never sent", async () => {
    const h = await createHost({ targets: [{ id: "app" }] });
    const before = h.app.requests.length;
    for (const after of ["i:abc", "i:-5", "i:0:x", "i:3", "whatever", "c:"]) await expect(h.auth.api.scimProvisioningDrift({ body: { targetId: "app", after } })).rejects.toThrow(/unknown cursor/);
    expect(h.app.requests.length).toBe(before);
  });

  it("a pending create is a mismatch, not 'no link'; a second account for a linked user is said so", async () => {
    const h = await createHost({ targets: [{ id: "app" }] });
    const ada = await h.user("Ada Lovelace");
    const bo = await h.user("Bo Bell");
    // Ada's create is pending (its reply was lost): the link has no remoteId yet.
    await h.ctx.adapter.updateMany({ model: "scimProvisioningLink", where: [{ field: "userId", value: ada.id }], update: { remoteId: "" } });
    // Bo has a second account at the app carrying his externalId.
    h.app.users.set("bo2", { id: "bo2", userName: "bo.bell@example.com", externalId: bo.id, active: true });
    const { items } = await allDrift(h, "app", 10);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userName: ada.email, userId: ada.id, finding: "mismatch", detail: expect.stringContaining("pending") }),
        expect.objectContaining({ userName: "bo.bell@example.com", userId: bo.id, finding: "unlinked", detail: expect.stringContaining("another one") }),
      ]),
    );
    expect(items).toHaveLength(2);
  });

  it("an organization's target: only its members count as users here", async () => {
    const h = await createHost({ targets: [{ id: "app" }] });
    const org = await h.ctx.adapter.create<Record<string, unknown>, { id: string }>({ model: "organization", data: { name: "Acme", slug: "acme", createdAt: new Date() } });
    const { outbox, staticTargets } = await import("../src/outbox");
    const target = { id: "acme", type: "scim" as const, url: h.app.url, token: h.app.token, fetch: h.app.fetch, organizationId: org.id };
    const box = outbox({ targets: [target] }, h.ctx.adapter as never, { warn() {}, error() {} }, staticTargets([target]));
    // Both are at the app (through "app"), with their externalIds; only one is a member.
    const member = await h.user("Mem Ber");
    const outsider = await h.user("Out Sider");
    await h.ctx.adapter.create({ model: "member", data: { userId: member.id, organizationId: org.id, role: "member", createdAt: new Date() } });
    const { items } = await box.drift(target, null, 10);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userName: member.email, finding: "unlinked", userId: member.id }),
        expect.objectContaining({ userName: outsider.email, finding: "unmanaged", userId: null, detail: expect.stringContaining("nobody this target provisions") }),
      ]),
    );
    expect(items).toHaveLength(2);
  });

  it("Entra: Graph's next-page link points at Graph itself, not at a proxy url; only its /users query is kept; a bad link is a plain error", async () => {
    const h = await createHost({ targets: [{ id: "entra", type: "entra-id" }], graphNextLinkBase: "https://graph.microsoft.com/v1.0" });
    await h.user("Ada Lovelace");
    await h.user("Bo Bell");
    const page = await h.auth.api.scimProvisioningDrift({ body: { targetId: "entra", limit: 1 } });
    expect(page.next).toMatch(/^\/users\?/);
    expect((await allDrift(h, "entra", 1)).pages).toBe(2);
    const bad = await createHost({ targets: [{ id: "entra", type: "entra-id" }], graphNextLinkBase: "not a url" });
    await bad.user("Ada Lovelace");
    await bad.user("Bo Bell");
    await expect(bad.auth.api.scimProvisioningDrift({ body: { targetId: "entra", limit: 1 } })).rejects.toThrow(/next page's link/);
  });

  it("an account whose state the app doesn't say isn't a mismatch; an archived Workspace account counts as inactive", async () => {
    const h = await createHost({ targets: [{ id: "entra", type: "entra-id" }] });
    await h.user("Ada Lovelace");
    [...h.graph.users.values()][0]!.accountEnabled = null as never;
    expect((await allDrift(h, "entra", 10)).items).toEqual([]);
    const g = await createHost({ targets: [{ id: "gw", type: "google-workspace" }] });
    const bo = await g.user("Bo Bell");
    Object.assign([...g.google.users.values()][0]!, { archived: true });
    expect((await allDrift(g, "gw", 10)).items).toEqual([expect.objectContaining({ userName: bo.email, finding: "mismatch", active: false })]);
  });

  it("stored targets: a disabled one is still listed (read only); one whose credentials can't be read is refused before any request, and its placeholder keeps the registry's fetch", async () => {
    const remote = mockScim();
    const h = await createHost({ targets: [], registry: { fetch: remote.fetch } });
    const up = await h.auth.api.signUpEmail({ body: { email: "olive@example.com", password: "correct-horse-battery", name: "olive" } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email: "olive@example.com", password: "correct-horse-battery" }, asResponse: true });
    const headers = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
    const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers }))!;
    const { target } = await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings: { name: "app", url: "https://app.example.com/scim/v2" }, credentials: { token: remote.token } } as never, headers });
    await h.settle();
    const drift = () => h.auth.api.scimProvisioningTargetDrift({ body: { id: target.id } as never, headers }) as Promise<{ ok: boolean | null; problem?: string; scanned?: number }>;
    await h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, enabled: false } as never, headers });
    // The owner was provisioned when the target was made: listed, and no drift.
    expect(await drift()).toMatchObject({ ok: true, scanned: 1, items: [] });
    await h.ctx.adapter.updateMany({ model: "scimProvisioningTarget", where: [{ field: "targetId", value: target.id }], update: { sealed: "garbage" } });
    const before = remote.requests.length;
    expect(await drift()).toEqual({ ok: false, problem: expect.stringContaining("can't be read") });
    await expect(h.auth.api.scimProvisioningDrift({ body: { targetId: target.id } })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("can't be read") });
    expect(remote.requests.length).toBe(before);
    // The placeholder the registry builds for it carries the registry's fetch: nothing it ever sends can leave the guard.
    const { registrySource } = await import("../src/registry");
    const source = registrySource([], h.ctx.adapter as never, h.ctx.secretConfig, { fetch: remote.fetch }, { error() {} });
    expect((await source.get(target.id))?.fetch).toBe(remote.fetch);
  });
});
