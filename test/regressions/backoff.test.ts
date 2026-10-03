// Every change reset a job's backoff, so a busy user kept hitting an app that
// asked for a pause; and a huge Retry-After made an invalid date, leaving the job wedged.
import { describe, expect, it } from "vitest";
import { retryAfterMs } from "../../src/scim-client";
import { createHost } from "../support/host";

describe("backoff", () => {
  it("a change doesn't cut short the pause an app asked for", async () => {
    const h = await createHost();
    h.app.fail({ status: 429, retryAfter: "3600" });
    const u = await h.user();
    const sent = h.app.requests.length;
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Busy Person" });
    await h.settle();
    expect(h.app.requests.length).toBe(sent);
    const [job] = await h.jobs();
    expect(new Date(job!.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it("reconcile does start over (after fixing a target)", async () => {
    const h = await createHost();
    h.app.fail({ status: 503 });
    await h.user();
    await h.auth.api.scimProvisioningReconcile({ body: {} });
    expect(await h.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 1 });
  });

  it("Retry-After is capped at a day", async () => {
    expect(retryAfterMs("99999999999999")).toBe(86_400_000);
    const h = await createHost();
    h.app.fail({ status: 429, retryAfter: "99999999999999" });
    await h.user();
    const [job] = await h.jobs();
    expect(job).toMatchObject({ attempts: 1, failed: false });
    expect(new Date(job!.lockedUntil as Date).getTime()).toBeLessThan(Date.now());
  });
});
