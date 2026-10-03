// A create whose reply was lost, then a rename before the retry: the pending link's name was
// overwritten before the app was asked about the old one, so a second account (or group) was made
// and the first was left behind, never deprovisioned. The old name is now looked up first.
import { describe, expect, it } from "vitest";
import { createHost } from "../support/host";

describe("a rename while a create is pending", () => {
  it("user: the account made by the lost create is renamed, not duplicated", async () => {
    const h = await createHost({ retry: { baseDelayMs: 60_000 } });
    h.app.fail({ lostReply: true });
    const u = await h.user();
    expect(h.app.users.size).toBe(1);
    await h.ctx.internalAdapter.updateUser(u.id, { email: "renamed@example.com" });
    await h.settle();
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ userName: "renamed@example.com", externalId: u.id, active: true })]);
  });

  it("group: the group made by the lost create is renamed, not duplicated", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true }] });
    const org = (await h.ctx.adapter.create({ model: "organization", data: { name: "Acme", slug: "acme", createdAt: new Date() } })) as { id: string };
    await h.auth.api.scimProvisioningReconcile({ body: {} });
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect([...h.app.groups.values()].map((g) => g.displayName)).toEqual(["Acme"]);
    // As after a lost reply: the link is pending.
    h.db.prepare('UPDATE "scimProvisioningGroupLink" SET "remoteId" = \'\'').run();
    h.db.prepare('UPDATE "organization" SET "name" = ? WHERE "id" = ?').run("Acme Corp", org.id);
    await h.auth.api.scimProvisioningReconcile({ body: {} });
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect([...h.app.groups.values()].map((g) => g.displayName)).toEqual(["Acme Corp"]);
  });
});
