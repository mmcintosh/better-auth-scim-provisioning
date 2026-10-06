// Smaller findings of the third review:
// F5: onFailure said "failed" for a delivery that was going out again at once, and could hang the
//     worker; F6: a group's hold lasted 10 minutes or more though it's renewed while it runs;
// F7: webhook URLs couldn't have a query string (Azure Functions' ?code=); F9: the CLI ignored
//     --url=…, ignored unknown flags, and failed apps that work with update: "patch";
// F10: a webhook event id could be reused for different content.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { scimProvisioning } from "../../src";
import { createHost } from "../support/host";

describe("F5: onFailure", () => {
  it("isn't told about a delivery that's going out again at once (bumped during it)", async () => {
    const seen: unknown[] = [];
    const h = await createHost({ retry: { maxAttempts: 1, baseDelayMs: 0 }, onFailure: (f) => void seen.push(f) });
    const ada = await h.user("Ada Lovelace");
    const release = h.app.hold();
    await h.ctx.internalAdapter.updateUser(ada.id, { name: "Ada King" }); // delivery starts, held
    await new Promise((r) => setTimeout(r, 50));
    await h.ctx.internalAdapter.updateUser(ada.id, { name: "Ada Byron" }); // bumped meanwhile
    h.app.failOn("PUT", /^\/Users\//, { status: 400, detail: "refused once" });
    release();
    await h.settle();
    expect(seen).toEqual([]); // the bumped version went out and succeeded
    expect([...h.app.users.values()][0]?.displayName).toBe("Ada Byron");
  });

  it("a hook that never answers doesn't hold the delivery for ever", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const h = await createHost({ retry: { maxAttempts: 1, baseDelayMs: 0 }, onFailure: () => new Promise(() => {}) });
      const error = vi.spyOn(h.ctx.logger, "error");
      h.app.fail({ status: 400 });
      const pending = h.user("Ada Lovelace");
      await vi.advanceTimersByTimeAsync(6_000);
      await pending;
      expect(error).toHaveBeenCalledWith(expect.stringContaining("onFailure threw: no answer within 5 s"));
    } finally {
      vi.useRealTimers();
    }
  });
});

it("F6: a group delivery holds its job for about a minute, not ten (its hold is renewed while it runs)", async () => {
  const h = await createHost({ targets: [{ id: "app", groups: true }] });
  const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
  await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await h.settle();
  const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  const release = h.app.hold();
  await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } });
  await new Promise((r) => setTimeout(r, 100));
  const job = ((await h.jobs()) as { key: string; lockedUntil: Date | string }[]).find((j) => j.key.includes(":group:"));
  expect(new Date(job!.lockedUntil).getTime() - Date.now()).toBeLessThan(65_000);
  release();
  await h.settle();
});

describe("F7: webhook URLs", () => {
  it("may have a query string, which reaches the receiver; SCIM URLs still may not", async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      urls.push(String(input));
      return new Response(null, { status: 204 });
    };
    const make = (target: Record<string, unknown>) => () => scimProvisioning({ targets: [target] as never });
    expect(make({ id: "hook", type: "webhook", url: "https://fn.example.net/api/scim?code=abc", secret: "s".repeat(32), fetch })).not.toThrow();
    expect(make({ id: "app", url: "https://app.example.com/scim/v2?x=1", token: "t" })).toThrow(/query/);
    const { webhookClient } = await import("../../src/webhook");
    await webhookClient({ id: "hook", type: "webhook", url: "https://fn.example.net/api/scim?code=abc", secret: "s".repeat(32), fetch }).remove("u1");
    expect(urls).toEqual(["https://fn.example.net/api/scim?code=abc"]);
  });
});

describe("F9: the CLI", () => {
  /** A SCIM app on localhost; `put: false` answers PUT with 405, as some apps do. */
  async function app(o: { put: boolean }) {
    const users = new Map<string, Record<string, unknown>>();
    let n = 0;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : undefined;
      const url = new URL(req.url ?? "/", "http://localhost");
      const send = (status: number, json?: unknown) => {
        res.writeHead(status, { "content-type": "application/scim+json" });
        res.end(json === undefined ? "" : JSON.stringify(json));
      };
      const path = url.pathname.replace(/^\/scim\/v2/, "");
      if (path === "/Users" && req.method === "GET") {
        const m = /^userName eq "(.*)"$/.exec(url.searchParams.get("filter") ?? "");
        const found = [...users.values()].filter((u) => !m || String(u.userName).toLowerCase() === String(m[1]).toLowerCase());
        return send(200, { totalResults: found.length, Resources: found });
      }
      if (path === "/Users" && req.method === "POST") {
        if ([...users.values()].some((u) => String(u.userName).toLowerCase() === String(body.userName).toLowerCase())) return send(409, { detail: "taken" });
        const u = { ...body, id: `u${++n}` };
        users.set(u.id, u);
        return send(201, u);
      }
      const id = path.replace(/^\/Users\//, "");
      const u = users.get(id);
      if (!u) return send(404, { detail: "not found" });
      if (req.method === "GET") return send(200, u);
      if (req.method === "PUT") {
        if (!o.put) return send(405, { detail: "PUT not supported" });
        users.set(id, { ...body, id });
        return send(200, users.get(id));
      }
      if (req.method === "PATCH") {
        for (const op of body.Operations ?? []) Object.assign(u, op.path ? { [op.path]: op.value } : op.value);
        return send(200, u);
      }
      if (req.method === "DELETE") {
        users.delete(id);
        return send(204);
      }
      return send(405);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://localhost:${(server.address() as { port: number }).port}/scim/v2`, close: () => server.close() };
  }

  it("takes --url=…, refuses unknown flags, and passes an app that only takes PATCH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scim-cli-"));
    await build({ entryPoints: ["src/cli.ts"], bundle: true, platform: "node", format: "esm", outfile: join(dir, "cli.mjs"), logLevel: "silent" });
    const run = (...args: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) =>
        execFile(process.execPath, [join(dir, "cli.mjs"), ...args], { env: { ...process.env, SCIM_TOKEN: "t" } }, (e, stdout, stderr) => resolve({ code: e ? (e.code as number) : 0, out: `${stdout}${stderr}` })),
      );
    const patchOnly = await app({ put: false });
    try {
      expect((await run("check", "--token", "x")).out).toMatch(/Unknown or malformed argument: --token/);
      const r = await run("check", `--url=${patchOnly.url}`);
      expect(r.out).toMatch(/✗ update with PUT/);
      expect(r.code).toBe(0); // usable with update: "patch"
    } finally {
      patchOnly.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("F10: a webhook retry whose content changed (a write that bypassed the hooks) gets a new id", async () => {
  const h = await createHost({ targets: [{ id: "hook", type: "webhook" }], retry: { baseDelayMs: 0 } });
  h.webhook.fail(503);
  const ada = await h.user("Ada Lovelace");
  // Renamed straight in the database: no new change, so the same job version is retried.
  await h.ctx.adapter.update({ model: "user", where: [{ field: "id", value: ada.id }], update: { name: "Ada King" } });
  await h.auth.api.scimProvisioningRun({ body: {} });
  await h.settle();
  const [first, retried] = h.webhook.attempts;
  expect(retried).toBeDefined();
  expect(retried).not.toBe(first);
});
