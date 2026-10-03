// A paged reconcile did all its group work in its last call, whatever `limit` said: on Workers
// with D1, a few hundred organizations would run past the per-call limits, so `next` never reached
// null and groups were never reconciled. The group phase now has its own cursor, within `limit`.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("the group phase is paged by limit and still covers every organization", async () => {
  const h = await createHost({ targets: [{ id: "app", groups: true }] });
  for (let i = 0; i < 30; i++) await h.ctx.adapter.create({ model: "organization", data: { name: `Org ${i}`, slug: `org-${i}`, createdAt: new Date() } });
  let after: string | undefined;
  let calls = 0;
  let total = 0;
  for (;;) {
    const r = (await h.auth.api.scimProvisioningReconcile({ body: { limit: 5, ...(after ? { after } : {}) } })) as { queued: number; next: string | null };
    calls++;
    expect(r.queued).toBeLessThanOrEqual(5);
    total += r.queued;
    if (!r.next) break;
    after = r.next;
    expect(calls).toBeLessThan(50);
  }
  expect(total).toBe(30);
  const jobs = await h.jobs();
  expect(new Set(jobs.map((j) => j.userId)).size).toBe(30);
});
