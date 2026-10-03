// A webhook group.upsert could list a user the receiver never accepted: the link is saved with
// the receiver's id before the first send, and group members came from active links.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("a user whose first upsert failed isn't in the group event", async () => {
  const h = await createHost({ targets: [{ id: "hook", type: "webhook", groups: true }], retry: { baseDelayMs: 60_000 } });
  const s = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(s.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: { cookie: res.headers.getSetCookie().map((c: string) => c.split(";")[0]).join("; ") } });
  await h.settle();
  h.webhook.fail(500);
  const ada = await h.user("Ada Lovelace");
  expect(h.webhook.users.has(ada.id)).toBe(false);
  await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "member" } });
  await h.settle();
  expect([...h.webhook.groups.values()][0]!.members).not.toContain(ada.id);
});
