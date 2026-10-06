// Found in review, all in the queue:
// - jobs held by a worker that died stayed at the head of the queue and used up the run's limit,
//   so due jobs behind them weren't delivered;
// - a 429's Retry-After was dropped when the job changed during that delivery, and the new change
//   was sent again at once;
// - a job's hold (its lease) wasn't renewed, so a long group delivery could be claimed by a second
//   worker halfway through.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

type Job = { id: string; key: string; nextAttemptAt: Date | string; lockedUntil: Date | string };
const at = (d: Date | string) => new Date(d).getTime();

it("jobs held by another worker don't use up the run's limit", async () => {
  const h = await createHost({ retry: { baseDelayMs: 0 } });
  h.app.fail(...Array.from({ length: 8 }, () => ({ status: 503 })));
  for (let i = 0; i < 8; i++) await h.user(`Person Number${i}`);
  const jobs = ((await h.jobs()) as Job[]).sort((a, b) => at(a.nextAttemptAt) - at(b.nextAttemptAt));
  expect(jobs).toHaveLength(8);
  // A worker that died mid-delivery, holding the four oldest (its hold still running).
  for (const j of jobs.slice(0, 4)) await h.ctx.adapter.update({ model: "scimProvisioningJob", where: [{ field: "id", value: j.id }], update: { lockedUntil: new Date(Date.now() + 600_000) } });
  expect(await h.auth.api.scimProvisioningRun({ body: { limit: 4 } })).toMatchObject({ done: 4, busy: 0 });
});

it("a 429's Retry-After holds even when the user changed during that delivery", async () => {
  const h = await createHost();
  const user = await h.user("Ada Lovelace");
  const sent = h.app.requests.length;
  const release = h.app.hold();
  await h.ctx.internalAdapter.updateUser(user.id, { name: "Ada King" }); // delivery starts, held
  await new Promise((r) => setTimeout(r, 50));
  await h.ctx.internalAdapter.updateUser(user.id, { name: "Ada Byron" }); // a new change meanwhile
  h.app.failOn("PUT", /^\/Users\//, { status: 429, retryAfter: "120" });
  release();
  await h.settle();
  // One PUT (answered 429); the new change waits out the Retry-After instead of going at once.
  expect(h.app.requests.slice(sent).filter((r) => r.method === "PUT")).toHaveLength(1);
  const [job] = (await h.jobs()) as Job[];
  expect(at(job!.nextAttemptAt)).toBeGreaterThan(Date.now() + 100_000);
});

it("a long group delivery keeps renewing its hold on the job", async () => {
  const h = await createHost({ targets: [{ id: "app", groups: true }] });
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  const headers = { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  const release = h.app.hold();
  await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers });
  await new Promise((r) => setTimeout(r, 200));
  const held = () => (h.jobs() as Promise<Job[]>).then((jobs) => jobs.find((j) => !j.key.includes(signUp.user.id)));
  const first = await held();
  expect(first && at(first.lockedUntil)).toBeGreaterThan(Date.now());
  await new Promise((r) => setTimeout(r, 6_000));
  expect(at((await held())!.lockedUntil)).toBeGreaterThan(at(first!.lockedUntil));
  release();
  await h.settle();
}, 20_000);
