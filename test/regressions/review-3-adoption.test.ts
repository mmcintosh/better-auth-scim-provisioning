// Found in the third review, before 1.0:
// - F1: after a create whose reply was lost, at an app that drops externalId, a retry that found
//   the account but couldn't take it over (a custom userName, an unverified email) dropped the
//   pending link: our own account stayed active at the app, and a later ban "succeeded" without a
//   request. The pending link is kept now, and a later leave fails loudly instead.
// - F2: accounts made elsewhere were taken over with no opt-out, then deleted (or, at Google,
//   suspended) when the Better Auth user left. Taking over is now a choice per target (`adopt`,
//   off by default for Google Workspace), and a taken-over account is never deleted, only
//   deactivated.
import { describe, expect, it } from "vitest";
import { defaultScimUser } from "../../src";
import { createHost } from "../support/host";

type Job = { failed: boolean; lastError: string | null };
type Link = { remoteId: string; adopted?: boolean | null };

describe("F1: our own lost create is never left unfindable", () => {
  it("a custom userName at an app that drops externalId: the pending link is kept, and a later ban fails loudly", async () => {
    const h = await createHost({ targets: [{ id: "app", keepsExternalId: false, mapUser: (u) => ({ ...defaultScimUser(u), userName: `h-${u.email.split("@")[0]}` }) }], retry: { baseDelayMs: 0 } });
    h.app.fail({ lostReply: true });
    const u = await h.user();
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect(await h.links()).toHaveLength(1); // still pending, not dropped
    expect(((await h.jobs()) as Job[])[0]).toMatchObject({ failed: true, lastError: expect.stringContaining("can't tell whether the app's account is ours") });
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    await h.auth.api.scimProvisioningRun({ body: {} });
    // Not "done" with nothing sent: the leave is a failed job someone will see.
    const jobs = (await h.jobs()) as Job[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ failed: true, lastError: expect.stringContaining("resolve it at the app") });
  });

  it("an unverified user (requireVerifiedEmail: false), same app: the same", async () => {
    const h = await createHost({ targets: [{ id: "app", keepsExternalId: false, requireVerifiedEmail: false }], retry: { baseDelayMs: 0 } });
    h.app.fail({ lostReply: true });
    const u = await h.user("Ada Lovelace", false);
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect(await h.links()).toHaveLength(1);
    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect(((await h.jobs()) as Job[])[0]).toMatchObject({ failed: true });
  });
});

describe("F2: taking over accounts made elsewhere", () => {
  const handMade = (h: Awaited<ReturnType<typeof createHost>>, email: string) =>
    h.app.fetch(`${h.app.url}/Users`, { method: "POST", headers: { authorization: `Bearer ${h.app.token}` }, body: JSON.stringify({ userName: email, name: { givenName: "Pre", familyName: "Existing" }, emails: [{ value: email }] }) });

  it("an account taken over is marked adopted, and deactivated, never deleted, even with deprovision: delete", async () => {
    const h = await createHost({ targets: [{ id: "app", deprovision: "delete" }] });
    await handMade(h, "user1@example.com");
    const u = await h.user();
    expect(((await h.links()) as Link[])[0]).toMatchObject({ adopted: true });
    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ userName: "user1@example.com", active: false })]);
  });

  it("an account we created is still deleted with deprovision: delete", async () => {
    const h = await createHost({ targets: [{ id: "app", deprovision: "delete" }] });
    const u = await h.user();
    expect(((await h.links()) as Link[])[0]?.adopted ?? false).toBe(false);
    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect(h.app.users.size).toBe(0);
  });

  it("adopt: false refuses an account made elsewhere", async () => {
    const h = await createHost({ targets: [{ id: "app", adopt: false }] });
    await handMade(h, "user1@example.com");
    await h.user();
    expect(await h.links()).toHaveLength(0);
    expect(((await h.jobs()) as Job[])[0]).toMatchObject({ failed: true, lastError: expect.stringContaining("adopt: false") });
    expect([...h.app.users.values()][0]?.externalId).toBeUndefined();
  });

  it("Google Workspace doesn't take over existing accounts unless told to", async () => {
    const h = await createHost({ targets: [{ id: "workspace", type: "google-workspace" }] });
    h.google.users.set("g-hand", { id: "g-hand", primaryEmail: "user1@example.com", name: { givenName: "Pre", familyName: "Existing" }, suspended: false } as never);
    await h.user();
    expect(((await h.jobs()) as Job[])[0]).toMatchObject({ failed: true, lastError: expect.stringContaining("default for Google Workspace") });

    const h2 = await createHost({ targets: [{ id: "workspace", type: "google-workspace", adopt: true }] });
    h2.google.users.set("g-hand", { id: "g-hand", primaryEmail: "user1@example.com", name: { givenName: "Pre", familyName: "Existing" }, suspended: false } as never);
    await h2.user();
    expect(((await h2.links()) as Link[])[0]).toMatchObject({ remoteId: "g-hand", adopted: true });
  });
});
