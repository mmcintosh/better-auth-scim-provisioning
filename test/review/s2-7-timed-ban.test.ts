// Review S2 F-7 (Low): a timed ban deactivated the user at the app, and nothing reactivated them
// when it ran out: Better Auth clears an expired ban only when they next sign in.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("S2-7: a timed ban is lifted at the app when it runs out", async () => {
  const h = await createHost();
  const u = await h.user();
  await h.ctx.internalAdapter.updateUser(u.id, { banned: true, banExpires: new Date(Date.now() + 300) });
  await h.settle();
  expect([...h.app.users.values()][0]).toMatchObject({ active: false });
  expect(await h.jobs()).toEqual([expect.objectContaining({ userId: u.id, failed: false })]);
  expect(await h.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 0 });
  await new Promise((r) => setTimeout(r, 350));
  expect(await h.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 1 });
  expect([...h.app.users.values()][0]).toMatchObject({ active: true });
  expect(await h.jobs()).toEqual([]);
});
