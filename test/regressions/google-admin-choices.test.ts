// Google: orgUnitPath was sent on every update, moving users an admin had placed elsewhere; and
// adopting a suspended account made by hand unsuspended it. orgUnitPath is now for new users only,
// and a suspended account is left for an admin to decide.
import { expect, it } from "vitest";
import { type Adapter, outbox } from "../../src/outbox";
import { createHost } from "../support/host";

const quiet = { warn() {}, error() {} };

it("orgUnitPath places new users and never moves an existing one", async () => {
  const h = await createHost({ targets: [{ id: "workspace", type: "google-workspace" }] });
  const u = await h.user("Ada Lovelace");
  const g = [...h.google.users.values()][0]!;
  g.orgUnitPath = "/Executives";
  const google = { clientEmail: h.google.clientEmail, privateKey: h.google.privateKey, adminEmail: h.google.admin, tokenUrl: h.google.tokenUrl, orgUnitPath: "/Provisioned" };
  const box = outbox({ targets: [{ id: "workspace", type: "google-workspace", url: h.google.url, google, fetch: h.google.fetch }] }, h.ctx.adapter as unknown as Adapter, quiet);
  h.db.prepare('UPDATE "user" SET "name" = ? WHERE "id" = ?').run("Ada Byron", u.id);
  await box.enqueue("workspace", u.id);
  await box.runFor("workspace", u.id);
  expect(g.orgUnitPath).toBe("/Executives");
});

it("a suspended Workspace account made by hand is not taken over, even with adopt: true", async () => {
  const h = await createHost({ targets: [{ id: "workspace", type: "google-workspace", adopt: true }] });
  h.google.users.set("hand", { id: "hand", primaryEmail: "user1@example.com", name: { givenName: "Ex", familyName: "Employee" }, suspended: true });
  const u = await h.user("Ex Employee");
  expect(h.google.users.get("hand")!.suspended).toBe(true);
  expect(await h.jobs()).toEqual([expect.objectContaining({ userId: u.id, failed: true, lastError: expect.stringContaining("suspended") })]);
});

it("Google's 409 for an account it can't show yet is retried, not refused", async () => {
  // The account exists (another target made it); Google's lookup lags behind once.
  const h = await createHost({ targets: [{ id: "other" }, { id: "first", type: "google-workspace" }] });
  const u = await h.user("Ada Lovelace");
  let lagging = true;
  const f: typeof fetch = async (i, init) => {
    const url = String(i instanceof Request ? i.url : i);
    if (lagging && (init?.method ?? "GET") === "GET" && url.includes("/users/")) {
      return new Response(JSON.stringify({ error: { code: 404, message: "Resource Not Found: userKey" } }), { status: 404 });
    }
    return h.google.fetch(i, init);
  };
  const google = { clientEmail: h.google.clientEmail, privateKey: h.google.privateKey, adminEmail: h.google.admin, tokenUrl: h.google.tokenUrl };
  const box = outbox({ targets: [{ id: "workspace", type: "google-workspace", url: h.google.url, google, fetch: f }], retry: { baseDelayMs: 0 } }, h.ctx.adapter as unknown as Adapter, quiet);
  await box.enqueue("workspace", u.id);
  expect(await box.runFor("workspace", u.id)).toBe("retry");
  lagging = false;
  expect(await box.runFor("workspace", u.id)).toBe("done");
  expect([...h.google.users.values()]).toEqual([expect.objectContaining({ primaryEmail: "user1@example.com" })]);
});
