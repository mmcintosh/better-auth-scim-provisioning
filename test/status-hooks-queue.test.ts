// The host's view and controls: scimProvisioningStatus (counts per target, or one user's state),
// onFailure (told when a delivery gives up or keeps failing), and scimProvisioningQueue (queue a
// user whose membership changed outside Better Auth's endpoints).
import { describe, expect, it } from "vitest";
import { createHost } from "./support/host";

describe("scimProvisioningStatus", () => {
  it("counts per target: queued, stuck (retrying past maxAttempts), failed, accounts, groups", async () => {
    const h = await createHost({ retry: { maxAttempts: 2, baseDelayMs: 0 } });
    await h.user("Ada Lovelace");
    h.app.fail({ status: 503 }, { status: 503 }, { status: 400, detail: "refused" });
    const bea = await h.user("Bea Berg"); // 503: queued
    await h.auth.api.scimProvisioningRun({ body: {} }); // 503 again: attempts 2 = maxAttempts, stuck
    await h.settle();
    const cy = await h.user("Cy Chen"); // 400: failed
    const status = await h.auth.api.scimProvisioningStatus({ body: {} });
    expect(status.targets).toEqual([{ id: "app", queued: 0, waiting: 0, stuck: 1, failed: 1, accounts: 1, groups: 0 }]);
    void bea;
    void cy;
  });

  it("one user's state at each target", async () => {
    const h = await createHost();
    const ada = await h.user("Ada Lovelace");
    const status = await h.auth.api.scimProvisioningStatus({ body: { userId: ada.id } });
    expect(status.user).toEqual([{ targetId: "app", account: { remoteId: expect.any(String), active: true, syncedAt: expect.any(String) }, job: null }]);
  });
});

describe("onFailure", () => {
  it("is told when a delivery gives up, and when it reaches maxAttempts; its own errors are only logged", async () => {
    const seen: unknown[] = [];
    const h = await createHost({
      retry: { maxAttempts: 2, baseDelayMs: 0 },
      onFailure: (f) => {
        seen.push(f);
        throw new Error("the host's alerting is down");
      },
    });
    h.app.fail({ status: 503 }, { status: 503 });
    const ada = await h.user("Ada Lovelace");
    expect(seen).toEqual([]); // the first 503: just a retry
    await h.auth.api.scimProvisioningRun({ body: {} });
    await h.settle();
    expect(seen).toEqual([expect.objectContaining({ targetId: "app", kind: "user", subjectId: ada.id, status: 503, attempts: 2, failed: false })]);
    h.app.fail({ status: 400, detail: "refused" });
    const bea = await h.user("Bea Berg");
    expect(seen[1]).toEqual(expect.objectContaining({ subjectId: bea.id, status: 400, failed: true, error: expect.stringContaining("refused") }));
  });
});

describe("scimProvisioningQueue", () => {
  it("queues and delivers a user whose membership changed outside Better Auth's endpoints", async () => {
    const h = await createHost({ targets: [{ id: "app", organizationId: "org_1" }] });
    const ada = await h.user("Ada Lovelace");
    expect(h.app.users.size).toBe(0); // not a member yet
    await h.ctx.adapter.create({ model: "organization", data: { id: "org_1", name: "Acme", slug: "acme", createdAt: new Date() }, forceAllowId: true });
    await h.ctx.adapter.create({ model: "member", data: { organizationId: "org_1", userId: ada.id, role: "member", createdAt: new Date() } }); // e.g. an SSO sync
    expect(await h.auth.api.scimProvisioningQueue({ body: { userId: ada.id } })).toEqual({ queued: 1 });
    await h.settle();
    expect([...h.app.users.values()].map((u) => u.userName)).toEqual([ada.email]);
  });

  it("refuses an unknown target", async () => {
    const h = await createHost();
    await expect(h.auth.api.scimProvisioningQueue({ body: { userId: "u1", targetId: "nope" } })).rejects.toThrow(/unknown target/);
  });
});
