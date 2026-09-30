// Review S1-1 (High): adopting an existing app user by userName could hand one person's account
// to another. User A is deleted (deactivated at the app, account kept); someone signs up with A's
// old email; the 409 → find → adopt path took A's account, reactivated it, and gave it to B.
import { describe, expect, it } from "vitest";
import { createHost } from "../support/host";

describe("S1-1: adoption never takes another user's account", () => {
  it("a new user with a deleted user's email is refused, not given the old account", async () => {
    const h = await createHost();
    const a = await h.ctx.internalAdapter.createUser({ email: "same@example.com", name: "First Owner", emailVerified: true }, { method: "admin" });
    await h.settle();
    await h.ctx.internalAdapter.deleteUser(a.id);
    await h.settle();
    const old = [...h.app.users.values()][0]!;
    expect(old).toMatchObject({ externalId: a.id, active: false });

    const b = await h.ctx.internalAdapter.createUser({ email: "same@example.com", name: "Second Person", emailVerified: true }, { method: "admin" });
    await h.settle();
    // A's account is untouched: still A's, still inactive, still A's name.
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ id: old.id, externalId: a.id, active: false, displayName: "First Owner" })]);
    expect(await h.jobs()).toEqual([expect.objectContaining({ userId: b.id, failed: true, lastError: expect.stringContaining("belongs to another user") })]);
  });

  it("an account provisioned by hand (no externalId) is still adopted", async () => {
    const h = await createHost();
    await h.app.fetch(`${h.app.url}/Users`, { method: "POST", headers: { authorization: `Bearer ${h.app.token}` }, body: JSON.stringify({ userName: "hand@example.com", name: { givenName: "Hand", familyName: "Made" } }) });
    const u = await h.ctx.internalAdapter.createUser({ email: "hand@example.com", name: "Hand Made", emailVerified: true }, { method: "admin" });
    await h.settle();
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ externalId: u.id, active: true })]);
  });
});
