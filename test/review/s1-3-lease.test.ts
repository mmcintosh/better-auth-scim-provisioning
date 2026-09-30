// Review S1-3 (Medium): one delivery can make four requests (replace → create → find → replace),
// each allowed up to the target's timeoutMs (max 120 s), but the lease was a flat 60 s: a second
// worker could claim the job mid-delivery and deliver it again.
import { describe, expect, it } from "vitest";
import { createHost } from "../support/host";

describe("S1-3: the lease outlasts the slowest delivery", () => {
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
