// Google Workspace with a partial `enterprise` map touches only what it names: an admin's organization name, cost center, Employee ID and manager are kept.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("enterprise: { department } at Google keeps what it doesn't name", async () => {
  const h = await createHost({ targets: [{ id: "gw", type: "google-workspace", enterprise: { department: "department" } }], userFields: { department: { type: "string" } } });
  const jo = await h.user("Jo Staff");
  const g = [...h.google.users.values()].find((u) => u.primaryEmail === jo.email) as any;
  // An admin's data in the Admin console.
  Object.assign(g, {
    organizations: [{ primary: true, title: "Engineer", name: "Acme Corp", costCenter: "CC-ADMIN", description: "Platform" }],
    relations: [{ type: "manager", value: "real.boss@example.com" }],
    externalIds: [...(g.externalIds ?? []), { type: "organization", value: "EMP-0042" }],
  });
  await h.ctx.internalAdapter.updateUser(jo.id, { department: "Engines" });
  await h.settle();
  const after = [...h.google.users.values()].find((u) => u.primaryEmail === jo.email) as any;
  expect(after.organizations).toEqual([{ primary: true, title: "Engineer", name: "Acme Corp", costCenter: "CC-ADMIN", description: "Platform", department: "Engines" }]);
  expect(after.relations).toEqual([{ type: "manager", value: "real.boss@example.com" }]);
  expect(after.externalIds).toEqual(expect.arrayContaining([{ type: "organization", value: "EMP-0042" }]));
});
