// The rest of RFC 7643's user attributes: preferredLanguage, locale, timezone and userType (with
// `attributes`, checked before they're sent), roles (`roles`: organization roles) and
// entitlements (`entitlements`: from your code); each cleared when it has no value.
import { describe, expect, it, vi } from "vitest";
import { scimProvisioning } from "../src";
import { createHost } from "./support/host";

const FIELDS = { preferredLanguage: { type: "string" }, locale: { type: "string" }, timezone: { type: "string" }, userType: { type: "string" }, tz: { type: "string" } } as const;

async function setup(target: Record<string, unknown> = {}) {
  const h = await createHost({ targets: [{ id: "app", attributes: true, ...target }], userFields: FIELDS });
  const set = async (id: string, fields: Record<string, unknown>) => {
    await h.ctx.internalAdapter.updateUser(id, fields);
    await h.settle();
  };
  const remote = (email: string) => [...h.app.users.values()].find((u) => u.userName === email) as any;
  const lastPatch = () => [...h.app.requests].reverse().find((r) => r.method === "PATCH" && r.path.startsWith("/Users/"))?.body as { Operations: { op: string; path?: string }[] } | undefined;
  return { h, set, remote, lastPatch };
}

describe("RFC 7643's other user attributes", () => {
  it("preferredLanguage, locale, timezone and userType, from fields of those names; empty ones cleared", async () => {
    const { h, set, remote } = await setup();
    const ada = await h.user("Ada Lovelace");
    await set(ada.id, { preferredLanguage: "en-GB", locale: "en-GB", timezone: "Europe/London", userType: "Employee" });
    expect(remote(ada.email)).toMatchObject({ preferredLanguage: "en-GB", locale: "en-GB", timezone: "Europe/London", userType: "Employee" });
    await set(ada.id, { timezone: null, userType: "" });
    expect(remote(ada.email)).toMatchObject({ preferredLanguage: "en-GB", locale: "en-GB" });
    expect(remote(ada.email).timezone).toBeUndefined();
    expect(remote(ada.email).userType).toBeUndefined();
  });

  it("a value that isn't a language tag, or an IANA time zone, is left out and logged, not sent to be refused", async () => {
    const { h, set, remote, lastPatch } = await setup({ update: "patch", patch: true, attributes: { timezone: "tz", locale: "locale", preferredLanguage: "preferredLanguage" } });
    const warn = vi.spyOn(h.ctx.logger, "warn");
    const ada = await h.user("Ada Lovelace");
    await set(ada.id, { tz: "America/Toronto", locale: "en-CA", preferredLanguage: "fr-CA" });
    expect(remote(ada.email)).toMatchObject({ timezone: "America/Toronto", locale: "en-CA", preferredLanguage: "fr-CA" });
    // A zone Intl knows by an old abbreviation isn't an IANA name either.
    await set(ada.id, { tz: "EST", locale: "English (Canada)", preferredLanguage: "French" });
    // PATCH: left as it was at the app, and none cleared.
    expect(remote(ada.email)).toMatchObject({ timezone: "America/Toronto", locale: "en-CA", preferredLanguage: "fr-CA" });
    expect(lastPatch()?.Operations.filter((o) => o.op === "remove")).toEqual([]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/preferredLanguage, locale, timezone left out, not a valid value/);
    // Empty: removed by path.
    await set(ada.id, { tz: null, locale: "en-CA", preferredLanguage: "fr-CA" });
    expect(lastPatch()?.Operations.filter((o) => o.op === "remove")).toEqual([expect.objectContaining({ path: "timezone" })]);
    expect(remote(ada.email).timezone).toBeUndefined();
  });

  it("roles: at an unscoped target, the user's roles in each organization, typed by its slug; at an organization's, there", async () => {
    const h = await createHost({ targets: [{ id: "app", roles: true }, { id: "acme", roles: true }] });
    const ada = await h.user("Ada Lovelace");
    const owner = await h.user("Olive Owner");
    const make = async (slug: string) => (await h.ctx.adapter.create({ model: "organization", data: { name: slug, slug, createdAt: new Date() } })) as { id: string };
    const acme = await make("acme");
    const globex = await make("globex");
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: acme.id, role: ["admin", "member"] } });
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: globex.id, role: "member" } });
    await h.auth.api.addMember({ body: { userId: owner.id, organizationId: acme.id, role: "owner" } });
    await h.settle();
    const at = (app: string) => [...h.apps[app]!.users.values()].find((u) => u.externalId === ada.id) as { roles?: unknown } | undefined;
    expect(at("app")?.roles).toEqual([
      { value: "admin", type: "acme" },
      { value: "member", type: "acme" },
      { value: "member", type: "globex" },
    ]);
    // Out of all of them: cleared.
    await h.ctx.adapter.deleteMany({ model: "member", where: [{ field: "userId", value: ada.id }] });
    await h.auth.api.scimProvisioningQueue({ body: { userId: ada.id } });
    await h.settle();
    expect(at("app")?.roles).toBeUndefined();
  });

  it("roles at an organization's target are its own", async () => {
    const h = await createHost({ targets: [] });
    const ada = await h.user("Ada Lovelace");
    const acme = (await h.ctx.adapter.create({ model: "organization", data: { name: "Acme", slug: "acme", createdAt: new Date() } })) as { id: string };
    const globex = (await h.ctx.adapter.create({ model: "organization", data: { name: "Globex", slug: "globex", createdAt: new Date() } })) as { id: string };
    await h.ctx.adapter.create({ model: "member", data: { userId: ada.id, organizationId: acme.id, role: "admin", createdAt: new Date() } });
    await h.ctx.adapter.create({ model: "member", data: { userId: ada.id, organizationId: globex.id, role: "owner", createdAt: new Date() } });
    const { outbox } = await import("../src/outbox");
    const { mockScim } = await import("./support/mock-scim");
    const app = mockScim();
    const box = outbox({ targets: [{ id: "acme", url: app.url, token: app.token, fetch: app.fetch, organizationId: acme.id, roles: true }] }, h.ctx.adapter as never, { warn() {}, error() {} });
    await box.enqueue("acme", ada.id);
    expect(await box.runFor("acme", ada.id)).toBe("done");
    expect(([...app.users.values()][0] as { roles?: unknown } | undefined)?.roles).toEqual([{ value: "admin", type: "organization" }]);
  });

  it("with PATCH, no roles left removes them by path", async () => {
    const h = await createHost({ targets: [{ id: "app", roles: true, update: "patch", patch: true }] });
    const ada = await h.user("Ada Lovelace");
    const acme = (await h.ctx.adapter.create({ model: "organization", data: { name: "Acme", slug: "acme", createdAt: new Date() } })) as { id: string };
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: acme.id, role: "member" } });
    await h.settle();
    const remote = () => [...h.app.users.values()].find((u) => u.externalId === ada.id) as { roles?: unknown };
    expect(remote().roles).toEqual([{ value: "member", type: "acme" }]);
    await h.ctx.adapter.deleteMany({ model: "member", where: [{ field: "userId", value: ada.id }] });
    await h.auth.api.scimProvisioningQueue({ body: { userId: ada.id } });
    await h.settle();
    const patch = [...h.app.requests].reverse().find((r) => r.method === "PATCH")?.body as { Operations: { op: string; path?: string }[] };
    expect(patch.Operations).toContainEqual(expect.objectContaining({ op: "remove", path: "roles" }));
    expect(remote().roles).toBeUndefined();
  });

  it("entitlements: what your code says, cleared when it says none; mapUser's own come first", async () => {
    let plans = ["pro", " pro ", "", "sso"];
    const h = await createHost({ targets: [{ id: "app", entitlements: () => plans }] });
    const ada = await h.user("Ada Lovelace");
    const remote = () => [...h.app.users.values()].find((u) => u.externalId === ada.id) as { entitlements?: unknown };
    expect(remote().entitlements).toEqual([{ value: "pro" }, { value: "sso" }]);
    plans = [];
    await h.ctx.internalAdapter.updateUser(ada.id, { name: "Ada King" });
    await h.settle();
    expect(remote().entitlements).toBeUndefined();
  });

  it("roles and entitlements are for SCIM apps and webhooks", () => {
    const google = { id: "g", type: "google-workspace", google: { clientEmail: "a@b.iam.gserviceaccount.com", privateKey: "-----BEGIN PRIVATE KEY-----", adminEmail: "admin@example.com" } } as const;
    expect(() => scimProvisioning({ targets: [{ ...google, roles: true }] })).toThrow(/roles and entitlements are for scim and webhook targets/);
    expect(() => scimProvisioning({ targets: [{ ...google, entitlements: () => [] }] })).toThrow(/roles and entitlements are for scim and webhook targets/);
  });

  it("Entra ID gets the preferred language (only: its userType means member or guest)", async () => {
    const h = await createHost({ targets: [{ id: "entra", type: "entra-id", attributes: true }], userFields: FIELDS });
    const ada = await h.user("Ada Lovelace");
    await h.ctx.internalAdapter.updateUser(ada.id, { preferredLanguage: "en-GB", userType: "Contractor", timezone: "Europe/London" });
    await h.settle();
    const at = [...h.graph.users.values()][0] as unknown as Record<string, unknown>;
    expect(at.preferredLanguage).toBe("en-GB");
    expect(at.userType).not.toBe("Contractor");
    expect(at.timezone).toBeUndefined();
  });
});
