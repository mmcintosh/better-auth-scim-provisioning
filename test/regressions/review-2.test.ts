// Found in the second independent review, before 1.0:
// - scimProvisioningQueue didn't take a user out of a group they'd left outside the endpoints;
// - there was no way to list which jobs failed, only counts;
// - endpoint bodies dropped unknown keys (a `targetID` typo reconciled every target) and took any
//   cursor (a bogus one "finished" having done nothing);
// - `queued` counted jobs waiting on a backoff or a ban running out;
// - a reconcile caller ignoring `next` silently handled the first page only;
// - the CLI exited 0 for an unknown command.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { createHost } from "../support/host";

type Host = Awaited<ReturnType<typeof createHost>>;

async function signedIn(h: Host, email: string) {
  const signUp = await h.auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email, password: "correct-horse-battery" }, asResponse: true });
  return { headers: { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } };
}

describe("scimProvisioningQueue with organizationId", () => {
  it("a membership removed outside the endpoints: queueing the user and the organization takes them out of its group", async () => {
    const h = await createHost({ targets: [{ id: "app", groups: true }] });
    const owner = await signedIn(h, "o@example.com");
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: owner.headers });
    const bob = await h.user("Bob Builder");
    await h.auth.api.addMember({ body: { userId: bob.id, organizationId: org!.id, role: "member" } });
    await h.settle();
    const members = () => [...h.app.groups.values()].find((x) => x.displayName === "Acme")!.members.map((m) => m.value);
    const bobAtApp = [...h.app.users.values()].find((u) => u.userName === bob.email)!.id;
    expect(members()).toContain(bobAtApp);
    await h.ctx.adapter.deleteMany({ model: "member", where: [{ field: "userId", value: bob.id }] }); // an SSO sync, say
    await h.auth.api.scimProvisioningQueue({ body: { userId: bob.id, organizationId: org!.id } });
    await h.settle();
    expect(members()).not.toContain(bobAtApp);
  });

  it("needs a userId or an organizationId", async () => {
    const h = await createHost();
    await expect(h.auth.api.scimProvisioningQueue({ body: {} as never })).rejects.toThrow();
  });
});

describe("scimProvisioningFailures", () => {
  it("lists the failed and stuck jobs, a page at a time", async () => {
    const h = await createHost({ retry: { maxAttempts: 1, baseDelayMs: 0 } });
    h.app.fail({ status: 400, detail: "refused" }, { status: 503 }, { status: 400, detail: "refused too" });
    const [a, b, c] = [await h.user("Ada Lovelace"), await h.user("Bea Berg"), await h.user("Cy Chen")];
    const first = await h.auth.api.scimProvisioningFailures({ body: { limit: 2 } });
    expect(first.items).toHaveLength(2);
    expect(first.next).toEqual(expect.any(String));
    const second = await h.auth.api.scimProvisioningFailures({ body: { after: first.next!, limit: 2 } });
    expect(second.next).toBeNull();
    const all = [...first.items, ...second.items];
    expect(all.map((i) => i.subjectId).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(all.find((i) => i.subjectId === b.id)).toMatchObject({ targetId: "app", kind: "user", failed: false, lastStatus: 503 });
    expect(all.find((i) => i.subjectId === a.id)).toMatchObject({ failed: true, lastStatus: 400, lastError: expect.stringContaining("refused") });
  });
});

describe("endpoint bodies are strict", () => {
  it("an unknown key is refused instead of ignored", async () => {
    const h = await createHost({ targets: [{ id: "a" }, { id: "b" }] });
    await expect(h.auth.api.scimProvisioningReconcile({ body: { targetID: "a" } as never })).rejects.toThrow();
    await expect(h.auth.api.scimProvisioningRun({ body: { limits: 10 } as never })).rejects.toThrow();
  });

  it("a cursor reconcile didn't hand out is refused", async () => {
    const h = await createHost();
    await expect(h.auth.api.scimProvisioningReconcile({ body: { after: "x" } })).rejects.toThrow(/cursor/);
  });
});

describe("status", () => {
  it("queued is what's due; waiting is a backoff or a ban running out", async () => {
    const h = await createHost();
    const ada = await h.user("Ada Lovelace");
    await h.ctx.internalAdapter.updateUser(ada.id, { banned: true, banExpires: new Date(Date.now() + 86_400_000) });
    await h.settle();
    h.app.fail({ status: 503 });
    await h.user("Bea Berg");
    const { targets } = await h.auth.api.scimProvisioningStatus({ body: {} });
    expect(targets).toEqual([expect.objectContaining({ queued: 0, waiting: 2, stuck: 0, failed: 0 })]);
  });
});

describe("upgrading from 0.3", () => {
  it("a reconcile from the start that doesn't finish says so in the log", async () => {
    const h = await createHost();
    const warn = vi.spyOn(h.ctx.logger, "warn");
    const insert = h.db.prepare('INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)');
    h.db.exec("BEGIN");
    for (let i = 0; i < 501; i++) insert.run(`u${String(i).padStart(3, "0")}`, `Person ${i}`, `p${i}@example.com`, Date.now(), Date.now());
    h.db.exec("COMMIT");
    // As a 0.3 caller does it: no limit, no cursor, next ignored.
    await h.auth.api.scimProvisioningReconcile({ body: {} });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("after: next"));
    // A caller that pages (a limit) isn't warned.
    warn.mockClear();
    await h.auth.api.scimProvisioningReconcile({ body: { limit: 2 } });
    expect(warn).not.toHaveBeenCalled();
  });
});

it("the CLI exits 1 for an unknown command, 0 for help", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scim-cli-"));
  await build({ entryPoints: ["src/cli.ts"], bundle: true, platform: "node", format: "esm", outfile: join(dir, "cli.mjs"), logLevel: "silent" });
  const run = (...args: string[]) => new Promise<number>((resolve) => execFile(process.execPath, [join(dir, "cli.mjs"), ...args], (e) => resolve(e ? (e.code as number) : 0)));
  expect(await run("chek")).toBe(1);
  expect(await run("help")).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});
