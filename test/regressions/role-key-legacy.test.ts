// Role groups whose role has characters beyond [a-z0-9_-] ("Admin") get an encoded key in 1.0, so
// "Admin" and "admin" can't collide on MySQL. A link 0.3 wrote under the unencoded key is moved
// to the new key on its next delivery, rather than its group being refused as someone else's.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("a 0.3 role group link (unencoded key) is moved and its group updated, not refused", async () => {
  const h = await createHost({ targets: [{ id: "app", roleGroups: true }] });
  const ann = await h.user("Ann Admin");
  const org = await h.ctx.adapter.create<{ id: string }>({ model: "organization", data: { name: "Acme", slug: "acme", createdAt: new Date() } });
  await h.ctx.adapter.create({ model: "member", data: { organizationId: org.id, userId: ann.id, role: "Admin", createdAt: new Date() } });
  // As 0.3 left it: the group at the app (ours by externalId), linked under the unencoded key.
  const at = { "content-type": "application/scim+json", authorization: `Bearer ${h.app.token}` };
  const created = (await (await h.app.fetch(`${h.app.url}/Groups`, { method: "POST", headers: at, body: JSON.stringify({ displayName: "Acme / Admin", externalId: `role:${org.id}:Admin`, members: [] }) })).json()) as { id: string };
  await h.ctx.adapter.create({ model: "scimProvisioningGroupLink", data: { key: `app:role:${org.id}:Admin`, targetId: "app", organizationId: org.id, remoteId: created.id, displayName: "Acme / Admin", syncedAt: new Date() } });

  await h.auth.api.scimProvisioningQueue({ body: { organizationId: org.id } });
  await h.settle();
  const links = await h.ctx.adapter.findMany<{ key: string; remoteId: string; subjectId: string }>({ model: "scimProvisioningGroupLink" });
  expect(links).toEqual([expect.objectContaining({ key: expect.stringMatching(/:~41646d696e$/), remoteId: created.id, subjectId: `${org.id}:Admin` })]);
  const annAtApp = [...h.app.users.values()].find((u) => u.userName === ann.email)!.id;
  expect([...h.app.groups.values()]).toEqual([expect.objectContaining({ id: created.id, members: [{ value: annAtApp }] })]);
  expect(((await h.jobs()) as { failed: boolean }[]).every((j) => !j.failed)).toBe(true);
});
