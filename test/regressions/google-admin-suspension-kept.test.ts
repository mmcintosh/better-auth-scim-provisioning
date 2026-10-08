// An admin's suspension at Google isn't undone by a change the user didn't make (their manager arriving), nor by a rename: only the plugin's own suspension is lifted, on reactivation.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("an admin's suspension at Google is kept when the user's manager arrives", async () => {
  const h = await createHost({ targets: [{ id: "gw", type: "google-workspace", enterprise: { manager: "managerId" } }], userFields: { managerId: { type: "string" } } });
  const jo = await h.user("Jo Staff");
  const boss = await h.user("Ivy Boss", false);
  await h.ctx.internalAdapter.updateUser(jo.id, { managerId: boss.id });
  await h.settle();
  const g = [...h.google.users.values()].find((u) => u.primaryEmail === jo.email) as any;
  // Security incident: an admin suspends Jo at Google.
  Object.assign(g, { suspended: true, suspensionReason: "ADMIN" });
  await h.ctx.internalAdapter.updateUser(boss.id, { emailVerified: true });
  await h.settle();
  for (let i = 0; i < 3; i++) await h.auth.api.scimProvisioningRun({ body: {} });
  await h.settle();
  expect(g.relations).toEqual([{ type: "manager", value: boss.email }]); // the re-queue happened
  expect(g.suspended).toBe(true);
});
