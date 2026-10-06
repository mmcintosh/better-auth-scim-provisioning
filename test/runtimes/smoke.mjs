// Runtime smoke test: the built package (dist/, what users install) on the runtime running this
// file. Plain JavaScript, no test framework, so every runtime runs it as-is: `node`, `bun` and
// `deno run -A` on test/runtimes/smoke.mjs, after `pnpm build`.
//
// A small SCIM app and a webhook receiver run in this process over real HTTP (node:http, which
// Bun and Deno provide too). Against them: the package's `check` CLI, run by this same runtime;
// then Better Auth with scimProvisioning on the memory adapter, a user's life (create, rename,
// delete) delivered to the SCIM app and, signed, to the webhook. Exits non-zero on the first failure.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { scimProvisioning, verifyWebhookSignature } from "../../dist/index.js";

const runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : typeof Deno !== "undefined" ? `deno ${Deno.version.deno}` : `node ${process.version}`;
const check = (ok, what) => {
  if (!ok) throw new Error(`[${runtime}] ${what}`);
  console.log(`ok  ${what}`);
};
const TOKEN = "smoke-token";
const HOOK_SECRET = "smoke-webhook-secret-at-least-32-characters";

// The SCIM app: just enough of /Users for the CLI's check and the plugin's deliveries.
const users = new Map();
const hookEvents = [];
let hookBadSignatures = 0;
let seq = 0;
const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/scim+json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/hook") {
    try {
      hookEvents.push(await verifyWebhookSignature({ body: raw, signature: req.headers["x-scim-provisioning-signature"], secret: HOOK_SECRET }));
      return send(res, 204);
    } catch {
      hookBadSignatures++;
      return send(res, 401, { detail: "bad signature" });
    }
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { detail: "unauthorized" });
  const body = raw ? JSON.parse(raw) : undefined;
  const path = url.pathname.replace(/^\/scim\/v2/, "");
  if (path === "/ServiceProviderConfig") return send(res, 200, { patch: { supported: true }, filter: { supported: true }, authenticationSchemes: [{ type: "oauthbearertoken" }] });
  if (path === "/Users" && req.method === "GET") {
    const m = /^userName eq "(.*)"$/.exec(url.searchParams.get("filter") ?? "");
    const found = m ? [...users.values()].filter((u) => u.userName.toLowerCase() === m[1].toLowerCase()) : [...users.values()];
    return send(res, 200, { totalResults: found.length, Resources: found });
  }
  if (path === "/Users" && req.method === "POST") {
    if ([...users.values()].some((u) => u.userName.toLowerCase() === body.userName.toLowerCase())) return send(res, 409, { detail: "userName taken" });
    const user = { ...body, id: `u${++seq}` };
    users.set(user.id, user);
    return send(res, 201, user);
  }
  const id = decodeURIComponent(path.replace(/^\/Users\//, ""));
  const user = users.get(id);
  if (!user) return send(res, 404, { detail: "not found" });
  if (req.method === "GET") return send(res, 200, user);
  if (req.method === "PUT") {
    users.set(id, { ...body, id });
    return send(res, 200, users.get(id));
  }
  if (req.method === "PATCH") {
    for (const op of body.Operations ?? []) Object.assign(user, op.path ? { [op.path]: op.value } : op.value);
    return send(res, 200, user);
  }
  if (req.method === "DELETE") {
    users.delete(id);
    return send(res, 204);
  }
  return send(res, 405, { detail: "method not allowed" });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://localhost:${server.address().port}`;

try {
  // 1. The CLI, run by this runtime, while this process keeps serving.
  const cli = await new Promise((resolve) =>
    execFile(process.execPath, [...(typeof Deno !== "undefined" ? ["run", "-A"] : []), "dist/cli.js", "check", "--url", `${base}/scim/v2`], { env: { ...process.env, SCIM_TOKEN: TOKEN } }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, out: `${stdout}${stderr}` })),
  );
  check(cli.code === 0, `CLI check passes against a SCIM app${cli.code === 0 ? "" : `\n${cli.out}`}`);
  check(users.size === 0, "CLI check removes its test user");

  // 2. Better Auth with the plugin: a SCIM target and a signed webhook.
  const db = { user: [], session: [], account: [], verification: [], scimProvisioningJob: [], scimProvisioningLink: [], scimProvisioningGroupLink: [] };
  const pending = new Set();
  const auth = betterAuth({
    baseURL: "https://app.smoke.test",
    secret: "smoke-secret-that-is-at-least-32-characters-long",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    telemetry: { enabled: false },
    advanced: {
      backgroundTasks: {
        handler: (p) => {
          const tracked = p.finally(() => pending.delete(tracked));
          pending.add(tracked);
        },
      },
    },
    plugins: [
      scimProvisioning({
        targets: [
          { id: "app", type: "scim", url: `${base}/scim/v2`, token: TOKEN },
          { id: "hook", type: "webhook", url: `${base}/hook`, secret: HOOK_SECRET },
        ],
      }),
    ],
  });
  const ctx = await auth.$context;
  const settle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
  const atApp = () => [...users.values()];

  const created = await ctx.internalAdapter.createUser({ email: "ada@smoke.test", name: "Ada Lovelace", emailVerified: true }, { method: "admin" });
  await settle();
  check(atApp().length === 1 && atApp()[0].userName === "ada@smoke.test" && atApp()[0].externalId === created.id && atApp()[0].active === true, "a new user is created at the SCIM app");

  await ctx.internalAdapter.updateUser(created.id, { name: "Ada King" });
  await settle();
  check(atApp()[0].displayName === "Ada King", "a rename reaches the SCIM app");

  await ctx.internalAdapter.deleteUser(created.id);
  await settle();
  check(atApp().length === 1 && atApp()[0].active === false, "a deleted user is deactivated at the SCIM app");

  check(hookBadSignatures === 0 && hookEvents.length >= 3, `signed webhook events verify (${hookEvents.length} received)`);
  check(hookEvents.every((e) => e.user?.externalId === created.id), "webhook events carry the user");
  console.log(`all checks passed on ${runtime}`);
} finally {
  server.close();
}
