// Found live: for a few seconds after a create, Google answers 404 for the new user by id (though
// it's there by email, and updates by id work), and 412 "User creation is not complete" to a
// delete. An update then failed its job for good (its read by id 404'd), and so did a delete.
import { expect, it } from "vitest";
import { type Adapter, outbox } from "../../src/outbox";
import { createHost } from "../support/host";

it("a user renamed right after being created is updated, not failed", async () => {
  const h = await createHost({ targets: [{ id: "workspace", type: "google-workspace" }], googleLag: 3, retry: { baseDelayMs: 0 } });
  const u = await h.user("Ada Lovelace");
  await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Byron" });
  await h.settle();
  // Retried, not failed, while Google finishes creating the user.
  expect((await h.jobs()).every((j) => j.failed === false)).toBe(true);
  for (let i = 0; i < 5 && (await h.jobs()).length; i++) await h.auth.api.scimProvisioningRun({ body: {} });
  expect(await h.jobs()).toEqual([]);
  expect([...h.google.users.values()]).toEqual([expect.objectContaining({ name: { givenName: "Ada", familyName: "Byron" }, externalIds: [expect.objectContaining({ value: u.id })] })]);
});

it("a delete Google isn't ready for yet (412) is retried", async () => {
  const h = await createHost({ targets: [{ id: "other" }, { id: "first", type: "google-workspace" }], googleLag: 1 });
  const google = { clientEmail: h.google.clientEmail, privateKey: h.google.privateKey, adminEmail: h.google.admin, tokenUrl: h.google.tokenUrl };
  const box = outbox({ targets: [{ id: "workspace", type: "google-workspace", url: h.google.url, google, fetch: h.google.fetch, deprovision: "delete" }], retry: { baseDelayMs: 0 } }, h.ctx.adapter as unknown as Adapter, { warn() {}, error() {} });
  const u = await h.user("Ada Lovelace");
  await box.enqueue("workspace", u.id);
  // Adopts the account the other target made (ours by externalId), then it's deleted at once.
  expect(await box.runFor("workspace", u.id)).toBe("done");
  // As if it had been created a moment ago: Google answers its delete with 412 once.
  await h.ctx.internalAdapter.deleteUser(u.id);
  await h.settle();
  h.google.settling.set([...h.google.users.keys()][0]!, 1);
  await box.enqueue("workspace", u.id);
  expect(await box.runFor("workspace", u.id)).toBe("retry");
  expect(await box.runFor("workspace", u.id)).toBe("done");
  expect(h.google.users.size).toBe(0);
});

// Found live: while Google applies an email change, it answers the next changes with 409 "Entity
// already exists". A ban right after an email change failed for good, leaving the user active.
it("a ban right after an email change is retried until Google applies it", async () => {
  const h = await createHost({ targets: [{ id: "workspace", type: "google-workspace" }], googleRenameLag: 2, retry: { baseDelayMs: 0 } });
  const u = await h.user("Ada Lovelace");
  await h.ctx.internalAdapter.updateUser(u.id, { email: "ada.byron@example.com" });
  await h.settle();
  await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
  await h.settle();
  expect((await h.jobs()).every((j) => j.failed === false)).toBe(true);
  for (let i = 0; i < 5 && (await h.jobs()).length; i++) await h.auth.api.scimProvisioningRun({ body: {} });
  expect(await h.jobs()).toEqual([]);
  expect([...h.google.users.values()]).toEqual([expect.objectContaining({ primaryEmail: "ada.byron@example.com", suspended: true })]);
});

it("a new email another account holds still fails, with a clear message", async () => {
  const h = await createHost({ targets: [{ id: "workspace", type: "google-workspace" }] });
  h.google.users.set("boss", { id: "boss", primaryEmail: "boss@example.com", name: { givenName: "The", familyName: "Boss" }, suspended: false });
  const u = await h.user("Ada Lovelace");
  await h.ctx.internalAdapter.updateUser(u.id, { email: "boss@example.com" });
  await h.settle();
  expect(await h.jobs()).toEqual([expect.objectContaining({ userId: u.id, failed: true, lastError: expect.stringContaining("another Workspace account") })]);
});
