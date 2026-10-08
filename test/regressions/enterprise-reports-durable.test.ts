// Re-queueing a manager's reports is a job: a database error is retried, not lost until a reconcile.
import { expect, it, vi } from "vitest";
import { SCIM_ENTERPRISE_USER_SCHEMA as ENT } from "../../src/scim-client";
import { createHost } from "../support/host";

it("one failed report query is retried: the reports get their manager", async () => {
  const h = await createHost({ targets: [{ id: "app", enterprise: { manager: "managerId" } }], userFields: { managerId: { type: "string" } }, retry: { baseDelayMs: 0 } });
  const cy = await h.user("Cy Report");
  const di = await h.user("Di Boss", false); // not provisioned yet
  await h.ctx.internalAdapter.updateUser(cy.id, { managerId: di.id });
  await h.settle();
  const adapter = h.ctx.adapter as any;
  const real = adapter.findMany.bind(adapter);
  let failed = false;
  const spy = vi.spyOn(adapter, "findMany").mockImplementation(async (a: any) => {
    if (!failed && a.model === "user" && a.where?.[0]?.field === "managerId") {
      failed = true;
      throw new Error("D1_ERROR: Network connection lost.");
    }
    return real(a);
  });
  await h.ctx.internalAdapter.updateUser(di.id, { emailVerified: true });
  await h.settle();
  // The manager changes again later (any change): delivered, no flip, no re-queue.
  await h.ctx.internalAdapter.updateUser(di.id, { name: "Di Boss II" });
  await h.settle();
  for (let i = 0; i < 3; i++) await h.auth.api.scimProvisioningRun({ body: {} });
  await h.settle();
  spy.mockRestore();
  expect(failed).toBe(true);
  const remote = (email: string) => [...h.app.users.values()].find((u) => u.userName === email) as any;
  expect(remote(cy.email)[ENT]?.manager).toEqual({ value: remote(di.email).id });
});
