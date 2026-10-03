// A worker holding an old list of due jobs could claim a job another worker had just put off
// (a 429 with Retry-After: an hour) and send it again at once: the claim only checked the lease.
import { expect, it } from "vitest";
import { type Adapter, type Job, outbox } from "../../src/outbox";
import { createHost } from "../support/host";

it("a job put off meanwhile isn't claimed from a stale list", async () => {
  const h = await createHost({ targets: [{ id: "other" }] });
  const u = await h.user();
  const box = outbox({ targets: [{ id: "app", url: h.app.url, token: h.app.token, fetch: h.app.fetch }] }, h.ctx.adapter as unknown as Adapter, { warn() {}, error() {} });
  await box.enqueue("app", u.id);
  const stale = (await h.jobs()).find((j) => j.targetId === "app") as unknown as Job;
  h.app.fail({ status: 429, retryAfter: "3600" });
  expect(await box.runFor("app", u.id)).toBe("retry");
  const before = h.app.requests.length;
  expect(await box.run(stale)).toBe("busy");
  expect(h.app.requests.length).toBe(before);
});
