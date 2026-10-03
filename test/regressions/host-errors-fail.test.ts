// An error from the host's own code (mapUser, include, a database query) was retried every six
// hours forever: it won't fix itself on a timer, unlike the app's errors.
import { expect, it } from "vitest";
import { defaultScimUser } from "../../src";
import { createHost } from "../support/host";

it("an error in mapUser fails the job after maxAttempts", async () => {
  let throwing = false;
  const h = await createHost({
    targets: [{ id: "app", mapUser: (u) => { if (throwing) throw new Error("mapUser broke"); return defaultScimUser(u); } }],
    retry: { baseDelayMs: 0, maxAttempts: 2 },
  });
  const u = await h.user();
  throwing = true;
  await h.ctx.internalAdapter.updateUser(u.id, { name: "Changed Name" });
  await h.settle();
  await h.auth.api.scimProvisioningRun({ body: {} });
  expect(await h.jobs()).toEqual([expect.objectContaining({ failed: true, attempts: 2, lastError: expect.stringContaining("mapUser broke") })]);
});
