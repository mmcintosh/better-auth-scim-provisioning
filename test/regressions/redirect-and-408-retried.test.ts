// A single 3xx or 408 from a SCIM or Google target failed the job for good: a ban answered by a
// maintenance redirect left the user active at the app until a reconcile. Both are now retried.
import { describe, expect, it } from "vitest";
import { type Adapter, outbox } from "../../src/outbox";
import { createHost } from "../support/host";

describe("transient answers don't fail a deprovisioning", () => {
  for (const status of [307, 408]) {
    it(`SCIM ${status} is retried`, async () => {
      const h = await createHost({ retry: { baseDelayMs: 60_000 } });
      const u = await h.user();
      h.app.fail({ status });
      await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
      await h.settle();
      expect(await h.jobs()).toEqual([expect.objectContaining({ userId: u.id, failed: false })]);
    });
  }

  it("Google 307 is retried", async () => {
    const h = await createHost({ targets: [{ id: "other" }, { id: "first", type: "google-workspace" }] });
    const u = await h.user();
    let once = true;
    const fetch: typeof globalThis.fetch = async (i, init) => {
      if (once && init?.method === "PATCH") {
        once = false;
        return new Response(null, { status: 307, headers: { location: "https://maintenance.example.com" } });
      }
      return h.google.fetch(i, init);
    };
    const google = { clientEmail: h.google.clientEmail, privateKey: h.google.privateKey, adminEmail: h.google.admin, tokenUrl: h.google.tokenUrl };
    const box = outbox({ targets: [{ id: "first", type: "google-workspace", url: h.google.url, google, fetch }], retry: { baseDelayMs: 0 } }, h.ctx.adapter as unknown as Adapter, { warn() {}, error() {} });
    h.db.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?').run(u.id);
    await box.enqueue("first", u.id);
    expect(await box.runFor("first", u.id)).toBe("retry");
    expect(await box.runFor("first", u.id)).toBe("done");
    expect([...h.google.users.values()][0]!.suspended).toBe(true);
  });
});
