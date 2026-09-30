// Review S2 F-2 (Medium): the link was saved only after a successful POST. When the POST reached
// the app but its reply was lost, and the user then left (banned, deleted, …), there was no link,
// so nothing was deprovisioned: the account stayed active at the app for good.
import { describe, expect, it } from "vitest";
import { createHost } from "../support/host";

describe("S2-2: a create whose reply was lost can still be undone", () => {
  it("the account is deactivated when the user is banned before the retry", async () => {
    const h = await createHost({ retry: { baseDelayMs: 60_000 } });
    h.app.fail({ lostReply: true });
    const u = await h.user();
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ externalId: u.id, active: true })]);
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ externalId: u.id, active: false })]);
    expect(await h.jobs()).toEqual([]);
  });

  it("nothing is left behind when the create never reached the app", async () => {
    const h = await createHost({ targets: [{ id: "app", timeoutMs: 100 }], retry: { baseDelayMs: 60_000 } });
    h.app.fail({ timeout: true });
    const u = await h.user();
    expect(h.app.users.size).toBe(0);
    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect(h.app.users.size).toBe(0);
    expect(await h.jobs()).toEqual([]);
    expect(await h.links()).toEqual([]);
  });

  it("the retry after a lost reply adopts the account it created", async () => {
    const h = await createHost({ retry: { baseDelayMs: 0 } });
    h.app.fail({ lostReply: true });
    const u = await h.user();
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect(h.app.users.size).toBe(1);
    expect(await h.links()).toEqual([expect.objectContaining({ userId: u.id, remoteId: [...h.app.users.keys()][0], active: true })]);
    expect(await h.jobs()).toEqual([]);
  });

  it("a pending account of unknown ownership is not deactivated, and the job says why", async () => {
    // The app ignores externalId, so after a lost reply we can't tell our account from one made
    // by hand with the same userName in the meantime.
    const h = await createHost({ targets: [{ id: "app", keepsExternalId: false }], retry: { baseDelayMs: 60_000 } });
    h.app.fail({ lostReply: true });
    const u = await h.user();
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ active: true })]);
    expect(await h.jobs()).toEqual([expect.objectContaining({ failed: true, lastError: expect.stringContaining("can't tell") })]);
  });
});
