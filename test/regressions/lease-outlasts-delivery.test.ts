// One delivery can make four requests (replace → create → find → replace),
// each allowed up to the target's timeoutMs (max 120 s), but the lease was a flat 60 s: a second
// worker could claim the job mid-delivery and deliver it again.
import { describe, expect, it } from "vitest";
import { createHost } from "../support/host";

describe("the lease outlasts the slowest delivery", () => {
  it("a job in flight is held for at least four requests' worth of the target's timeout", async () => {
    const h = await createHost({ targets: [{ id: "app", timeoutMs: 120_000 }] });
    const release = h.app.hold();
    const started = Date.now();
    await h.ctx.internalAdapter.createUser({ email: "slow@example.com", name: "Slow Person", emailVerified: true }, { method: "admin" });
    await new Promise((r) => setTimeout(r, 30)); // the delivery has claimed the job and is waiting at the app
    const [job] = (await h.jobs()) as { lockedUntil: Date }[];
    expect(new Date(job!.lockedUntil).getTime() - started).toBeGreaterThanOrEqual(4 * 120_000);
    release();
    await h.settle();
  });
});

// A delivery can make more than four requests: replace, find, create, find, replace; a 401 retry
// doubles any of them, and an OAuth target adds a token request.
it("the lease covers twelve requests' worth of the target's timeout", async () => {
  const h = await createHost({ targets: [{ id: "app", timeoutMs: 60_000 }] });
  const u = await h.user();
  const release = h.app.hold();
  await h.ctx.internalAdapter.updateUser(u.id, { name: "Changed Name" });
  await new Promise((r) => setTimeout(r, 50));
  const [job] = await h.jobs();
  expect(new Date(job!.lockedUntil as Date).getTime() - Date.now()).toBeGreaterThan(12 * 60_000);
  release();
  await h.settle();
});
