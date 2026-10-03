// At an app that drops externalId, a hand-made group of the same name as an organization was taken
// over after the first create timed out: the retry's 409 found a group with no externalId, and the
// pending link written before the first create was taken as proof the group was ours.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("a hand-made group isn't taken over after a timed-out first create", async () => {
  const h = await createHost({ targets: [{ id: "app", groups: true, keepsExternalId: false, timeoutMs: 200 }], retry: { baseDelayMs: 0 } });
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  const headers = { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  const at = { "content-type": "application/scim+json", authorization: `Bearer ${h.app.token}` };
  const hand = (await (await h.app.fetch(`${h.app.url}/Users`, { method: "POST", headers: at, body: JSON.stringify({ userName: "hand@example.com", name: { givenName: "Hand", familyName: "Made" } }) })).json()) as { id: string };
  await h.app.fetch(`${h.app.url}/Groups`, { method: "POST", headers: at, body: JSON.stringify({ displayName: "Acme", members: [{ value: hand.id }] }) });
  h.app.fail({ timeout: true });
  await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers });
  await h.settle();
  await h.auth.api.scimProvisioningRun({ body: {} });
  await h.settle();
  expect([...h.app.groups.values()]).toEqual([expect.objectContaining({ displayName: "Acme", members: [{ value: hand.id }] })]);
});
