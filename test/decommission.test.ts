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
    expect(await stateOf(h)).toMatchObject({ state: "frozen", accounts: 0 });
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
    const { h, bo } = await marked();
    await h.ctx.internalAdapter.updateUser(bo.id, { banned: true });
    await start(h, 3);
    await h.settle();
    const unmarked = unmarkedBox(h);
    // Everyone deactivated, but it isn't complete until its sweep looks again.
    await drive(h, () => unmarked.runDue(200), async () => appUsers(h).every((u) => !u.active));
    expect(await stateOf(h)).toMatchObject({ state: "running" });
    // Cancelled once the mark is gone (with it, the target would stay frozen): at once, not at the sweep's next look.
    expect(await unmarked.cancelDecommission("app", "server")).toBe(true);
    for (let i = 0; i < 3; i++) await unmarked.runDue(200);
    // Bo is banned: still off. The others are back, and so is the owner in the group.
    expect(appUsers(h).filter((u) => u.active).map((u) => u.userName).sort()).toEqual(["owner@example.com", "user1@example.com"]);
    expect([...h.app.groups.values()][0]?.members).toHaveLength(1);
  });

  it("finds an account written behind its walk, and waits for it", async () => {
    const { h } = await marked();
    await start(h, 3);
    await h.settle();
    const unmarked = unmarkedBox(h);
    await drive(h, () => unmarked.runDue(200), async () => appUsers(h).every((u) => !u.active));
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

  it("two starts at once make one decommission", async () => {
    const { h, box } = await marked();
    await Promise.all([box.startDecommission("app", "a"), box.startDecommission("app", "b")]);
    expect(await adapterOf(h).count({ model: "scimProvisioningDecommission" })).toBe(1);
    expect((await h.jobs()).filter((j) => j.kind === "decommission")).toHaveLength(1);
  });
});
