// Reconcile walked existing users only, so a deleted user whose
// deprovisioning was lost (a crash, a failed queue) stayed active at the app for good.
import { describe, expect, it } from "vitest";
import { createHost } from "../support/host";

describe("reconcile also deprovisions users who are gone", () => {
  it("a user deleted without their deprovisioning is deactivated by reconcile", async () => {
    const h = await createHost();
    const u = await h.user("Gone Person");
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ active: true })]);
    // Deleted with the hooks skipped, as if the process had died before queueing.
    await h.ctx.adapter.delete({ model: "user", where: [{ field: "id", value: u.id }] });
    expect(await h.auth.api.scimProvisioningReconcile({ body: {} })).toEqual({ queued: 1, next: null });
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ externalId: u.id, active: false })]);
  });
});
