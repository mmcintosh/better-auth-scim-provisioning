// Review S2 F-3 (Medium, security): S1-1's guard relied on the app keeping externalId. Many apps
// don't, so a new user with a deleted user's old email was handed the old account, reactivated.
// We know who owns what from our own links: an account linked to another user is never adopted.
import { describe, expect, it } from "vitest";
import { createHost } from "../support/host";

describe("S2-3: adoption checks our own links, not just the app's externalId", () => {
  it("an app without externalId: a new user with a deleted user's email is refused", async () => {
    const h = await createHost({ targets: [{ id: "app", keepsExternalId: false }] });
    const a = await h.ctx.internalAdapter.createUser({ email: "same@example.com", name: "First Owner", emailVerified: true }, { method: "admin" });
    await h.settle();
    await h.ctx.internalAdapter.deleteUser(a.id);
    await h.settle();
    const old = [...h.app.users.values()][0]!;
    expect(old).toMatchObject({ active: false, displayName: "First Owner" });

    const b = await h.ctx.internalAdapter.createUser({ email: "same@example.com", name: "Second Person", emailVerified: true }, { method: "admin" });
    await h.settle();
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ id: old.id, active: false, displayName: "First Owner" })]);
    expect(await h.jobs()).toEqual([expect.objectContaining({ userId: b.id, failed: true, lastError: expect.stringContaining("linked to another user") })]);
    expect((await h.links()).map((l) => l.userId)).toEqual([a.id]);
  });

  it("an app without externalId: an account made by hand is still adopted", async () => {
    const h = await createHost({ targets: [{ id: "app", keepsExternalId: false }] });
    await h.app.fetch(`${h.app.url}/Users`, { method: "POST", headers: { authorization: `Bearer ${h.app.token}` }, body: JSON.stringify({ userName: "hand@example.com", name: { givenName: "Hand", familyName: "Made" } }) });
    const u = await h.ctx.internalAdapter.createUser({ email: "hand@example.com", name: "Hand Made", emailVerified: true }, { method: "admin" });
    await h.settle();
    expect(await h.links()).toEqual([expect.objectContaining({ userId: u.id, remoteId: [...h.app.users.keys()][0], active: true })]);
  });
});
