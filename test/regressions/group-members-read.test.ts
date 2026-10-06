// Found in review: with `groupUpdate: "patch"`, a group's current members are read back to work out
// who to remove. An app that lists a group's members only when asked for them read as "no members",
// so nobody was ever removed; and members listed by startIndex pages (not cursors) were read only
// to the first page. Members are now asked for by name, and both kinds of paging are followed.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

type Host = Awaited<ReturnType<typeof createHost>>;

async function owner(h: Host) {
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  return { headers: { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } };
}

/** An organization with the owner and three more members; then the last one is removed. */
async function leaveAt(h: Host) {
  const o = await owner(h);
  const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: o.headers });
  const people = [await h.user("Ada Lovelace"), await h.user("Bea Berg"), await h.user("Cy Chen")];
  for (const p of people) await h.auth.api.addMember({ body: { userId: p.id, organizationId: org!.id, role: "member" } });
  await h.settle();
  const gone = people[2]!;
  const goneId = [...h.app.users.values()].find((u) => u.userName === gone.email)!.id;
  expect([...h.app.groups.values()][0]!.members.map((m) => m.value)).toContain(goneId);
  await h.auth.api.removeMember({ body: { memberIdOrEmail: gone.email, organizationId: org!.id }, headers: o.headers });
  await h.settle();
  return { goneId, members: [...h.app.groups.values()][0]!.members.map((m) => m.value) };
}

it("a member who leaves is removed at an app that lists group members only when asked", async () => {
  const h = await createHost({ targets: [{ id: "app", groups: true, compat: { groupUpdate: "patch" }, membersOnRequest: true }] });
  const { goneId, members } = await leaveAt(h);
  expect(members).not.toContain(goneId);
  expect(members).toHaveLength(3);
});

it("a member who leaves is removed when the app lists group members by startIndex pages", async () => {
  const h = await createHost({ targets: [{ id: "app", groups: true, compat: { groupUpdate: "patch", groupMembers: "users-filter" }, indexPaged: true, pageSize: 2 }] });
  const { goneId, members } = await leaveAt(h);
  expect(members).not.toContain(goneId);
  expect(members).toHaveLength(3);
});
