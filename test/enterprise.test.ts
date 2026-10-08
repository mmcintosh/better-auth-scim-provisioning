// The Enterprise User extension (RFC 7643 §4.3): attributes read from user fields, sent with
// the extension's schema; empty ones cleared (PUT leaves them out, PATCH removes them); the manager
// as their id at the app, once provisioned there, and the reports updated when that changes.
import { describe, expect, it } from "vitest";
import { scimProvisioning } from "../src";
import { assemble, storedSettingsSchema } from "../src/registry";
import { SCIM_ENTERPRISE_USER_SCHEMA } from "../src/scim-client";
import { createHost } from "./support/host";

const ENT = SCIM_ENTERPRISE_USER_SCHEMA;
const FIELDS = {
  employeeNumber: { type: "string" },
  costCenter: { type: "string" },
  organization: { type: "string" },
  division: { type: "string" },
  department: { type: "string" },
  managerId: { type: "string" },
  employeeId: { type: "number" },
  reportsTo: { type: "string" },
} as const;

type Ext = Record<string, unknown> & { manager?: { value: string } };
async function setup(target: Record<string, unknown> = {}) {
  const h = await createHost({ targets: [{ id: "app", enterprise: true, ...target }], userFields: FIELDS });
  const set = async (id: string, fields: Record<string, unknown>) => {
    await h.ctx.internalAdapter.updateUser(id, fields);
    await h.settle();
  };
  const remote = (email: string) => [...h.app.users.values()].find((u) => u.userName === email) as (Record<string, unknown> & { id: string; [ENT]?: Ext }) | undefined;
  const ext = (email: string) => remote(email)?.[ENT];
  const lastBody = (method: string) => [...h.app.requests].reverse().find((r) => r.method === method && r.path.startsWith("/Users/"))?.body as Record<string, any> | undefined;
  return { h, set, remote, ext, lastBody };
}

describe("Enterprise User extension", () => {
  it("true: the fields of the same names, with the extension's schema; empty ones left out", async () => {
    const { h, set, ext, remote } = await setup();
    const ada = await h.user("Ada Lovelace");
    await set(ada.id, { employeeNumber: "E-1", costCenter: "CC9", organization: "Acme", division: "R&D", department: "Engines", managerId: null });
    expect(ext(ada.email)).toEqual({ employeeNumber: "E-1", costCenter: "CC9", organization: "Acme", division: "R&D", department: "Engines" });
    // The schema is listed with the core one (the mock drops schemas, so read the request).
    const put = [...h.app.requests].reverse().find((r) => r.method === "PUT")?.body as Record<string, any>;
    expect(put.schemas).toEqual(["urn:ietf:params:scim:schemas:core:2.0:User", ENT]);
    // Cleared here: left out of the next PUT, so cleared there too; whitespace is no value.
    await set(ada.id, { department: "  ", division: null });
    expect(ext(ada.email)).toEqual({ employeeNumber: "E-1", costCenter: "CC9", organization: "Acme" });
    expect(remote(ada.email)?.userName).toBe(ada.email);
  });

  it("named fields: only those listed, numbers written out", async () => {
    const { h, set, ext } = await setup({ enterprise: { employeeNumber: "employeeId", manager: "reportsTo" } });
    const bo = await h.user("Bo Bell");
    await set(bo.id, { employeeId: 4711, department: "Ignored" });
    expect(ext(bo.email)).toEqual({ employeeNumber: "4711" });
  });

  it("the manager: their id at the app once they're there; the reports follow when they come and go", async () => {
    const { h, set, ext, remote } = await setup();
    const cy = await h.user("Cy Report");
    const di = await h.user("Di Boss", false); // not provisioned yet: an unverified email
    await set(cy.id, { managerId: di.id });
    expect(ext(cy.email)?.manager).toBeUndefined();
    // The manager arrives: the report is queued and updated with the manager's id there.
    await h.ctx.internalAdapter.updateUser(di.id, { emailVerified: true });
    await h.settle();
    await h.auth.api.scimProvisioningRun({ body: {} });
    await h.settle();
    expect(ext(cy.email)?.manager).toEqual({ value: remote(di.email)?.id });
    // The manager leaves (banned: deactivated there): the report loses them.
    await h.ctx.internalAdapter.updateUser(di.id, { banned: true });
    await h.settle();
    await h.auth.api.scimProvisioningRun({ body: {} });
    await h.settle();
    expect(ext(cy.email)?.manager).toBeUndefined();
    // Nobody is their own manager.
    await set(cy.id, { managerId: cy.id });
    expect(ext(cy.email)?.manager).toBeUndefined();
    expect(await h.jobs()).toEqual([]);
  });

  it("PATCH: attributes set, and cleared ones removed by path; the app's others kept", async () => {
    const { h, set, ext, lastBody } = await setup({ update: "patch", patch: true });
    const ed = await h.user("Ed Elric");
    await set(ed.id, { department: "Alchemy", costCenter: "C1" });
    expect(ext(ed.email)).toEqual({ department: "Alchemy", costCenter: "C1" });
    await set(ed.id, { costCenter: null });
    const ops = lastBody("PATCH")?.Operations as { op: string; path?: string }[];
    expect(ops.filter((o) => o.op === "remove").map((o) => o.path)).toEqual(expect.arrayContaining([`${ENT}:costCenter`, `${ENT}:manager`]));
    expect(ext(ed.email)).toEqual({ department: "Alchemy" });
  });

  it("a mapUser that sets the extension itself is sent as it is", async () => {
    const { h, set, ext } = await setup({
      mapUser: (u: { email: string; id: string }) => ({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User", ENT], userName: u.email, externalId: u.id, active: true, name: { givenName: "F", familyName: "G" }, [ENT]: { department: "From mapUser" } }),
    });
    const fay = await h.user("Fay Wray");
    await set(fay.id, { department: "From the field" });
    expect(ext(fay.email)).toEqual({ department: "From mapUser" });
  });

  it("webhooks carry it; the manager is their id at the receiver (their externalId)", async () => {
    const h = await createHost({ targets: [{ id: "hook", type: "webhook", enterprise: true }], userFields: FIELDS });
    const boss = await h.user("Gus Boss");
    const rep = await h.user("Hal Report");
    await h.ctx.internalAdapter.updateUser(rep.id, { managerId: boss.id, department: "Ops" });
    await h.settle();
    const last = [...h.webhook.events].reverse().find((e) => e.type === "user.upsert" && (e as any).user.externalId === rep.id) as any;
    expect(last.user[ENT]).toEqual({ department: "Ops", manager: { value: boss.id } });
    expect(last.user.schemas).toContain(ENT);
  });

  it("Google Workspace: the primary organization (an admin's title kept), the employee number, the manager relation (other relations kept)", async () => {
    const h = await createHost({ targets: [{ id: "gw", type: "google-workspace", enterprise: true }], userFields: FIELDS });
    const boss = await h.user("Ivy Boss");
    const jo = await h.user("Jo Staff");
    const gUser = (email: string) => [...h.google.users.values()].find((u) => u.primaryEmail === email) as any;
    // An admin set a job title and another relation at Google.
    Object.assign(gUser(jo.email), { organizations: [{ primary: true, title: "Engineer" }, { name: "Old Co" }], relations: [{ type: "assistant", value: "pa@example.com" }] });
    await h.ctx.internalAdapter.updateUser(jo.id, { managerId: boss.id, organization: "Acme", department: "Engines", costCenter: "CC9", division: "R&D", employeeNumber: "E-7" });
    await h.settle();
    const g = gUser(jo.email);
    expect(g.organizations).toEqual([{ name: "Old Co" }, { title: "Engineer", name: "Acme", department: "Engines", costCenter: "CC9", description: "R&D", primary: true }]);
    expect(g.relations).toEqual([{ type: "assistant", value: "pa@example.com" }, { type: "manager", value: boss.email }]);
    expect(g.externalIds).toEqual(expect.arrayContaining([{ type: "organization", value: "E-7" }, expect.objectContaining({ customType: "better-auth", value: jo.id })]));
    // Cleared here: removed there, the admin's title and relation kept.
    await h.ctx.internalAdapter.updateUser(jo.id, { managerId: null, organization: null, department: null, costCenter: null, division: null, employeeNumber: null });
    await h.settle();
    const after = gUser(jo.email);
    expect(after.organizations).toEqual([{ name: "Old Co" }, { title: "Engineer", primary: true }]);
    expect(after.relations).toEqual([{ type: "assistant", value: "pa@example.com" }]);
    expect(after.externalIds.some((x: any) => x.type === "organization")).toBe(false);
  });

  it("the option is checked: at least one field, field names only", () => {
    const t = (enterprise: unknown) => () => scimProvisioning({ targets: [{ id: "a", url: "https://app.example.com/scim/v2", token: "t", enterprise } as never] });
    expect(t({})).toThrow(/at least one field/);
    expect(t({ department: "dept; drop" })).toThrow(/name of a user field/);
    expect(t({ title: "jobTitle" })).toThrow(/enterprise/);
    expect(t({ department: "dept" })).not.toThrow();
    expect(t(true)).not.toThrow();
  });

  it("organizations' stored targets can have it (data only), checked the same way", () => {
    expect(storedSettingsSchema.safeParse({ url: "https://app.example.com/scim/v2", enterprise: { department: "dept", manager: "reportsTo" } }).success).toBe(true);
    expect(storedSettingsSchema.safeParse({ url: "https://app.example.com/scim/v2", enterprise: { department: "dept; drop" } }).success).toBe(false);
    const settings = storedSettingsSchema.parse({ url: "https://app.example.com/scim/v2", enterprise: true });
    expect(assemble({ targetId: "t-1", organizationId: "o" }, settings, { token: "t" })).toMatchObject({ enterprise: true });
  });
});
