// Review S2 F-11 (Low): leases were per job, so two duplicate jobs for one user (MongoDB builds its
// UNIQUE index lazily) could be delivered at once by two workers, and the older state could land
// last. A claimed job now clears free duplicates and defers to one already being delivered.
import { expect, it } from "vitest";
import { type Adapter, JOB_MODEL, type Job, outbox } from "../../src/outbox";
import { createHost } from "../support/host";

const log = { warn() {}, error() {} };

it("S2-11: two duplicate jobs for one user are never delivered at the same time", async () => {
  const h = await createHost();
  const u = await h.user();
  // Rebuild the job table without its UNIQUE key, as a lazily indexed database can be.
  h.db.exec(`CREATE TABLE "jobs_copy" AS SELECT * FROM "scimProvisioningJob" WHERE 0; DROP TABLE "scimProvisioningJob"; ALTER TABLE "jobs_copy" RENAME TO "scimProvisioningJob"`);
  const adapter = h.ctx.adapter as unknown as Adapter;
  const now = new Date();
  for (const id of ["dup-1", "dup-2"]) {
    await h.ctx.adapter.create({ model: JOB_MODEL, forceAllowId: true, data: { id, key: `app:${u.id}`, targetId: "app", userId: u.id, version: 1, attempts: 0, nextAttemptAt: now, lockedUntil: new Date("2000-01-01T00:00:00Z"), failed: false, createdAt: now, updatedAt: now } });
  }
  const box = outbox({ targets: [{ id: "app", url: h.app.url, token: h.app.token, fetch: h.app.fetch }] }, adapter, log);
  const jobs = (await h.jobs()) as unknown as Job[];
  const release = h.app.hold();
  const before = h.app.requests.length;
  const runs = Promise.all(jobs.map((j) => box.run(j)));
  await new Promise((r) => setTimeout(r, 50));
  expect(h.app.requests.length - before).toBe(1);
  release();
  const outcomes = await runs;
  expect(outcomes).toContain("done");
  expect(await h.jobs()).toEqual([]);
});
