// The reports follow any change of what they'd name as their manager: the manager's account made again under a new id, or a new address at Google.
import { expect, it } from "vitest";
import { SCIM_ENTERPRISE_USER_SCHEMA as ENT } from "../../src/scim-client";
import { createHost } from "../support/host";

const FIELDS = { managerId: { type: "string" } } as const;

it("SCIM: the manager's account made again under a new id: the report follows", async () => {
  const h = await createHost({ targets: [{ id: "app", enterprise: { manager: "managerId" } }], userFields: FIELDS });
  const boss = await h.user("Di Boss");
  const cy = await h.user("Cy Report");
  await h.ctx.internalAdapter.updateUser(cy.id, { managerId: boss.id });
  await h.settle();
  const remote = (email: string) => [...h.app.users.values()].find((u) => u.userName === email) as any;
  const oldId = remote(boss.email).id;
  expect(remote(cy.email)[ENT].manager).toEqual({ value: oldId });
  // Removed at the app by someone; the boss's next change recreates it (404, the list agrees, create).
  h.app.users.delete(oldId);
  await h.ctx.internalAdapter.updateUser(boss.id, { name: "Di Boss-Smith" });
  await h.settle();
  for (let i = 0; i < 3; i++) await h.auth.api.scimProvisioningRun({ body: {} });
  await h.settle();
  const newId = remote(boss.email).id;
  expect(newId).not.toBe(oldId);
  expect(remote(cy.email)[ENT].manager).toEqual({ value: newId });
});

it("Google: the manager's new address: the report's manager relation follows", async () => {
  const h = await createHost({ targets: [{ id: "gw", type: "google-workspace", enterprise: { manager: "managerId" } }], userFields: FIELDS });
  const boss = await h.user("Ivy Boss");
  const jo = await h.user("Jo Staff");
  await h.ctx.internalAdapter.updateUser(jo.id, { managerId: boss.id });
  await h.settle();
  const g = (id: string) => [...h.google.users.values()].find((u) => (u.externalIds ?? []).some((x: any) => x.value === id)) as any;
  expect(g(jo.id).relations).toEqual([{ type: "manager", value: boss.email }]);
  await h.ctx.internalAdapter.updateUser(boss.id, { email: "ivy.boss@example.com" });
  await h.settle();
  for (let i = 0; i < 3; i++) await h.auth.api.scimProvisioningRun({ body: {} });
  await h.settle();
  expect(g(boss.id).primaryEmail).toBe("ivy.boss@example.com");
  expect(g(jo.id).relations).toEqual([{ type: "manager", value: "ivy.boss@example.com" }]);
});
