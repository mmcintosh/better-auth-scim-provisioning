// With groups: true and no organizationId, every organization any user creates became a group at
// the app, named as they like. `groups` can be a filter instead.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("groups can be a filter, so not every organization a user creates becomes a group", async () => {
  const h = await createHost({ targets: [{ id: "app", groups: (org) => (org.slug ?? "").startsWith("team-") }] });
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  const headers = { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  await h.auth.api.createOrganization({ body: { name: "Administrators", slug: "administrators" }, headers });
  await h.auth.api.createOrganization({ body: { name: "Team Red", slug: "team-red" }, headers });
  await h.settle();
  expect([...h.app.groups.values()].map((g) => g.displayName)).toEqual(["Team Red"]);
});
