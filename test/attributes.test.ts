// More of the user's details (`attributes`): the job title, work and mobile phones and a work
// address, read from user fields and sent as SCIM's title, phoneNumbers and addresses; empty ones
// cleared (PUT leaves them out, PATCH removes them by path); a mapUser's own take precedence; and
// where Google Workspace and Entra ID keep them, touching only what the target names.
import { describe, expect, it } from "vitest";
import { scimProvisioning } from "../src";
import { assemble, storedSettingsSchema } from "../src/registry";
import { createHost } from "./support/host";
import { mockScim } from "./support/mock-scim";

const FIELDS = {
  title: { type: "string" },
  phone: { type: "string" },
  mobile: { type: "string" },
  streetAddress: { type: "string" },
  locality: { type: "string" },
  region: { type: "string" },
  postalCode: { type: "string" },
  country: { type: "string" },
  jobTitle: { type: "string" },
  zip: { type: "number" },
} as const;
const ADA = { title: "Analyst", phone: "+44 20 7946 0001", mobile: "+44 7700 900001", streetAddress: "1 Analytical Way", locality: "London", region: "Greater London", postalCode: "SW1A 1AA", country: "GB" };
const NONE = Object.fromEntries(Object.keys(ADA).map((k) => [k, null]));
const WORK_PHONE = { value: ADA.phone, type: "work", primary: true };
const MOBILE = { value: ADA.mobile, type: "mobile" };
const ADDRESS = { type: "work", primary: true, streetAddress: ADA.streetAddress, locality: ADA.locality, region: ADA.region, postalCode: ADA.postalCode, country: ADA.country };

async function setup(target: Record<string, unknown> = {}) {
  const h = await createHost({ targets: [{ id: "app", attributes: true, ...target }], userFields: FIELDS });
  const set = async (id: string, fields: Record<string, unknown>) => {
    await h.ctx.internalAdapter.updateUser(id, fields);
    await h.settle();
  };
  const remote = (email: string) => [...h.app.users.values()].find((u) => u.userName === email) as any;
  const lastBody = (method: string) => [...h.app.requests].reverse().find((r) => r.method === method && r.path.startsWith("/Users/"))?.body as Record<string, any> | undefined;
  return { h, set, remote, lastBody };
}

describe("attributes", () => {
  it("true: the fields of those names, as title, phoneNumbers and a work address; an empty one is left out of the PUT", async () => {
    const { h, set, remote } = await setup();
    const ada = await h.user("Ada Lovelace");
    await set(ada.id, ADA);
    expect(remote(ada.email)).toMatchObject({ title: "Analyst", phoneNumbers: [WORK_PHONE, MOBILE], addresses: [ADDRESS] });
    // Cleared here: left out there; whitespace is no value; the first phone left is the primary one.
    await set(ada.id, { phone: "  ", locality: null });
    const { locality: _, ...rest } = ADDRESS;
    expect(remote(ada.email)).toMatchObject({ phoneNumbers: [{ ...MOBILE, primary: true }], addresses: [rest] });
    expect(remote(ada.email).addresses[0].locality).toBeUndefined();
    await set(ada.id, NONE);
    const after = remote(ada.email);
    expect(after.title).toBeUndefined();
    expect(after.phoneNumbers).toBeUndefined();
    expect(after.addresses).toBeUndefined();
    expect(after.userName).toBe(ada.email);
    expect(await h.jobs()).toEqual([]);
  });

  it("named fields: only those listed; a number is written out", async () => {
    const { h, set, remote } = await setup({ attributes: { title: "jobTitle", postalCode: "zip", mobile: "mobile" } });
    const bo = await h.user("Bo Bell");
    await set(bo.id, { jobTitle: "Chief", zip: 12345, mobile: "+1 555 0100", phone: "+1 ignored", locality: "Ignored" });
    expect(remote(bo.email)).toMatchObject({ title: "Chief", phoneNumbers: [{ value: "+1 555 0100", type: "mobile", primary: true }], addresses: [{ type: "work", primary: true, postalCode: "12345" }] });
    expect(remote(bo.email).addresses[0].locality).toBeUndefined();
  });

  it("PATCH: set, and cleared ones removed by path; the app's other attributes kept", async () => {
    const { h, set, remote, lastBody } = await setup({ update: "patch", patch: true });
    const ed = await h.user("Ed Elric");
    await set(ed.id, ADA);
    expect(remote(ed.email)).toMatchObject({ title: "Analyst", phoneNumbers: [WORK_PHONE, MOBILE], addresses: [ADDRESS] });
    // An admin set something else at the app: a PATCH keeps it.
    remote(ed.email).nickName = "Ed";
    await set(ed.id, NONE);
    const ops = lastBody("PATCH")?.Operations as { op: string; path?: string }[];
    expect(ops.filter((o) => o.op === "remove").map((o) => o.path)).toEqual(expect.arrayContaining(["title", "phoneNumbers", "addresses"]));
    expect(remote(ed.email)).toMatchObject({ nickName: "Ed", userName: ed.email });
    expect(remote(ed.email).title).toBeUndefined();
    expect(remote(ed.email).phoneNumbers).toBeUndefined();
    expect(remote(ed.email).addresses).toBeUndefined();
  });

  it("a mapUser that sets an attribute itself wins for that one; the rest still come from the fields", async () => {
    const { h, set, remote } = await setup({
      mapUser: (u: { email: string; id: string }) => ({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: u.email, externalId: u.id, active: true, name: { givenName: "F", familyName: "G" }, title: "From mapUser" }),
    });
    const fay = await h.user("Fay Wray");
    await set(fay.id, ADA);
    expect(remote(fay.email)).toMatchObject({ title: "From mapUser", phoneNumbers: [WORK_PHONE, MOBILE], addresses: [ADDRESS] });
  });

  it("webhooks carry them", async () => {
    const h = await createHost({ targets: [{ id: "hook", type: "webhook", attributes: true }], userFields: FIELDS });
    const gus = await h.user("Gus Grissom");
    await h.ctx.internalAdapter.updateUser(gus.id, ADA);
    await h.settle();
    const last = [...h.webhook.events].reverse().find((e) => e.type === "user.upsert" && (e as any).user.externalId === gus.id) as any;
    expect(last.user).toMatchObject({ title: "Analyst", phoneNumbers: [WORK_PHONE, MOBILE], addresses: [ADDRESS] });
  });

  it("Google Workspace: the primary organization's title (its department kept), the work and mobile phones (an admin's home number kept), the work address (another address kept)", async () => {
    const h = await createHost({ targets: [{ id: "gw", type: "google-workspace", attributes: true }], userFields: FIELDS });
    const jo = await h.user("Jo Staff");
    const g = () => [...h.google.users.values()].find((u) => u.primaryEmail === jo.email) as any;
    Object.assign(g(), { organizations: [{ primary: true, department: "Sales" }], phones: [{ type: "home", value: "+1 555 0100" }], addresses: [{ type: "home", locality: "Leeds" }] });
    await h.ctx.internalAdapter.updateUser(jo.id, ADA);
    await h.settle();
    expect(g().organizations).toEqual([{ department: "Sales", title: "Analyst", primary: true }]);
    expect(g().phones).toEqual([{ type: "home", value: "+1 555 0100" }, { value: ADA.phone, type: "work", primary: true }, { value: ADA.mobile, type: "mobile" }]);
    expect(g().addresses).toEqual([{ type: "home", locality: "Leeds" }, { streetAddress: ADA.streetAddress, locality: ADA.locality, region: ADA.region, postalCode: ADA.postalCode, country: ADA.country, type: "work", primary: true }]);
    // Cleared here: removed there, the admin's kept; one part of the address goes, the rest stays.
    await h.ctx.internalAdapter.updateUser(jo.id, { title: null, mobile: null, streetAddress: null });
    await h.settle();
    expect(g().organizations).toEqual([{ department: "Sales", primary: true }]);
    expect(g().phones).toEqual([{ type: "home", value: "+1 555 0100" }, { value: ADA.phone, type: "work", primary: true }]);
    expect(g().addresses).toEqual([{ type: "home", locality: "Leeds" }, { locality: ADA.locality, region: ADA.region, postalCode: ADA.postalCode, country: ADA.country, type: "work", primary: true }]);
    await h.ctx.internalAdapter.updateUser(jo.id, NONE);
    await h.settle();
    expect(g().organizations).toEqual([{ department: "Sales", primary: true }]);
    expect(g().phones).toEqual([{ type: "home", value: "+1 555 0100" }]);
    expect(g().addresses).toEqual([{ type: "home", locality: "Leeds" }]);
    expect(await h.jobs()).toEqual([]);
  });

  it("Google Workspace: a map naming only the work phone leaves an admin's mobile alone", async () => {
    const h = await createHost({ targets: [{ id: "gw", type: "google-workspace", attributes: { phone: "phone" } }], userFields: FIELDS });
    const kim = await h.user("Kim Staff");
    const g = () => [...h.google.users.values()].find((u) => u.primaryEmail === kim.email) as any;
    Object.assign(g(), { phones: [{ type: "mobile", value: "+1 555 0199" }] });
    await h.ctx.internalAdapter.updateUser(kim.id, { phone: "+1 555 0100", mobile: "+1 ignored" });
    await h.settle();
    expect(g().phones).toEqual([{ type: "mobile", value: "+1 555 0199" }, { value: "+1 555 0100", type: "work", primary: true }]);
  });

  it("Entra ID: jobTitle, businessPhones, mobilePhone and the address fields; cleared with null (and an empty list); a create sends only what has a value", async () => {
    const h = await createHost({ targets: [{ id: "entra", type: "entra-id", attributes: true }], userFields: FIELDS });
    const li = await h.user("Li Wei");
    const at = () => [...h.graph.users.values()].find((u) => u.userPrincipalName === li.email)!;
    await h.ctx.internalAdapter.updateUser(li.id, ADA);
    await h.settle();
    expect(at()).toMatchObject({ jobTitle: "Analyst", businessPhones: [ADA.phone], mobilePhone: ADA.mobile, streetAddress: ADA.streetAddress, city: ADA.locality, state: ADA.region, postalCode: ADA.postalCode, country: ADA.country });
    await h.ctx.internalAdapter.updateUser(li.id, NONE);
    await h.settle();
    expect(at()).toMatchObject({ jobTitle: null, businessPhones: [], mobilePhone: null, streetAddress: null, city: null, state: null, postalCode: null, country: null });
    await h.ctx.internalAdapter.createUser({ email: "new@example.com", name: "New User", emailVerified: true, title: "Intern" } as never, { method: "admin" });
    await h.settle();
    const create = [...h.graph.requests].reverse().find((r) => r.method === "POST" && r.path === "/users")?.body as Record<string, unknown>;
    expect(create).toMatchObject({ userPrincipalName: "new@example.com", jobTitle: "Intern" });
    for (const k of ["mobilePhone", "businessPhones", "city", "country"]) expect(create).not.toHaveProperty(k);
    expect(await h.jobs()).toEqual([]);
  });

  it("the option is checked: at least one field, field names only, known attributes only", () => {
    const t = (attributes: unknown) => () => scimProvisioning({ targets: [{ id: "a", url: "https://app.example.com/scim/v2", token: "t", attributes } as never] });
    expect(t({})).toThrow(/at least one field/);
    expect(t({ title: "title; drop" })).toThrow(/name of a user field/);
    expect(t({ fax: "fax" })).toThrow(/attributes\.fax: unknown option/);
    expect(t({ title: "jobTitle" })).not.toThrow();
    expect(t(true)).not.toThrow();
  });

  it("a map naming a field the users don't have stops the plugin at startup", async () => {
    await expect(createHost({ targets: [{ id: "app", attributes: { title: "jobTitle" } }] })).rejects.toThrow(/attributes reads jobTitle, which the user model doesn't have/);
  });

  it("true reads only the fields the users have: the others aren't sent or cleared", async () => {
    const h = await createHost({ targets: [{ id: "gw", type: "google-workspace", attributes: true }], userFields: { title: { type: "string" } } });
    const mo = await h.user("Mo Staff");
    const g = () => [...h.google.users.values()].find((u) => u.primaryEmail === mo.email) as any;
    Object.assign(g(), { phones: [{ type: "work", value: "+1 admin" }] });
    await h.ctx.internalAdapter.updateUser(mo.id, { title: "Ops" });
    await h.settle();
    expect(g().organizations).toEqual([{ title: "Ops", primary: true }]);
    expect(g().phones).toEqual([{ type: "work", value: "+1 admin" }]);
  });

  it("organizations' stored targets can have it (data only), reading only the fields the host allows", async () => {
    expect(storedSettingsSchema.safeParse({ url: "https://app.example.com/scim/v2", attributes: { title: "jobTitle" } }).success).toBe(true);
    expect(storedSettingsSchema.safeParse({ url: "https://app.example.com/scim/v2", attributes: { title: "x; drop" } }).success).toBe(false);
    const settings = storedSettingsSchema.parse({ url: "https://app.example.com/scim/v2", attributes: true });
    expect(assemble({ targetId: "t-1", organizationId: "o" }, settings, { token: "t" })).toMatchObject({ attributes: true });
    const remote = mockScim();
    const h = await createHost({ targets: [], registry: { fetch: remote.fetch }, userFields: { internalNote: { type: "string" }, title: { type: "string" } } });
    const up = await h.auth.api.signUpEmail({ body: { email: "olive@example.com", password: "correct-horse-battery", name: "olive" } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email: "olive@example.com", password: "correct-horse-battery" }, asResponse: true });
    const headers = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
    const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers }))!;
    const create = (attributes: unknown) =>
      h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings: { name: "x", url: "https://app.example.com/scim/v2", attributes }, credentials: { token: remote.token } } as never, headers });
    const refused = await create({ title: "internalNote" }).catch((e: { statusCode?: number; body?: unknown }) => e);
    expect((refused as { statusCode?: number }).statusCode).toBe(400);
    expect(JSON.stringify((refused as { body?: unknown }).body)).toMatch(/settings.attributes: reads internalNote/);
    await expect(create({ title: "title" })).resolves.toBeTruthy();
  });
});

describe("attributes: Google and Entra edges", () => {
  const gUser = (h: Awaited<ReturnType<typeof createHost>>, email: string) => () => [...h.google.users.values()].find((u) => u.primaryEmail === email) as any;

  it("Google Workspace: one primary per list; an admin's primary entry yields to ours", async () => {
    const h = await createHost({ targets: [{ id: "gw", type: "google-workspace", attributes: { mobile: "mobile", locality: "locality" } }], userFields: FIELDS });
    const pri = await h.user("Pri Mary");
    const g = gUser(h, pri.email);
    Object.assign(g(), { phones: [{ type: "work", value: "+1 admin", primary: true }], addresses: [{ type: "home", locality: "Leeds", primary: true }] });
    await h.ctx.internalAdapter.updateUser(pri.id, { mobile: "+1 555 0100", locality: "London" });
    await h.settle();
    expect(g().phones).toEqual([{ type: "work", value: "+1 admin" }, { value: "+1 555 0100", type: "mobile", primary: true }]);
    expect(g().addresses).toEqual([{ type: "home", locality: "Leeds" }, { locality: "London", type: "work", primary: true }]);
  });

  it("a mapUser's own title, phones (by type) and addresses (by type) reach Google; the work address stays the work one", async () => {
    const mapUser = (u: { email: string; id: string }) => ({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: u.email, externalId: u.id, active: true, name: { givenName: "F", familyName: "G" },
      title: "From mapUser", phoneNumbers: [{ value: "+1 other", type: "other" }], addresses: [{ type: "home", locality: "Leeds" }],
    });
    const h = await createHost({ targets: [{ id: "gw", type: "google-workspace", attributes: { phone: "phone" }, mapUser }], userFields: FIELDS });
    const fay = await h.user("Fay Wray");
    const g = gUser(h, fay.email);
    Object.assign(g(), { organizations: [{ primary: true, department: "Sales" }], phones: [{ type: "work", value: "+1 admin" }, { type: "mobile", value: "+1 admin mobile" }], addresses: [{ type: "work", streetAddress: "1 Admin St" }] });
    await h.ctx.internalAdapter.updateUser(fay.id, { phone: "+1 ignored: the mapUser's list wins" });
    await h.settle();
    expect(g().organizations).toEqual([{ department: "Sales", title: "From mapUser", primary: true }]);
    // The mapUser's list holds the "other" type; "work" is the target's (named) and it sent none: cleared. The admin's mobile stays.
    expect(g().phones).toEqual([{ type: "mobile", value: "+1 admin mobile" }, { value: "+1 other", type: "other" }]);
    // The home address is sent as its own type; the admin's work address is left alone (no part named, none sent).
    expect(g().addresses).toEqual([{ type: "work", streetAddress: "1 Admin St" }, { type: "home", locality: "Leeds" }]);
  });

  it("Entra ID: a mapUser's title and phones (by type) are sent; a home address has nowhere to go", async () => {
    const mapUser = (u: { email: string; id: string }) => ({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: u.email, externalId: u.id, active: true, name: { givenName: "F", familyName: "G" },
      title: "From mapUser", phoneNumbers: [{ value: "+1 mobile", type: "mobile" }], addresses: [{ type: "home", locality: "Leeds" }],
    });
    const h = await createHost({ targets: [{ id: "entra", type: "entra-id", attributes: { phone: "phone" }, mapUser }], userFields: FIELDS });
    const li = await h.user("Li Wei");
    const at = () => [...h.graph.users.values()].find((u) => u.userPrincipalName === li.email)!;
    Object.assign(at(), { city: "Admin City" });
    await h.ctx.internalAdapter.updateUser(li.id, { phone: "+1 ignored" });
    await h.settle();
    expect(at()).toMatchObject({ jobTitle: "From mapUser", businessPhones: [], mobilePhone: "+1 mobile", city: "Admin City" });
  });

  it("a map naming only mobile: SCIM gets it as the primary number; Google keeps an admin's work number; Entra leaves businessPhones alone", async () => {
    const { h, set, remote } = await setup({ attributes: { mobile: "mobile" } });
    const mo = await h.user("Mo Bile");
    await set(mo.id, { mobile: "+1 555 0100", phone: "+1 ignored" });
    expect(remote(mo.email).phoneNumbers).toEqual([{ value: "+1 555 0100", type: "mobile", primary: true }]);
    const g = await createHost({ targets: [{ id: "gw", type: "google-workspace", attributes: { mobile: "mobile" } }], userFields: FIELDS });
    const gu = await g.user("Go Ogle");
    Object.assign(gUser(g, gu.email)(), { phones: [{ type: "work", value: "+1 admin" }] });
    await g.ctx.internalAdapter.updateUser(gu.id, { mobile: "+1 555 0100" });
    await g.settle();
    expect(gUser(g, gu.email)().phones).toEqual([{ type: "work", value: "+1 admin" }, { value: "+1 555 0100", type: "mobile", primary: true }]);
    const e = await createHost({ targets: [{ id: "entra", type: "entra-id", attributes: { mobile: "mobile" } }], userFields: FIELDS });
    const eu = await e.user("En Tra");
    const at = () => [...e.graph.users.values()].find((u) => u.userPrincipalName === eu.email)!;
    Object.assign(at(), { businessPhones: ["+1 admin"] });
    await e.ctx.internalAdapter.updateUser(eu.id, { mobile: "+1 555 0100" });
    await e.settle();
    expect(at()).toMatchObject({ businessPhones: ["+1 admin"], mobilePhone: "+1 555 0100" });
  });

  it("attributes and enterprise together: Google's primary organization carries both; Entra's user has both", async () => {
    const fields = { ...FIELDS, department: { type: "string" }, costCenter: { type: "string" } } as const;
    const g = await createHost({ targets: [{ id: "gw", type: "google-workspace", attributes: true, enterprise: true }], userFields: fields });
    const jo = await g.user("Jo Both");
    await g.ctx.internalAdapter.updateUser(jo.id, { title: "Analyst", department: "Engines", costCenter: "CC9" });
    await g.settle();
    expect(gUser(g, jo.email)().organizations).toEqual([{ department: "Engines", costCenter: "CC9", title: "Analyst", primary: true }]);
    await g.ctx.internalAdapter.updateUser(jo.id, { title: null });
    await g.settle();
    expect(gUser(g, jo.email)().organizations).toEqual([{ department: "Engines", costCenter: "CC9", primary: true }]);
    const e = await createHost({ targets: [{ id: "entra", type: "entra-id", attributes: true, enterprise: true }], userFields: fields });
    const li = await e.user("Li Both");
    await e.ctx.internalAdapter.updateUser(li.id, { title: "Analyst", department: "Engines", costCenter: "CC9" });
    await e.settle();
    expect([...e.graph.users.values()].find((u) => u.userPrincipalName === li.email)).toMatchObject({ jobTitle: "Analyst", department: "Engines", employeeOrgData: { costCenter: "CC9" } });
  });

  it("a Google create sends the values a new user already has", async () => {
    const h = await createHost({ targets: [{ id: "gw", type: "google-workspace", attributes: true }], userFields: FIELDS });
    await h.ctx.internalAdapter.createUser({ email: "new@example.com", name: "New User", emailVerified: true, ...ADA } as never, { method: "admin" });
    await h.settle();
    const create = [...h.google.requests].reverse().find((r) => r.method === "POST" && r.path === "/users")?.body as Record<string, unknown>;
    expect(create).toMatchObject({ primaryEmail: "new@example.com", organizations: [{ title: "Analyst", primary: true }], phones: [WORK_PHONE, MOBILE], addresses: [{ ...ADDRESS }] });
  });

  it("PATCH: a mapUser-set title goes as it is while an empty phone list is removed by path", async () => {
    const { h, set, remote, lastBody } = await setup({
      update: "patch", patch: true,
      mapUser: (u: { email: string; id: string }) => ({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: u.email, externalId: u.id, active: true, name: { givenName: "F", familyName: "G" }, title: "From mapUser" }),
    });
    const pat = await h.user("Pat Ch");
    await set(pat.id, { locality: "London" });
    const ops = lastBody("PATCH")?.Operations as { op: string; path?: string; value?: Record<string, unknown> }[];
    expect(ops.find((o) => o.op === "replace")?.value).toMatchObject({ title: "From mapUser", addresses: [{ type: "work", primary: true, locality: "London" }] });
    expect(ops.filter((o) => o.op === "remove").map((o) => o.path)).toEqual(["phoneNumbers"]);
    expect(remote(pat.email)).toMatchObject({ title: "From mapUser" });
  });
});
