// After switching a target from deactivate to delete, users already
// deactivated were never deleted, not even by reconcile.
import { expect, it } from "vitest";
import { type Adapter, outbox } from "../../src/outbox";
import { createHost } from "../support/host";

const log = { warn() {}, error() {} };

it("delete mode also deletes users who were only deactivated before", async () => {
  const h = await createHost();
  const u = await h.user();
  await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
  await h.settle();
  expect([...h.app.users.values()]).toEqual([expect.objectContaining({ active: false })]);

  const deleting = outbox({ targets: [{ id: "app", url: h.app.url, token: h.app.token, fetch: h.app.fetch, deprovision: "delete" }] }, h.ctx.adapter as unknown as Adapter, log);
  await deleting.enqueue("app", u.id, { now: true });
  expect(await deleting.runFor("app", u.id)).toBe("done");
  expect(h.app.users.size).toBe(0);
  expect(await h.links()).toEqual([]);
});
