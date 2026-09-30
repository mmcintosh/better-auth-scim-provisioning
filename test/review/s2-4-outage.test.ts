// Review S2 F-4 (Medium): retryable failures (5xx, timeouts, 401/403) counted toward maxAttempts
// and then failed the job for good. An outage or expired token longer than about an hour
// dropped every change in it, deprovisioning included, until a manual reconcile.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("S2-4: a job keeps retrying through an outage longer than maxAttempts, then delivers", async () => {
  const h = await createHost({ retry: { baseDelayMs: 0, maxAttempts: 3 } });
  const u = await h.user();
  h.app.fail(...Array.from({ length: 6 }, () => ({ status: 503 })));
  await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
  await h.settle();
  // Time passes: every wait (6 hours, once past maxAttempts) is over before each run.
  const due = async () => {
    for (const job of await h.jobs()) await h.ctx.adapter.updateMany({ model: "scimProvisioningJob", where: [{ field: "id", value: job.id as string }], update: { nextAttemptAt: new Date(0) } });
  };
  for (let i = 0; i < 5; i++) {
    await due();
    await h.auth.api.scimProvisioningRun({ body: {} });
  }
  expect(await h.jobs()).toEqual([expect.objectContaining({ failed: false, attempts: 6 })]);
  await due();
  expect(await h.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 1 });
  expect([...h.app.users.values()][0]).toMatchObject({ active: false });
});

it("S2-4: past maxAttempts, retries slow to the 6-hour cap", async () => {
  const h = await createHost({ retry: { baseDelayMs: 1000, maxAttempts: 2 } });
  h.app.fail(...Array.from({ length: 3 }, () => ({ status: 503 })));
  await h.user();
  for (const job of await h.jobs()) {
    await h.ctx.adapter.updateMany({ model: "scimProvisioningJob", where: [{ field: "id", value: job.id as string }], update: { nextAttemptAt: new Date(0) } });
  }
  await h.auth.api.scimProvisioningRun({ body: {} }); // attempt 2 = maxAttempts
  const [job] = await h.jobs();
  expect(job).toMatchObject({ failed: false, attempts: 2 });
  expect(new Date(job!.nextAttemptAt as Date).getTime() - Date.now()).toBeGreaterThan(5 * 3_600_000);
});
