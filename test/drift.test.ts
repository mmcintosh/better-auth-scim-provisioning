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
