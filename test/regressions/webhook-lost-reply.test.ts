// A webhook whose reply was lost left a pending link with no id, and a webhook has no lookup to
// settle it: a user banned afterwards was never deactivated at the receiver. A webhook's id is our
// externalId, known before sending, so the link holds it from the start.
import { expect, it } from "vitest";
import { type Adapter, outbox } from "../../src/outbox";
import { createHost } from "../support/host";
import { mockWebhook } from "../support/mock-webhook";

const quiet = { warn() {}, error() {} };

it("a user banned after a lost webhook reply is still deactivated at the receiver", async () => {
  const h = await createHost({ targets: [{ id: "other" }] });
  const wh = mockWebhook();
  let lose = true;
  const f: typeof fetch = async (i, init) => {
    const r = await wh.fetch(i, init);
    if (lose) {
      lose = false;
      throw new TypeError("network connection lost");
    }
    return r;
  };
  const box = outbox({ targets: [{ id: "hook", type: "webhook", url: wh.url, secret: wh.secret, fetch: f }], retry: { baseDelayMs: 0 } }, h.ctx.adapter as unknown as Adapter, quiet);
  const u = await h.user("Ada");
  await box.enqueue("hook", u.id);
  expect(await box.runFor("hook", u.id)).toBe("retry");
  expect(wh.users.get(u.id)?.active).toBe(true);
  h.db.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?').run(u.id);
  await box.enqueue("hook", u.id);
  await box.runFor("hook", u.id);
  expect(wh.users.get(u.id)?.active).toBe(false);
});

it("a group whose create reply was lost is still deleted at the receiver when it goes", async () => {
  const h = await createHost({ targets: [{ id: "other" }] });
  const wh = mockWebhook();
  let lose = true;
  const f: typeof fetch = async (i, init) => {
    const r = await wh.fetch(i, init);
    if (lose && String(init?.body ?? "").includes('"group.upsert"')) {
      lose = false;
      throw new TypeError("network connection lost");
    }
    return r;
  };
  const box = outbox({ targets: [{ id: "hook", type: "webhook", url: wh.url, secret: wh.secret, fetch: f, groups: true }], retry: { baseDelayMs: 0 } }, h.ctx.adapter as unknown as Adapter, quiet);
  const org = (await h.ctx.adapter.create({ model: "organization", data: { name: "Acme", slug: "acme", createdAt: new Date() } })) as { id: string };
  await box.enqueue("hook", org.id, { kind: "group" });
  expect(await box.runFor("hook", org.id, "group")).toBe("retry");
  expect(wh.groups.has(org.id)).toBe(true);
  await h.ctx.adapter.deleteMany({ model: "organization", where: [{ field: "id", value: org.id }] });
  await box.enqueue("hook", org.id, { kind: "group" });
  expect(await box.runFor("hook", org.id, "group")).toBe("done");
  expect(wh.groups.has(org.id)).toBe(false);
});

it("a receiver's Retry-After is honoured", async () => {
  const h = await createHost({ targets: [{ id: "other" }] });
  const wh = mockWebhook();
  const f: typeof fetch = async () => new Response("busy", { status: 429, headers: { "retry-after": "120" } });
  const box = outbox({ targets: [{ id: "hook", type: "webhook", url: wh.url, secret: wh.secret, fetch: f }], retry: { baseDelayMs: 0 } }, h.ctx.adapter as unknown as Adapter, quiet);
  const u = await h.user("Ada");
  await box.enqueue("hook", u.id);
  expect(await box.runFor("hook", u.id)).toBe("retry");
  const job = (await h.jobs()).find((j) => j.targetId === "hook")!;
  expect(new Date(job.nextAttemptAt as Date).getTime() - Date.now()).toBeGreaterThan(100_000);
});
