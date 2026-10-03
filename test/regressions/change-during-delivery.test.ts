// A change could be lost when its enqueue raced the end of a delivery. The
// hook read the job, the finished delivery deleted it, then the bump updated nothing and nothing
// was queued: the app kept the old state until a reconcile.
import { expect, it } from "vitest";
import { type Adapter, JOB_MODEL, outbox } from "../../src/outbox";
import { createHost } from "../support/host";

const log = { warn() {}, error() {} };

it("a change whose job is deleted between read and bump is still queued and delivered", async () => {
  const h = await createHost();
  const u = await h.user("Before Change");
  // The same tables through an adapter whose next job lookup can be held, to line up the race.
  const a = h.ctx.adapter as unknown as Adapter;
  let holdNext = false;
  let resume!: () => void;
  let held!: () => void;
  const holding = new Promise<void>((r) => (held = r));
  const adapter: Adapter = {
    create: (x) => a.create(x),
    findOne: (x) => a.findOne(x),
    update: (x) => a.update(x),
    updateMany: (x) => a.updateMany(x),
    deleteMany: (x) => a.deleteMany(x),
    async findMany(x) {
      const rows = await a.findMany(x);
      if (holdNext && x.model === JOB_MODEL) {
        holdNext = false;
        held();
        await new Promise<void>((r) => (resume = r));
      }
      return rows;
    },
  };
  const box = outbox({ targets: [{ id: "app", url: h.app.url, token: h.app.token, fetch: h.app.fetch }] }, adapter, log);

  await box.enqueue("app", u.id);
  const release = h.app.hold();
  const delivery = box.runFor("app", u.id); // reads "Before Change"; its PUT waits at the app
  await new Promise((r) => setTimeout(r, 30));
  h.db.prepare('UPDATE "user" SET "name" = ? WHERE "id" = ?').run("After Change", u.id);
  holdNext = true;
  const change = box.enqueue("app", u.id); // finds the job, then waits
  await holding;
  release();
  expect(await delivery).toBe("done"); // the delivery deletes the job it claimed
  resume();
  await change;

  expect(await h.jobs()).toEqual([expect.objectContaining({ userId: u.id })]);
  expect(await box.runDue()).toMatchObject({ done: 1 });
  expect([...h.app.users.values()][0]).toMatchObject({ displayName: "After Change" });
});
