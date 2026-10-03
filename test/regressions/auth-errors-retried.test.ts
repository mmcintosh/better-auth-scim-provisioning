// A 401 or 403 counted as "won't fix itself", so while a token was expired
// (AWS tokens last a year) every changed user's job failed for good, until that user changed again.
// It's the host's configuration, not the user: retry, and recover once the token is fixed.
import { describe, expect, it } from "vitest";
import { createHost } from "../support/host";

describe("a token problem is retried, not a permanent failure", () => {
  it("a 401 leaves the job waiting, and the scheduled run delivers it once the token works", async () => {
    const h = await createHost({ retry: { baseDelayMs: 0 } });
    h.app.fail({ status: 401, detail: "token expired" });
    const u = await h.ctx.internalAdapter.createUser({ email: "t@example.com", name: "Token Person", emailVerified: true }, { method: "admin" });
    await h.settle();
    expect(await h.jobs()).toEqual([expect.objectContaining({ failed: false, attempts: 1, lastError: expect.stringContaining("401") })]);
    expect(await h.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 1 });
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ externalId: u.id })]);
  });

  it("a 403 is retried too", async () => {
    const h = await createHost({ retry: { baseDelayMs: 0 } });
    h.app.fail({ status: 403 });
    await h.ctx.internalAdapter.createUser({ email: "f@example.com", name: "Forbidden Person", emailVerified: true }, { method: "admin" });
    await h.settle();
    expect(await h.jobs()).toEqual([expect.objectContaining({ failed: false })]);
  });
});
