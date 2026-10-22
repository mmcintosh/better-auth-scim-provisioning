// Rate limits: an app's 429 (or Google's 403 rateLimitExceeded) holds every queued job of that
// target for its Retry-After, without counting an attempt; `maxRequestsPerMinute` spaces requests
// out before the app has to say so, and a scheduled run sends a paced target about a minute's worth.
import { describe, expect, it, vi } from "vitest";
import { scimProvisioning } from "../src";
import { googleWorkspaceClient } from "../src/google";
import { type Adapter, outbox } from "../src/outbox";
import { githubEnterprise } from "../src/profiles";
import type { ScimTarget } from "../src/types";
import { createHost } from "./support/host";
import { mockGoogle } from "./support/mock-google";
import { mockScim } from "./support/mock-scim";

const quiet = { warn() {}, error() {} };
type Host = Awaited<ReturnType<typeof createHost>>;
const target = (id: string, app: ReturnType<typeof mockScim>, more: Partial<ScimTarget> = {}): ScimTarget => ({ id, url: app.url, token: app.token, fetch: app.fetch, ...more });
const jobOf = async (h: Host, targetId: string, userId: string) => (await h.jobs()).find((j) => j.targetId === targetId && j.userId === userId)!;
const at = (d: unknown) => new Date(d as Date).getTime();

describe("an app's rate limit", () => {
  it("holds the target's other queued jobs for its Retry-After; other targets carry on", async () => {
    const h = await createHost();
    const [ada, bo] = [await h.user("Ada Lovelace"), await h.user("Bo Bell")];
    const slow = mockScim();
    const fast = mockScim();
    const box = outbox({ targets: [target("slow", slow), target("fast", fast)] }, h.ctx.adapter as unknown as Adapter, quiet);
    for (const [t, u] of [["slow", ada], ["slow", bo], ["fast", ada]] as const) await box.enqueue(t, u.id);
    slow.fail({ status: 429, retryAfter: "120" });
    expect(await box.runFor("slow", ada.id)).toBe("retry");
    const sent = slow.requests.length;
    for (const u of [ada, bo]) {
      const job = await jobOf(h, "slow", u.id);
      expect(job).toMatchObject({ attempts: 0, failed: false, lastStatus: 429 });
      expect(at(job.nextAttemptAt)).toBeGreaterThan(Date.now() + 100_000);
    }
    expect(await box.runDue()).toMatchObject({ done: 1, retry: 0 });
    expect(slow.requests.length).toBe(sent);
    expect(fast.users.size).toBe(1);
  });

  it("never counts toward maxAttempts, so it doesn't make the job stuck or call onFailure", async () => {
    const h = await createHost();
    const ada = await h.user();
    const app = mockScim();
    const onFailure = vi.fn();
    const box = outbox({ targets: [target("app2", app)], retry: { maxAttempts: 1, baseDelayMs: 0 }, onFailure }, h.ctx.adapter as unknown as Adapter, quiet);
    await box.enqueue("app2", ada.id);
    for (let i = 0; i < 3; i++) {
      app.fail({ status: 429, retryAfter: "0" });
      expect(await box.runFor("app2", ada.id)).toBe("retry");
    }
    expect(await jobOf(h, "app2", ada.id)).toMatchObject({ attempts: 0, failed: false });
    expect(onFailure).not.toHaveBeenCalled();
    expect(await box.runFor("app2", ada.id)).toBe("done");
    expect(app.users.size).toBe(1);
  });

  it("waits a minute when the app gives no Retry-After", async () => {
    const h = await createHost();
    const ada = await h.user();
    const app = mockScim();
    const box = outbox({ targets: [target("app2", app)], retry: { baseDelayMs: 0 } }, h.ctx.adapter as unknown as Adapter, quiet);
    await box.enqueue("app2", ada.id);
    app.fail({ status: 429 });
    expect(await box.runFor("app2", ada.id)).toBe("retry");
    expect(at((await jobOf(h, "app2", ada.id)).nextAttemptAt)).toBeGreaterThan(Date.now() + 50_000);
  });

  it("Google's 403 rateLimitExceeded is a rate limit, not the credentials", async () => {
    const google = await mockGoogle();
    const f: typeof fetch = async (i, init) =>
      String(i).startsWith(google.url)
        ? new Response(JSON.stringify({ error: { code: 403, message: "Rate Limit Exceeded", errors: [{ domain: "usageLimits", reason: "userRateLimitExceeded", message: "Rate Limit Exceeded" }] } }), { status: 403, headers: { "content-type": "application/json" } })
        : google.fetch(i, init);
    const client = googleWorkspaceClient({ id: "gw", type: "google-workspace", url: google.url, fetch: f, google: { clientEmail: google.clientEmail, privateKey: google.privateKey, adminEmail: google.admin, tokenUrl: google.tokenUrl } });
    const e = await client.findByUserName("bo@example.com").catch((x) => x);
    expect(e).toMatchObject({ status: 403, retryable: true, rateLimited: true });
    expect(e.message).toMatch(/Google's rate limit/);
    expect(e.message).not.toMatch(/service account/);
  });
});

describe("maxRequestsPerMinute", () => {
  it("spaces a target's requests out", async () => {
    const h = await createHost();
    const ada = await h.user();
    const app = mockScim();
    const times: number[] = [];
    const f: typeof fetch = (i, init) => {
      times.push(Date.now());
      return app.fetch(i, init);
    };
    const box = outbox({ targets: [target("app2", app, { fetch: f, maxRequestsPerMinute: 600 })] }, h.ctx.adapter as unknown as Adapter, quiet);
    for (const name of ["Ada King", "Ada Byron"]) {
      await box.enqueue("app2", ada.id);
      expect(await box.runFor("app2", ada.id)).toBe("done");
      await h.ctx.internalAdapter.updateUser(ada.id, { name });
    }
    expect(times.length).toBeGreaterThan(1);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(90);
  });

  it("a request that would wait too long holds the job like the app's 429, without sending it", async () => {
    const h = await createHost();
    const ada = await h.user();
    const app = mockScim();
    const box = outbox({ targets: [target("app2", app, { maxRequestsPerMinute: 1 })] }, h.ctx.adapter as unknown as Adapter, quiet);
    await box.enqueue("app2", ada.id);
    expect(await box.runFor("app2", ada.id)).toBe("done");
    await h.ctx.internalAdapter.updateUser(ada.id, { name: "Ada King" });
    await box.enqueue("app2", ada.id);
    // The next request's turn is a minute away.
    expect(await box.runFor("app2", ada.id)).toBe("retry");
    expect(app.requests.length).toBe(1);
    const job = await jobOf(h, "app2", ada.id);
    expect(job).toMatchObject({ attempts: 0, failed: false, lastStatus: 429, lastError: expect.stringContaining("maxRequestsPerMinute") });
    expect(at(job.nextAttemptAt)).toBeGreaterThan(Date.now() + 50_000);
  });

  it("a scheduled run takes about a minute's worth of a paced target's jobs, and the rest as usual", async () => {
    const h = await createHost();
    const users = [await h.user("Ada Lovelace"), await h.user("Bo Bell"), await h.user("Cy Young")];
    const slow = mockScim();
    const fast = mockScim();
    const box = outbox({ targets: [target("slow", slow, { maxRequestsPerMinute: 1 }), target("fast", fast)] }, h.ctx.adapter as unknown as Adapter, quiet);
    for (const u of users) {
      await box.enqueue("slow", u.id);
      await box.enqueue("fast", u.id);
    }
    // One of slow's (its pace; a second would only wait its turn), all of fast's.
    expect(await box.runDue()).toEqual({ done: 4, retry: 0, failed: 0, busy: 0 });
    expect([slow.users.size, fast.users.size]).toEqual([1, 3]);
  });

  it("the githubEnterprise profile sets 30, unless the target says otherwise; it must be a positive integer", () => {
    const app = mockScim();
    expect(githubEnterprise(target("gh", app)).maxRequestsPerMinute).toBe(30);
    expect(githubEnterprise(target("gh", app, { maxRequestsPerMinute: 10 })).maxRequestsPerMinute).toBe(10);
    expect(() => scimProvisioning({ targets: [target("gh", app, { maxRequestsPerMinute: 0 })] })).toThrow(/maxRequestsPerMinute/);
  });
});
