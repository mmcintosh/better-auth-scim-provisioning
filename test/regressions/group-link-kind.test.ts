// Group links say which group they are (`kind`: group, team or role; `subjectId`: the
// organization's, team's or role's id) in their own columns; links written before 1.0 have
// neither, and are still read from their key.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("new group links carry kind and subjectId; old ones without them still update their group", async () => {
  const h = await createHost({ targets: [{ id: "app", groups: true, teamGroups: true }] });
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  const headers = { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers });
  const team = await h.auth.api.createTeam({ body: { name: "Red", organizationId: org!.id }, headers });
  await h.auth.api.addTeamMember({ body: { teamId: team.id, userId: signUp.user.id }, headers });
  await h.settle();
  type Link = { key: string; kind: string | null; subjectId: string | null; organizationId: string };
  const links = await h.ctx.adapter.findMany<Link>({ model: "scimProvisioningGroupLink" });
  // The organization's group and the team's (Better Auth also makes a default team per organization).
  const shape = links.map((l) => ({ kind: l.kind, subjectId: l.subjectId, organizationId: l.organizationId }));
  expect(shape).toContainEqual({ kind: "group", subjectId: org!.id, organizationId: org!.id });
  expect(shape).toContainEqual({ kind: "team", subjectId: team.id, organizationId: org!.id });
  expect(shape.every((l) => l.kind && l.subjectId)).toBe(true);

  // As written before 1.0: no kind, no subjectId. A rename still finds and updates the team's group.
  await h.ctx.adapter.updateMany({ model: "scimProvisioningGroupLink", where: [], update: { kind: null, subjectId: null } });
  await h.auth.api.updateTeam({ body: { teamId: team.id, data: { name: "Blue" } }, headers });
  await h.settle();
  expect([...h.app.groups.values()].map((g) => g.displayName)).toContain("Acme / Blue");
  expect([...h.app.groups.values()].map((g) => g.displayName)).not.toContain("Acme / Red");
});
