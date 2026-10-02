// The scheduled run delivers `concurrency` jobs at once (default 4): one at a time was the
// bottleneck at scale in the field test (D-007).
import { describe, expect, it } from "vitest";
import { scimProvisioning } from "../src";
import { createHost } from "./support/host";

/** Six users whose first delivery failed, so all six are due for the scheduled run. */
async function sixDue(concurrency?: number) {
  const h = await createHost({ retry: { baseDelayMs: 0 }, ...(concurrency ? { concurrency } : {}) });
  h.app.fail(...Array.from({ length: 6 }, () => ({ status: 503 })));
  for (let i = 0; i < 6; i++) await h.user(`Person Number${i}`);
  return h;
}

describe("concurrent delivery", () => {
  for (const [concurrency, expected] of [[undefined, 4], [1, 1], [3, 3]] as const) {
    it(`${concurrency ?? "default"}: ${expected} at once`, async () => {
      const h = await sixDue(concurrency);
      const release = h.app.hold();
      const before = h.app.requests.length;
      const run = h.auth.api.scimProvisioningRun({ body: {} });
      await new Promise((r) => setTimeout(r, 100));
      expect(h.app.requests.length - before).toBe(expected);
      release();
      expect(await run).toEqual({ done: 6, retry: 0, failed: 0, busy: 0 });
      expect(h.app.users.size).toBe(6);
    });
  }

  it("refuses a concurrency out of range", () => {
    expect(() => scimProvisioning({ targets: [{ id: "a", url: "https://x.test/scim/v2", token: "t" }], concurrency: 0 })).toThrow(/concurrency/);
    expect(() => scimProvisioning({ targets: [{ id: "a", url: "https://x.test/scim/v2", token: "t" }], concurrency: 33 })).toThrow(/concurrency/);
  });
});
