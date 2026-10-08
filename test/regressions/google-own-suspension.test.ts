// Google suspends some new accounts itself (suspensionReason WEB_LOGIN_REQUIRED; found live,
// 2026-10-08): only the user signing in, or an admin, lifts that, and asking to through the API
// fails with 412 "Cannot restore a user suspended for abuse". Before, every change sent
// `suspended: false`, got that 412, and retried it for hours as "still creating the user". Now the
// hold is left as Google has it and the rest of the change goes; and that 412 isn't retried.
import { describe, expect, it } from "vitest";
import { googleWorkspaceClient } from "../../src/google";
import { createHost } from "../support/host";
import { mockGoogle } from "../support/mock-google";

describe("Google's own suspension of an account", () => {
  it("changes still go (names, enterprise attributes); the hold is left as Google has it", async () => {
    const h = await createHost({ targets: [{ id: "gw", type: "google-workspace", enterprise: true }], googleHoldNew: "WEB_LOGIN_REQUIRED", userFields: { department: { type: "string" } } });
    const ada = await h.user("Ada Lovelace");
    await h.ctx.internalAdapter.updateUser(ada.id, { name: "Ada King", department: "Engines" });
    await h.settle();
    const g = [...h.google.users.values()].find((u) => u.primaryEmail === ada.email) as any;
    expect(g).toMatchObject({ name: { givenName: "Ada", familyName: "King" }, suspended: true, suspensionReason: "WEB_LOGIN_REQUIRED" });
    expect(g.organizations).toEqual([{ department: "Engines", primary: true }]);
    expect(await h.jobs()).toEqual([]);
    // Our own deactivation still goes: then it's an admin's suspension, which we lift again.
    await h.ctx.internalAdapter.updateUser(ada.id, { banned: true });
    await h.settle();
    expect(g).toMatchObject({ suspended: true, suspensionReason: "ADMIN" });
    await h.ctx.internalAdapter.updateUser(ada.id, { banned: false });
    await h.settle();
    expect(g.suspended).toBe(false);
    expect(await h.jobs()).toEqual([]);
  });

  it("a 412 'suspended for abuse' is reported as Google's hold, and not retried", async () => {
    const google = await mockGoogle({ holdNew: "ABUSE" });
    const client = googleWorkspaceClient({ id: "gw", type: "google-workspace", url: google.url, fetch: google.fetch, google: { clientEmail: google.clientEmail, privateKey: google.privateKey, adminEmail: google.admin, tokenUrl: google.tokenUrl } });
    const id = await client.create({ schemas: [], userName: "bo@example.com", name: { givenName: "Bo", familyName: "Bell" }, active: true });
    // Straight at the API: what any PATCH lifting the hold gets.
    const e = await client.setActive(id, true).catch((x) => x);
    expect(e).toMatchObject({ status: 412, retryable: false });
    expect(e.message).toMatch(/Google suspended the account itself/);
  });
});
