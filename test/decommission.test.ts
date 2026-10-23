// Decommissioning a target: every account we made there deactivated and every group emptied
// (nothing deleted, whatever `deprovision` says), tracked in its own table, carried on by the
// scheduled run a page at a time, finished only when nothing of ours is active there; frozen while
// only marked; cancelled only before it completes.
import { describe, expect, it } from "vitest";
import { scimProvisioning } from "../src";
import { type Adapter, outbox } from "../src/outbox";
import { scimClient } from "../src/scim-client";
import type { ScimTarget } from "../src/types";
import { createHost } from "./support/host";
import { mockScim } from "./support/mock-scim";

type Host = Awaited<ReturnType<typeof createHost>>;
const quiet = { warn() {}, error() {} };
const appUsers = (h: Host) => [...h.app.users.values()];
const adapterOf = (h: Host) => h.ctx.adapter as unknown as Adapter;

/** The target as it was configured before it was marked for decommission. */
const unmarkedBox = (h: Host, more: Partial<ScimTarget> = {}) => outbox({ decommission: true, targets: [{ id: "app", url: h.app.url, token: h.app.token, fetch: h.app.fetch, groups: true, deprovision: "delete", ...more }] }, adapterOf(h), quiet);

/** Make jobs due within the hour due now, so retries and the decommission's sweep (a minute apart) run (a ban's recheck stays). */
const dueNow = (h: Host) =>
  adapterOf(h).updateMany({ model: "scimProvisioningJob", where: [{ field: "targetId", value: "app" }, { field: "nextAttemptAt", value: new Date(Date.now() + 3_600_000), operator: "lt" }], update: { nextAttemptAt: new Date(Date.now() - 1000) } });

/** Run until `done` says so (or give up). */
async function drive(h: Host, run: () => Promise<unknown>, done: () => Promise<boolean>) {
  for (let i = 0; i < 30; i++) {
    await h.settle();
    if (await done()) return;
    await run();
    await dueNow(h);
  }
  throw new Error(`didn't finish: ${JSON.stringify({ state: await stateOf(h), jobs: (await h.jobs()).map((j) => [j.kind ?? "user", j.userId, j.failed, j.attempts, j.lastStatus, j.lastError, j.nextAttemptAt]) })}`);
}

/** Run until every account at the app (but `except`) is off, with nothing made due early: its sweep, a minute later, hasn't looked yet. */
async function untilOff(h: Host, box: ReturnType<typeof outbox>, except?: string) {
  const off = () => appUsers(h).every((u) => !u.active || u.externalId === except);
  for (let i = 0; i < 10 && !off(); i++) {
    await box.runDue(200);
    await h.settle();
  }
  expect(off()).toBe(true);
}

const noJobs = (h: Host) => async () => (await h.jobs()).length === 0;
const stateOf = async (h: Host) => ((await h.auth.api.scimProvisioningStatus({ body: { targetId: "app" } })) as { targets: { decommission?: { state: string } | null }[] }).targets[0]?.decommission ?? null;
const reaches = (h: Host, state: string) => async () => (await stateOf(h))?.state === state;

async function owner(h: Host) {
  const s = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(s.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  return { cookie: res.headers.getSetCookie().map((c: string) => c.split(";")[0]).join("; ") };
}

/** A host whose target is marked for decommission, with accounts and a group made there before the mark. */
async function marked() {
  const h = await createHost({ decommission: true, targets: [{ id: "app", groups: true, deprovision: "delete", decommission: true }] });
  const ada = await h.user("Ada Lovelace");
  const bo = await h.user("Bo Bell");
  await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: await owner(h) });
  await h.settle();
  // Marked: nothing went out.
  expect(h.app.requests).toEqual([]);
  const box = unmarkedBox(h);
  await box.resume("app");
  await drive(h, () => box.runDue(200), noJobs(h));
  expect(appUsers(h).filter((u) => u.active)).toHaveLength(3);
  expect([...h.app.groups.values()][0]?.members).toHaveLength(1);
  return { h, ada, bo, box };
}

/** The adapter, with every call counted and `updateMany` open to a test's interference. */
function wrapped(a: Adapter, o: { before?: (x: Parameters<Adapter["updateMany"]>[0]) => Promise<void> } = {}) {
  const calls = { n: 0 };
  const proxy = new Proxy(a, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (typeof v !== "function") return v;
      return async (x: Parameters<Adapter["updateMany"]>[0]) => {
        calls.n++;
        if (p === "updateMany" && o.before) await o.before(x);
        return v.call(t, x);
      };
    },
  });
  return { adapter: proxy, calls };
}

const start = (h: Host, confirm?: number) => h.auth.api.scimProvisioningDecommission({ body: { targetId: "app", ...(confirm === undefined ? {} : { confirm }) } });

describe("decommissioning a target", () => {
  it("needs the plugin's option, and a target marked in code", async () => {
    const t = { id: "a", url: "https://app.example.com/scim/v2", token: "t" };
    expect(() => scimProvisioning({ targets: [{ ...t, decommission: true }] })).toThrow(/decommission needs the plugin's `decommission: true`/);
    const h = await createHost();
    await expect(start(h, 0)).rejects.toThrow(/needs the plugin's `decommission: true` option/);
    const h2 = await createHost({ decommission: true });
    await expect(start(h2, 0)).rejects.toThrow(/mark it `decommission: true`/);
    expect(await stateOf(h2)).toBeNull();
  });

  it("marked only, the target is frozen: nothing is sent, and the changes wait", async () => {
    const h = await createHost({ decommission: true, targets: [{ id: "app", decommission: true }] });
    await h.user();
    expect(h.app.requests).toEqual([]);
    const [job] = await h.jobs();
    expect(new Date(job!.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(await stateOf(h)).toMatchObject({ state: "frozen", accounts: 0, estimatedCompletionAt: null });
  });

  it("deactivates every account and empties every group, deleting nothing; then it's complete, and final", async () => {
    const { h } = await marked();
    expect(await h.auth.api.scimProvisioningDecommission({ body: { targetId: "app", preview: true } })).toMatchObject({ accounts: 3, groups: 1, decommission: { state: "frozen" } });
    // The count must be confirmed.
    await expect(start(h)).rejects.toThrow(/confirm the number of accounts to deactivate: 3/);
    await expect(start(h, 2)).rejects.toThrow(/: 3/);
    expect(await start(h, 3)).toMatchObject({ decommission: { phase: "deactivate", state: "running", total: 3, groupsTotal: 1, startedBy: "server" } });
    await drive(h, () => h.auth.api.scimProvisioningRun({ body: { limit: 200 } }), reaches(h, "complete"));
    // deprovision: "delete", but nothing was deleted: deactivated, and the group kept, empty.
    expect(appUsers(h).map((u) => u.active)).toEqual([false, false, false]);
    expect([...h.app.groups.values()].map((g) => g.members)).toEqual([[]]);
    expect(await stateOf(h)).toMatchObject({ state: "complete", accounts: 0, completedAt: expect.any(String) });
    // Nothing new goes there; a complete decommission can't be cancelled, or started again.
    const sent = h.app.requests.length;
    await h.user("Late Comer");
    await drive(h, () => h.auth.api.scimProvisioningRun({ body: {} }), noJobs(h));
    expect(h.app.requests.length).toBe(sent);
    await expect(h.auth.api.scimProvisioningDecommission({ body: { targetId: "app", cancel: true } })).rejects.toThrow(/no decommission is running/);
    await expect(start(h, 0)).rejects.toThrow(/is complete/);
  });

  it("removing the mark after it started doesn't cancel it", async () => {
    const { h } = await marked();
    await start(h, 3);
    await h.settle();
    // Deployed without the mark: still decommissioning.
    const unmarked = unmarkedBox(h);
    await drive(h, () => unmarked.runDue(200), reaches(h, "complete"));
    expect(appUsers(h).every((u) => !u.active)).toBe(true);
  });

  it("cancelled before it completes, it switches back on those still wanted and refills the groups", async () => {
    const { h, ada, bo } = await marked();
    await h.ctx.internalAdapter.updateUser(bo.id, { banned: true });
    // Ada's account can't be reached for now: it isn't complete.
    const adaAt = appUsers(h).find((u) => u.externalId === ada.id)!;
    for (let i = 0; i < 10; i++) for (const method of ["PATCH", "PUT"]) h.app.failOn(method, new RegExp(`^/Users/${adaAt.id}$`), { status: 503 });
    const unmarked = unmarkedBox(h);
    await unmarked.startDecommission("app", "server");
    await untilOff(h, unmarked, ada.id);
    expect(await stateOf(h)).toMatchObject({ state: "running" });
    // Cancelled once the mark is gone (with it, the target would stay frozen): at once, not at the sweep's next look.
    expect(await unmarked.cancelDecommission("app", "server")).toBe(true);
    // A step a run: its groups, its accounts, their deliveries, and the groups refilled after.
    for (let i = 0; i < 6; i++) await unmarked.runDue(200);
    // Bo is banned: still off. The others are back, and so is the owner in the group.
    expect(appUsers(h).filter((u) => u.active).map((u) => u.userName).sort()).toEqual(["owner@example.com", "user1@example.com"]);
    expect([...h.app.groups.values()][0]?.members).toHaveLength(1);
  });

  it("finds an account written behind its walk, and waits for it", async () => {
    const { h, ada } = await marked();
    // Ada's account can't be reached for a while: it isn't complete yet.
    const adaAt = appUsers(h).find((u) => u.externalId === ada.id)!;
    for (let i = 0; i < 3; i++) for (const method of ["PATCH", "PUT"]) h.app.failOn(method, new RegExp(`^/Users/${adaAt.id}$`), { status: 503 });
    const unmarked = unmarkedBox(h);
    await unmarked.startDecommission("app", "server");
    await untilOff(h, unmarked, ada.id);
    // A delivery that was under way when it started: an account made, its link written after the walk passed.
    const late = await h.ctx.internalAdapter.createUser({ email: "late@example.com", name: "Late Comer", emailVerified: true }, { method: "admin" });
    await h.settle();
    const remoteId = await scimClient({ url: h.app.url, token: h.app.token, fetch: h.app.fetch }).create({ schemas: [], userName: "late@example.com", externalId: late.id, name: { givenName: "Late", familyName: "Comer" }, active: true });
    await adapterOf(h).create({ model: "scimProvisioningLink", data: { key: `app:${late.id}`, targetId: "app", userId: late.id, remoteId, userName: "late@example.com", externalId: late.id, active: true, syncedAt: new Date() } });
    await drive(h, () => unmarked.runDue(200), reaches(h, "complete"));
    expect(h.app.users.get(remoteId)?.active).toBe(false);
  });

  it("an account the app won't deactivate leaves it blocked, not complete", async () => {
    const { h, ada } = await marked();
    const adaAt = appUsers(h).find((u) => u.externalId === ada.id)!;
    for (let i = 0; i < 10; i++) h.app.failOn("PATCH", new RegExp(`^/Users/${adaAt.id}$`), { status: 400, detail: "can't" });
    for (let i = 0; i < 10; i++) h.app.failOn("PUT", new RegExp(`^/Users/${adaAt.id}$`), { status: 400, detail: "can't" });
    await start(h, 3);
    await h.settle();
    const unmarked = unmarkedBox(h);
    await drive(h, () => unmarked.runDue(200), reaches(h, "blocked"));
    expect(h.app.users.get(adaAt.id)?.active).toBe(true);
  });

  it("an account it can't get through, dealt with at the app by hand, can be forgotten: then it completes", async () => {
    const { h, ada } = await marked();
    const adaAt = appUsers(h).find((u) => u.externalId === ada.id)!;
    for (let i = 0; i < 10; i++) for (const method of ["PATCH", "PUT"]) h.app.failOn(method, new RegExp(`^/Users/${adaAt.id}$`), { status: 400, detail: "can't" });
    const decommission = (body: Record<string, unknown>) => h.auth.api.scimProvisioningDecommission({ body: { targetId: "app", ...body } as never });
    await expect(decommission({ forget: [ada.id] })).rejects.toThrow(/only while a decommission runs/);
    await start(h, 3);
    const unmarked = unmarkedBox(h);
    await drive(h, () => unmarked.runDue(200), reaches(h, "blocked"));
    await expect(decommission({ forget: [ada.id], cancel: true })).rejects.toThrow(/forget goes alone/);
    expect(await decommission({ forget: [ada.id, ada.id] })).toMatchObject({ forgotten: 1 });
    await drive(h, () => unmarked.runDue(200), reaches(h, "complete"));
    // Left at the app as it was: someone dealt with it there.
    expect(h.app.users.get(adaAt.id)?.active).toBe(true);
  });

  it("estimates when it completes, at its pace so far", async () => {
    const { h, ada } = await marked();
    const adaAt = appUsers(h).find((u) => u.externalId === ada.id)!;
    for (let i = 0; i < 10; i++) for (const method of ["PATCH", "PUT"]) h.app.failOn(method, new RegExp(`^/Users/${adaAt.id}$`), { status: 503 });
    const unmarked = unmarkedBox(h);
    await unmarked.startDecommission("app", "server");
    expect(await stateOf(h)).toMatchObject({ estimatedCompletionAt: null });
    await untilOff(h, unmarked, ada.id);
    const status = (await stateOf(h)) as unknown as { state: string; accounts: number; estimatedCompletionAt: string | null };
    expect(status).toMatchObject({ state: "running", accounts: 1 });
    expect(new Date(status.estimatedCompletionAt as string).getTime()).toBeGreaterThan(Date.now());
  });

  it("isn't complete while a group is still to be emptied", async () => {
    const { h } = await marked();
    for (let i = 0; i < 40; i++) h.app.failOn("PUT", /^\/Groups\//, { status: 503 });
    await start(h, 3);
    const unmarked = unmarkedBox(h);
    await drive(h, () => unmarked.runDue(200), async () => appUsers(h).every((u) => !u.active));
    for (let i = 0; i < 4; i++) {
      await unmarked.runDue(200);
      await dueNow(h);
    }
    expect(await stateOf(h)).toMatchObject({ state: "running" });
    expect([...h.app.groups.values()][0]?.members).toHaveLength(1);
  });

  it("a timed ban doesn't hold it open", async () => {
    const { h, bo } = await marked();
    await h.ctx.internalAdapter.updateUser(bo.id, { banned: true, banExpires: new Date(Date.now() + 30 * 86_400_000) });
    const unmarked = unmarkedBox(h, { deprovision: "deactivate" });
    await drive(h, () => unmarked.runDue(200), async () => appUsers(h).find((u) => u.externalId === bo.id)?.active === false);
    // Bo's job waits for the ban to end.
    expect((await h.jobs()).map((j) => new Date(j.nextAttemptAt as Date).getTime() > Date.now() + 86_400_000)).toEqual([true]);
    await start(h, 2);
    await drive(h, () => unmarked.runDue(200), reaches(h, "complete"));
  });

  it("an account being made as it starts is deactivated straight after, not left for the sweep", async () => {
    const { h, box } = await marked();
    const late = await h.ctx.internalAdapter.createUser({ email: "late@example.com", name: "Late Comer", emailVerified: true }, { method: "admin" });
    await h.settle();
    await box.enqueue("app", late.id, { now: true });
    const release = h.app.hold();
    const delivery = box.runFor("app", late.id);
    await new Promise((r) => setTimeout(r, 50));
    await box.startDecommission("app", "server");
    release();
    await delivery;
    expect(appUsers(h).find((u) => u.userName === "late@example.com")?.active).toBe(false);
  });

  it("a group being made as it starts is emptied straight after", async () => {
    const h = await createHost({ decommission: true, targets: [{ id: "app", groups: true }] });
    const box = unmarkedBox(h, { deprovision: "deactivate" });
    await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: await owner(h) });
    await h.settle();
    const org = ((await adapterOf(h).findMany({ model: "organization" })) as { id: string }[])[0]!;
    // The organization's group, its delivery under way (made, its link not yet written) as it starts.
    await adapterOf(h).deleteMany({ model: "scimProvisioningGroupLink", where: [{ field: "targetId", value: "app" }] });
    h.app.groups.clear();
    await box.enqueue("app", org.id, { kind: "group", now: true });
    const release = h.app.hold();
    const delivery = box.runFor("app", org.id, "group");
    await new Promise((r) => setTimeout(r, 50));
    await box.startDecommission("app", "server");
    // Its walk of the groups passes before the link is written.
    await box.runFor("app", "step", "decommission");
    release();
    await delivery;
    await h.settle();
    const statusOf = async () => box.decommissionStatus((await box.source.get("app"))!);
    await drive(h, () => box.runDue(200), async () => (await statusOf())?.state === "complete");
    expect([...h.app.groups.values()].map((g) => g.members ?? [])).toEqual([[]]);
  });

  it("a purge, after it completes, deletes every account but adopted ones, and the groups; it can't be cancelled", async () => {
    const { h, ada } = await marked();
    const purge = (body: Record<string, unknown> = {}) => h.auth.api.scimProvisioningDecommission({ body: { targetId: "app", phase: "purge", ...body } as never });
    await expect(purge()).rejects.toThrow(/a purge comes after a complete decommission/);
    // Ada's account was there before us (taken over): it's only ever deactivated.
    await adapterOf(h).updateMany({ model: "scimProvisioningLink", where: [{ field: "key", value: `app:${ada.id}` }], update: { adopted: true } });
    await start(h, 3);
    await drive(h, () => h.auth.api.scimProvisioningRun({ body: { limit: 200 } }), reaches(h, "complete"));
    expect(await purge({ preview: true })).toMatchObject({ accounts: 2, groups: 1 });
    expect(await purge()).toMatchObject({ decommission: { phase: "purge", state: "running", total: 2, groupsTotal: 1 } });
    await expect(h.auth.api.scimProvisioningDecommission({ body: { targetId: "app", cancel: true } })).rejects.toThrow(/or a purge, can't be/);
    await drive(h, () => h.auth.api.scimProvisioningRun({ body: { limit: 200 } }), reaches(h, "complete"));
    expect(appUsers(h).map((u) => [u.externalId, u.active])).toEqual([[ada.id, false]]);
    expect(h.app.groups.size).toBe(0);
    expect(await stateOf(h)).toMatchObject({ phase: "purge", state: "complete", accounts: 0 });
    await expect(purge()).rejects.toThrow(/its purge is complete/);
  });

  it("a purge of more than 500 accounts needs their number confirmed", async () => {
    const { h } = await marked();
    await start(h, 3);
    await drive(h, () => h.auth.api.scimProvisioningRun({ body: { limit: 200 } }), reaches(h, "complete"));
    for (let i = 0; i < 498; i++) await adapterOf(h).create({ model: "scimProvisioningLink", data: { key: `app:old${i}`, targetId: "app", userId: `old${i}`, remoteId: `r${i}`, userName: `old${i}@example.com`, active: false, syncedAt: new Date() } });
    const purge = (body: Record<string, unknown> = {}) => h.auth.api.scimProvisioningDecommission({ body: { targetId: "app", phase: "purge", ...body } as never });
    await expect(purge()).rejects.toThrow(/confirm the number of accounts to delete: 501/);
    expect(await purge({ confirm: 501 })).toMatchObject({ decommission: { phase: "purge", total: 501 } });
  });

  it("drift reports an account of ours active again at a decommissioned target", async () => {
    const { h, ada } = await marked();
    await start(h, 3);
    await drive(h, () => h.auth.api.scimProvisioningRun({ body: { limit: 200 } }), reaches(h, "complete"));
    expect((await h.auth.api.scimProvisioningDrift({ body: { targetId: "app" } })).items).toEqual([]);
    const adaAt = appUsers(h).find((u) => u.externalId === ada.id)!;
    adaAt.active = true;
    expect((await h.auth.api.scimProvisioningDrift({ body: { targetId: "app" } })).items).toEqual([expect.objectContaining({ remoteId: adaAt.id, userId: ada.id, finding: "ours-active" })]);
  });

  it("two starts at once make one decommission", async () => {
    const { h, box } = await marked();
    await Promise.all([box.startDecommission("app", "a"), box.startDecommission("app", "b")]);
    expect(await adapterOf(h).count({ model: "scimProvisioningDecommission" })).toBe(1);
    expect((await h.jobs()).filter((j) => j.kind === "decommission")).toHaveLength(1);
  });

  it("a step that loses its race to another run of it keeps its job; a start queues again a step that was lost", async () => {
    const { h } = await marked();
    await unmarkedBox(h).startDecommission("app", "server");
    // Another run of the step (this one outlived its hold) moved the row on while this one ran.
    const a = adapterOf(h);
    let race = true;
    const { adapter } = wrapped(a, {
      before: async (x) => {
        if (!race || x.model !== "scimProvisioningDecommission") return;
        race = false;
        const row = (await a.findOne({ model: "scimProvisioningDecommission", where: [{ field: "targetId", value: "app" }] })) as { revision: number };
        await a.updateMany({ model: "scimProvisioningDecommission", where: [{ field: "targetId", value: "app" }], update: { revision: row.revision + 1 } });
      },
    });
    const racing = outbox({ decommission: true, targets: [{ id: "app", url: h.app.url, token: h.app.token, fetch: h.app.fetch, groups: true }] }, adapter, quiet);
    await dueNow(h);
    await racing.runFor("app", "step", "decommission");
    expect(race).toBe(false);
    const step = async () => (await h.jobs()).filter((j) => j.kind === "decommission");
    expect(await step()).toHaveLength(1);
    // Lost all the same (a deploy without the target): starting again queues it.
    await a.deleteMany({ model: "scimProvisioningJob", where: [{ field: "kind", value: "decommission" }] });
    expect(await start(h)).toMatchObject({ decommission: { state: "running" } });
    expect(await step()).toHaveLength(1);
    await drive(h, () => unmarkedBox(h).runDue(200), reaches(h, "complete"));
  });

  it("a ban's recheck for an account it no longer has, or a group's job that failed, doesn't hold it open", async () => {
    const { h, bo } = await marked();
    const unmarked = unmarkedBox(h);
    // deprovision: "delete": Bo's account and link go, and the job waits for the ban to end.
    await h.ctx.internalAdapter.updateUser(bo.id, { banned: true, banExpires: new Date(Date.now() + 30 * 86_400_000) });
    await drive(h, () => unmarked.runDue(200), async () => !appUsers(h).some((u) => u.externalId === bo.id));
    expect((await h.jobs()).map((j) => j.userId)).toEqual([bo.id]);
    // A group's create refused earlier: failed, with no link.
    const now = new Date();
    await adapterOf(h).create({ model: "scimProvisioningJob", data: { key: "app:group:gone", targetId: "app", userId: "gone", kind: "group", version: 1, attempts: 1, nextAttemptAt: now, lockedUntil: new Date("2000-01-01"), failed: true, lastError: "refused", lastStatus: 409, createdAt: now, updatedAt: now } });
    await start(h, 2);
    await drive(h, () => unmarked.runDue(200), reaches(h, "complete"));
  });

  it("a frozen target's backlog doesn't hold up the others' jobs", async () => {
    const h = await createHost({ decommission: true, targets: [] });
    const ada = await h.user();
    const other = mockScim();
    const box = outbox({ decommission: true, targets: [{ id: "frozen", url: h.app?.url ?? other.url, token: "t", fetch: other.fetch, decommission: true }, { id: "app2", url: other.url, token: other.token, fetch: other.fetch }] }, adapterOf(h), quiet);
    for (let i = 0; i < 250; i++) await box.enqueue("frozen", `u${i}`);
    await box.enqueue("app2", ada.id);
    expect(await box.runDue(50)).toMatchObject({ done: 1 });
    expect(other.users.size).toBe(1);
  });

  it("pointed at another app after it started, it stops: nothing is sent there, and it's blocked", async () => {
    const { h } = await marked();
    await unmarkedBox(h).startDecommission("app", "server");
    const elsewhere = mockScim();
    const moved = outbox({ decommission: true, targets: [{ id: "app", url: "https://elsewhere.test/tenant/scim/v2", token: elsewhere.token, fetch: elsewhere.fetch, groups: true }] }, adapterOf(h), quiet);
    for (let i = 0; i < 3; i++) {
      await moved.runDue(200);
      await dueNow(h);
    }
    expect(elsewhere.requests).toEqual([]);
    expect(await moved.decommissionStatus((await moved.source.get("app"))!)).toMatchObject({ state: "blocked" });
  });

  it("an account or group another target at the same app still has is left there, by the decommission and the purge", async () => {
    const h = await createHost({ decommission: true, targets: [{ id: "app", groups: true }] });
    const ada = await h.user("Ada Lovelace");
    await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: await owner(h) });
    await h.settle();
    const at = (id: string) => ({ id, url: h.app.url, token: h.app.token, fetch: h.app.fetch, groups: true });
    const box = outbox({ decommission: true, targets: [at("app"), at("app2")] }, adapterOf(h), quiet);
    // app2 reaches the same app: the owner's account and the organization's group are both targets' now.
    const olive = ((await adapterOf(h).findMany({ model: "user" })) as { id: string; email: string }[]).find((u) => u.email === "owner@example.com")!;
    const org = (await adapterOf(h).findMany({ model: "organization" })) as { id: string }[];
    await box.enqueue("app2", olive.id);
    await box.enqueue("app2", org[0]!.id, { kind: "group" });
    await drive(h, () => box.runDue(200), noJobs(h));
    expect(await adapterOf(h).count({ model: "scimProvisioningGroupLink" })).toBe(2);
    expect([...h.app.groups.values()].map((g) => g.members?.length)).toEqual([1]);
    const statusOf = async () => box.decommissionStatus((await box.source.get("app"))!);
    await box.startDecommission("app", "server");
    await drive(h, () => box.runDue(200), async () => (await statusOf())?.state === "complete");
    // Ada was only app's: deactivated. The owner and the group, app2's too: as they were.
    const accounts = () => appUsers(h).map((u) => [u.externalId === ada.id ? "ada" : u.externalId === olive.id ? "olive" : u.externalId, u.active]).sort();
    expect(accounts()).toEqual([["ada", false], ["olive", true]]);
    expect([...h.app.groups.values()].map((g) => g.members?.length)).toEqual([1]);
    await box.startPurge("app", "server");
    await drive(h, () => box.runDue(200), async () => (await statusOf())?.state === "complete");
    expect(accounts()).toEqual([["olive", true]]);
    expect(h.app.groups.size).toBe(1);
  });

  it("a step is a page of 50 and about 60 queries (D1 allows 1,000 an invocation)", async () => {
    const { h } = await marked();
    for (let i = 0; i < 200; i++) await adapterOf(h).create({ model: "scimProvisioningLink", data: { key: `app:old${i}`, targetId: "app", userId: `old${i}`, remoteId: `r${i}`, userName: `old${i}@example.com`, active: true, syncedAt: new Date() } });
    const { adapter, calls } = wrapped(adapterOf(h));
    const box = outbox({ decommission: true, targets: [{ id: "app", url: h.app.url, token: h.app.token, fetch: h.app.fetch, groups: true }] }, adapter, quiet);
    await box.startDecommission("app", "server");
    // Its groups, then a page of accounts.
    await box.runFor("app", "step", "decommission");
    calls.n = 0;
    await box.runFor("app", "step", "decommission");
    expect(calls.n).toBeLessThan(75);
    expect((await h.jobs()).filter((j) => (j.kind ?? "user") === "user")).toHaveLength(50);
  });
});
