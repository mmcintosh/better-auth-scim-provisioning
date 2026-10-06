// Found in review: at an app that drops externalId, a group made by hand AFTER our first create
// failed (503, timeout) was taken over on the retry: its 409 found a group with no externalId, and
// the pending link was taken as proof the group was ours, so its members were rewritten. A group
// without our externalId is now ours only if everyone in it is someone we'd put there; our own
// create whose reply was lost still is.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

/** A host whose app answers the first POST /Groups with a 503 or a lost reply. */
async function setup(answer: "fail" | "lose") {
  const h = await createHost({ targets: [{ id: "app", groups: true, keepsExternalId: false }], retry: { baseDelayMs: 0 } });
  h.app.failOn("POST", /^\/Groups$/, answer === "fail" ? { status: 503 } : { lostReply: true });
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  const headers = { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  return { h, headers, owner: [...h.app.users.values()].find((u) => u.userName === "owner@example.com")! };
}

it("a hand-made group, made after our first create failed, isn't taken over", async () => {
  const { h, headers } = await setup("fail");
  await h.auth.api.createOrganization({ body: { name: "Admins", slug: "admins" }, headers });
  await h.settle();
  expect(h.app.groups.size).toBe(0);
  // Meanwhile an admin at the app makes their own "Admins" group, with someone else in it.
  const at = { "content-type": "application/scim+json", authorization: `Bearer ${h.app.token}` };
  const hand = (await (await h.app.fetch(`${h.app.url}/Users`, { method: "POST", headers: at, body: JSON.stringify({ userName: "hand@example.com", name: { givenName: "Hand", familyName: "Made" } }) })).json()) as { id: string };
  await h.app.fetch(`${h.app.url}/Groups`, { method: "POST", headers: at, body: JSON.stringify({ displayName: "Admins", members: [{ value: hand.id }] }) });
  await h.auth.api.scimProvisioningRun({ body: {} });
  await h.settle();
  expect([...h.app.groups.values()]).toEqual([expect.objectContaining({ displayName: "Admins", members: [{ value: hand.id }] })]);
});

it("our own group, whose create reply was lost, is still found and kept (no second group)", async () => {
  const { h, headers, owner } = await setup("lose");
  await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers });
  await h.settle();
  await h.auth.api.scimProvisioningRun({ body: {} });
  await h.settle();
  expect([...h.app.groups.values()]).toEqual([expect.objectContaining({ displayName: "Acme", members: [{ value: owner.id }] })]);
  const links = await h.ctx.adapter.findMany<{ remoteId: string }>({ model: "scimProvisioningGroupLink" });
  expect(links.map((l) => l.remoteId)).toEqual([[...h.app.groups.values()][0]!.id]);
});
