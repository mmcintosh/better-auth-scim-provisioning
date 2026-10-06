// Found in review: reconcile without `limit` walked every user, link and group in one call, past
// what a Workers invocation can do. It now takes 500 at a time by default and says where to go on.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("without limit, reconcile takes a page of 500 and returns where to go on", async () => {
  const h = await createHost();
  const insert = h.db.prepare('INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)');
  h.db.exec("BEGIN");
  for (let i = 0; i < 600; i++) insert.run(`u${String(i).padStart(4, "0")}`, `Person ${i}`, `p${i}@example.com`, Date.now(), Date.now());
  h.db.exec("COMMIT");
  const first = await h.auth.api.scimProvisioningReconcile({ body: {} });
  expect(first.queued).toBe(500);
  expect(first.next).toEqual(expect.any(String));
  const second = await h.auth.api.scimProvisioningReconcile({ body: { after: first.next! } });
  expect(second).toEqual({ queued: 100, next: null });
});
