// Found in the field test on Cloudflare D1: reconcile looked up a whole page of linked user ids in
// one `in` query, and D1 refuses more than 100 bound parameters per statement.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("reconcile never sends an `in` list longer than D1 allows", async () => {
  const h = await createHost();
  const insert = h.db.prepare('INSERT INTO "scimProvisioningLink" ("id", "key", "targetId", "userId", "remoteId", "userName", "active", "syncedAt") VALUES (?, ?, ?, ?, ?, ?, 0, ?)');
  for (let i = 0; i < 150; i++) insert.run(`link-${i}`, `app:gone-${i}`, "app", `gone-${i}`, `r${i}`, `gone-${i}@example.com`, Date.now());
  const adapter = h.ctx.adapter as unknown as { findMany(a: { where?: { value: unknown }[] }): Promise<unknown> };
  const findMany = adapter.findMany.bind(adapter);
  let longest = 0;
  adapter.findMany = async (a) => {
    for (const w of a.where ?? []) if (Array.isArray(w.value)) longest = Math.max(longest, w.value.length);
    return findMany(a);
  };
  expect(await h.auth.api.scimProvisioningReconcile({ body: {} })).toEqual({ queued: 150, next: null });
  expect(longest).toBeGreaterThan(0);
  expect(longest).toBeLessThanOrEqual(50);
});
