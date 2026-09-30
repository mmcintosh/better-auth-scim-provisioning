// Review S2 F-5 (Medium, security): with requireVerifiedEmail: false, anyone could sign up with an
// address they don't own and be handed the matching account at the app, if one existed without an
// externalId. An existing app account is adopted only for a verified email.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("S2-5: an unverified user is never given an existing app account", async () => {
  const h = await createHost({ targets: [{ id: "app", requireVerifiedEmail: false }] });
  await h.app.fetch(`${h.app.url}/Users`, { method: "POST", headers: { authorization: `Bearer ${h.app.token}` }, body: JSON.stringify({ userName: "cfo@example.com", name: { givenName: "Real", familyName: "Cfo" } }) });
  const attacker = await h.ctx.internalAdapter.createUser({ email: "cfo@example.com", name: "Not The Cfo", emailVerified: false }, { method: "admin" });
  await h.settle();
  expect([...h.app.users.values()]).toEqual([expect.not.objectContaining({ externalId: expect.anything() })]);
  expect([...h.app.users.values()][0]).toMatchObject({ name: { givenName: "Real", familyName: "Cfo" } });
  expect(await h.jobs()).toEqual([expect.objectContaining({ userId: attacker.id, failed: true, lastError: expect.stringContaining("not verified") })]);
  expect(await h.links()).toEqual([]);
});

it("S2-5: an unverified user with a new address is still provisioned (requireVerifiedEmail: false)", async () => {
  const h = await createHost({ targets: [{ id: "app", requireVerifiedEmail: false }] });
  const u = await h.user("New Person", false);
  expect([...h.app.users.values()]).toEqual([expect.objectContaining({ externalId: u.id, active: true })]);
});
