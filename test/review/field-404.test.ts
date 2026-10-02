// Found in the Workers field test: a target URL that 404s for everything (a typo, a moved SCIM
// path; there, a Worker calling its own workers.dev address) made every deprovisioning look done:
// a 404 for one user was taken as "already gone at the app", and the user stayed active there.
import { describe, expect, it } from "vitest";
import { type Adapter, outbox } from "../../src/outbox";
import { scimClient } from "../../src/scim-client";
import { createHost } from "../support/host";

const log = { warn() {}, error() {} };

describe("a 404 is only 'gone' when the app's list agrees", () => {
  it("a wrong URL: deprovisioning retries instead of looking done, and the link stays active", async () => {
    const h = await createHost();
    const u = await h.user();
    const wrong = outbox({ targets: [{ id: "app", url: `${h.app.url}/wrong`, token: h.app.token, fetch: h.app.fetch }] }, h.ctx.adapter as unknown as Adapter, log);
    h.db.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?').run(u.id);
    await wrong.enqueue("app", u.id);
    expect(await wrong.runFor("app", u.id)).toBe("retry");
    expect(await h.links()).toEqual([expect.objectContaining({ active: true })]);
    expect(await h.jobs()).toEqual([expect.objectContaining({ failed: false, lastError: expect.stringContaining("check the target's url") })]);
    expect([...h.app.users.values()][0]).toMatchObject({ active: true });
  });

  it("a wrong URL: an update retries, and keeps the link", async () => {
    const h = await createHost();
    const u = await h.user("Ada Lovelace");
    const remoteId = (await h.links())[0]!.remoteId;
    const wrong = outbox({ targets: [{ id: "app", url: `${h.app.url}/wrong`, token: h.app.token, fetch: h.app.fetch }] }, h.ctx.adapter as unknown as Adapter, log);
    h.db.prepare('UPDATE "user" SET "name" = ? WHERE "id" = ?').run("Ada King", u.id);
    await wrong.enqueue("app", u.id);
    expect(await wrong.runFor("app", u.id)).toBe("retry");
    expect(await h.links()).toEqual([expect.objectContaining({ remoteId, active: true })]);
  });

  it("really removed at the app: deprovisioning is done, as before", async () => {
    const h = await createHost();
    const u = await h.user();
    h.app.users.clear();
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(await h.links()).toEqual([expect.objectContaining({ active: false })]);
    expect(await h.jobs()).toEqual([]);
  });

  it("delete mode, really removed at the app: done", async () => {
    const h = await createHost({ targets: [{ id: "app", deprovision: "delete" }] });
    const u = await h.user();
    h.app.users.clear();
    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect(await h.links()).toEqual([]);
    expect(await h.jobs()).toEqual([]);
  });

  it("recreated at the app under another id: the update follows it", async () => {
    const h = await createHost();
    const u = await h.user("Ada Lovelace");
    const old = [...h.app.users.values()][0]!;
    h.app.users.delete(old.id);
    h.app.users.set("moved", { ...old, id: "moved" });
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada King" });
    await h.settle();
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ id: "moved", displayName: "Ada King" })]);
    expect(await h.links()).toEqual([expect.objectContaining({ remoteId: "moved" })]);
  });

  it("a page that isn't a SCIM list is never read as 'no such user'", async () => {
    const client = scimClient({ url: "https://scim.example/v2", token: "t", fetch: async () => new Response("<html>login</html>", { status: 200 }) });
    await expect(client.findByUserName("a@example.com")).rejects.toMatchObject({ retryable: true, message: expect.stringContaining("check the target's url") });
  });
});
