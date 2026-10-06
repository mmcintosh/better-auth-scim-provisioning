// The Workers example (examples/workers) inside workerd: bundled as Wrangler would bundle it, with
// D1, its migrations, waitUntil and the Cron Trigger, run by Miniflare. Its outbound
// requests go to the mock SCIM app and webhook receiver. Everything is driven over HTTP, as a
// browser and the Cron Trigger would.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getMigrations } from "better-auth/db/migration";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth, type Env } from "../../examples/workers/src/auth";
import { mockScim } from "../support/mock-scim";
import { mockWebhook } from "../support/mock-webhook";

const example = (path: string) => fileURLToPath(new URL(`../../examples/workers/${path}`, import.meta.url));
const MIGRATIONS = example("migrations");
// Local development, where the dev mailbox may answer (it never does on any other host).
const ORIGIN = "http://localhost:8787";
const app = mockScim();
const hook = mockWebhook();
const env = {
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "example-test-secret-that-is-at-least-32-characters",
  SCIM_URL: app.url,
  SCIM_TOKEN: "test-token",
  WEBHOOK_URL: "https://hooks.example.com/scim",
  WEBHOOK_SECRET: "webhook-secret-that-is-at-least-32-characters-long",
  ADMIN_EMAILS: "admin@example.test",
  DEV_MAILBOX: "true",
};

/** The example's migrations, in order, as statements (D1 runs one statement per prepare). */
const statements = () =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split(/;\s*$/m))
    .map((sql) => sql.replace(/^--.*$/gm, "").trim())
    .filter(Boolean);

/** What Better Auth's migrator would still do after the example's migrations: nothing, if they're current. */
async function missingSql() {
  const db = new DatabaseSync(":memory:");
  for (const sql of statements()) db.exec(sql);
  const options = createAuth({ ...env, DB: undefined as never } as Env, { database: db }).options;
  // Nothing to do compiles to a lone ";".
  return (await (await getMigrations(options)).compileMigrations()).replace(/^\s*;\s*$/, "").trim();
}

let mf: Miniflare;
const call = (path: string, init: RequestInit = {}) => mf.dispatchFetch(`${ORIGIN}${path}`, { redirect: "manual", ...init, headers: { origin: ORIGIN, ...init.headers } } as never) as unknown as Promise<Response>;
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";", 1)[0]).join("; ");
const until = async (what: () => boolean) => {
  for (let i = 0; i < 100 && !what(); i++) await new Promise((r) => setTimeout(r, 50));
  return what();
};

/** Sign up, open the verification link from the dev mailbox, and return the session cookie. */
async function verifiedUser(email: string, name: string) {
  const up = await call("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "correct-horse-battery", name }) });
  expect(up.status, await up.clone().text()).toBe(200);
  const { link } = (await (await call(`/dev/mailbox?email=${encodeURIComponent(email)}`)).json()) as { link: string };
  const verified = await call(new URL(link).pathname + new URL(link).search);
  expect([200, 302]).toContain(verified.status);
  return cookieOf(verified);
}

beforeAll(async () => {
  expect(await missingSql(), "examples/workers/migrations/ are behind the plugin's schema: add a migration with the SQL shown").toBe("");

  // Bundled for workerd as Wrangler does it; the package itself from this repository's source.
  const bundle = await build({
    entryPoints: [example("src/index.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    alias: { "better-auth-scim-provisioning": fileURLToPath(new URL("../../src/index.ts", import.meta.url)) },
    logLevel: "silent",
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      bindings: env,
      // The Worker's outbound requests: the SCIM app and the webhook receiver, nothing else.
      outboundService: async (request: Request) => {
        const init = { method: request.method, headers: Object.fromEntries(request.headers), ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.text() }) };
        if (request.url.startsWith(app.url)) return app.fetch(request.url, init);
        if (request.url === env.WEBHOOK_URL) return hook.fetch(request.url, init);
        return new Response("no such host in this test", { status: 502 });
      },
    } as never),
  );
  const db = await mf.getD1Database("DB");
  for (const statement of statements()) await db.prepare(statement).run();
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("the Workers example's dev mailbox", () => {
  it("is off in the shipped wrangler.jsonc, which deploys use too", () => {
    const config = JSON.parse(readFileSync(example("wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "")) as { vars?: Record<string, string> };
    expect(config.vars?.DEV_MAILBOX).not.toBe("true");
  });

  it("a first request the Worker doesn't serve leaves it working (Better Auth is set up in the request that creates it)", async () => {
    // Runs before any other request: an unknown path, then the mailbox on a deployed host.
    expect((await call("/no-such-page")).status).toBe(404);
    expect((await mf.dispatchFetch("https://scim-example.example.workers.dev/dev/mailbox?email=x%40example.test") as unknown as Response).status).toBe(404);
  });
});

describe("the Workers example", () => {
  let admin = "";
  let ada = "";

  it("a verified user is provisioned right after the response (waitUntil), to the SCIM app and the webhook", async () => {
    const up = await call("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "early@example.test", password: "correct-horse-battery", name: "Not Verified" }) });
    expect(up.status).toBe(200);
    ada = await verifiedUser("ada@example.test", "Ada Lovelace");
    expect(await until(() => [...app.users.values()].some((u) => u.userName === "ada@example.test"))).toBe(true);
    expect([...app.users.values()].map((u) => u.userName)).not.toContain("early@example.test");
    expect(await until(() => hook.events.some((e) => e.type === "user.upsert"))).toBe(true);
  });

  it("the dev mailbox answers only on localhost, even when switched on", async () => {
    // Ada's verification link exists (the test above used it): served locally, never elsewhere.
    const deployed = (await mf.dispatchFetch("https://scim-example.example.workers.dev/dev/mailbox?email=ada%40example.test")) as unknown as Response;
    expect(deployed.status).toBe(404);
    expect((await call("/dev/mailbox?email=ada%40example.test")).status).toBe(200);
  });

  it("only admins reach /admin/*, and only they may create organizations", async () => {
    expect((await call("/admin/status", { headers: { cookie: ada } })).status).toBe(403);
    const refused = await call("/api/auth/organization/create", { method: "POST", headers: { cookie: ada, "content-type": "application/json" }, body: JSON.stringify({ name: "Administrators", slug: "administrators" }) });
    expect(refused.status).toBe(403);

    admin = await verifiedUser("admin@example.test", "Grace Hopper");
    const status = await call("/admin/status", { headers: { cookie: admin } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ targets: [expect.objectContaining({ id: "app", failed: 0 }), expect.objectContaining({ id: "hook", failed: 0 })] });
  });

  it("an organization is a group at the app, with its provisioned members", async () => {
    const org = await call("/api/auth/organization/create", { method: "POST", headers: { cookie: admin, "content-type": "application/json" }, body: JSON.stringify({ name: "Acme", slug: "acme" }) });
    expect(org.status, await org.clone().text()).toBe(200);
    expect(await until(() => [...app.groups.values()].some((g) => g.displayName === "Acme" && g.members.length === 1))).toBe(true);
    expect(await until(() => hook.events.some((e) => e.type === "group.upsert"))).toBe(true);
  });

  it("a failed delivery is retried by the Cron Trigger", async () => {
    app.fail({ status: 503 });
    const renamed = await call("/api/auth/update-user", { method: "POST", headers: { cookie: ada, "content-type": "application/json" }, body: JSON.stringify({ name: "Ada King" }) });
    expect(renamed.status).toBe(200);
    const user = () => [...app.users.values()].find((u) => u.userName === "ada@example.test");
    await new Promise((r) => setTimeout(r, 300));
    expect(user()?.displayName).toBe("Ada Lovelace");

    // The retry waits its backoff (30 seconds first); make it due now, in the stored date format.
    const db = await mf.getD1Database("DB");
    const job = await db.prepare('SELECT "nextAttemptAt" FROM "scimProvisioningJob" WHERE "failed" = 0').first<{ nextAttemptAt: string | number }>();
    expect(job).toBeTruthy();
    const past = new Date(Date.now() - 1000);
    await db.prepare('UPDATE "scimProvisioningJob" SET "nextAttemptAt" = ?').bind(typeof job!.nextAttemptAt === "number" ? past.getTime() : past.toISOString()).run();
    const worker = (await mf.getWorker()) as unknown as { scheduled(o: { cron: string }): Promise<unknown> };
    await worker.scheduled({ cron: "*/5 * * * *" });
    expect(await until(() => user()?.displayName === "Ada King")).toBe(true);
  });

  it("a deleted account is deactivated at the app", async () => {
    const del = await call("/api/auth/delete-user", { method: "POST", headers: { cookie: ada, "content-type": "application/json" }, body: JSON.stringify({ password: "correct-horse-battery" }) });
    expect(del.status, await del.clone().text()).toBe(200);
    expect(await until(() => [...app.users.values()].find((u) => u.userName === "ada@example.test")?.active === false)).toBe(true);
  });

  it("an admin can reconcile and run on demand", async () => {
    const reconciled = await call("/admin/reconcile", { method: "POST", headers: { cookie: admin } });
    expect(reconciled.status).toBe(200);
    expect(((await reconciled.json()) as { queued: number }).queued).toBeGreaterThan(0);
    const ran = await call("/admin/run", { method: "POST", headers: { cookie: admin } });
    expect(ran.status).toBe(200);
    const { targets } = (await (await call("/admin/status", { headers: { cookie: admin } })).json()) as { targets: { queued: number; stuck: number; failed: number }[] };
    expect(targets.every((t) => t.queued === 0 && t.stuck === 0 && t.failed === 0)).toBe(true);
  });
});
