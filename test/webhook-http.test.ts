// Webhooks over real HTTP: a receiver server on this machine, written exactly as the README shows
// (a fetch-style `POST(request)` that verifies the raw body), and the plugin posting to it with the
// global fetch. The other webhook tests use an in-memory receiver; this one proves the bytes on the
// wire: the body that's signed is the body that arrives, headers included.
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin, organization } from "better-auth/plugins";
import { afterAll, beforeAll, expect, it } from "vitest";
import { scimProvisioning, verifyWebhookSignature, type WebhookEvent } from "../src";

const SECRET = "receiver-secret-that-is-at-least-32-characters";

// The receiver, as in the README.
const events: WebhookEvent[] = [];
const users = new Map<string, { userName: string; active: boolean; displayName?: string | undefined }>();
const groups = new Map<string, string[]>();
async function POST(request: Request) {
  const body = await request.text();
  const event = await verifyWebhookSignature({ body, signature: request.headers.get("x-scim-provisioning-signature"), secret: SECRET });
  events.push(event);
  if (event.type === "user.upsert") users.set(event.user.externalId, { userName: event.user.userName, active: event.user.active, displayName: event.user.displayName });
  if (event.type === "user.deactivate") users.set(event.user.externalId, { ...users.get(event.user.externalId)!, active: false });
  if (event.type === "group.upsert") groups.set(event.group.externalId, event.group.members.map((m) => m.value).sort());
  if (event.type === "group.delete") groups.delete(event.group.externalId);
  return new Response(null, { status: 204 });
}

let server: Server;
let url = "";
const rejected: string[] = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    try {
      const out = await POST(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: Buffer.concat(chunks) }));
      res.writeHead(out.status).end();
    } catch (e) {
      rejected.push((e as Error).message);
      res.writeHead(401).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  url = `http://localhost:${typeof address === "object" && address ? address.port : 0}/hooks/provisioning`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

it("a user's life and an organization's group reach a real HTTP receiver, every request verified", async () => {
  const pending = new Set<Promise<unknown>>();
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "http-test-secret-that-is-at-least-32-characters",
    telemetry: { enabled: false },
    database: new DatabaseSync(":memory:"),
    emailAndPassword: { enabled: true },
    advanced: {
      backgroundTasks: {
        handler: (p: Promise<unknown>) => {
          const tracked = p.finally(() => pending.delete(tracked));
          pending.add(tracked);
        },
      },
    },
    plugins: [admin(), organization(), scimProvisioning({ targets: [{ id: "my-app", type: "webhook", url, secret: SECRET, groups: true }] })],
  });
  const ctx = await auth.$context;
  await (await getMigrations(ctx.options)).runMigrations();
  const settle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };

  // A user, with a name that needs escaping on the wire.
  const signUp = await auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive \"O'Neil\" Øwner 🌍" } });
  await ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
  await settle();
  expect(users.get(signUp.user.id)).toEqual({ userName: "owner@example.com", active: true, displayName: "Olive \"O'Neil\" Øwner 🌍" });

  // An organization and a second member: the group lists both.
  const res = await auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
  const headers = { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  const org = await auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers });
  const ada = await ctx.internalAdapter.createUser({ email: "ada@example.com", name: "Ada Lovelace", emailVerified: true }, { method: "admin" });
  await auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "member" } });
  await settle();
  expect(groups.get(org!.id)).toEqual([signUp.user.id, ada.id].sort());

  // Banned: deactivated, and out of the group.
  await ctx.internalAdapter.updateUser(ada.id, { banned: true });
  await settle();
  expect(users.get(ada.id)?.active).toBe(false);
  expect(groups.get(org!.id)).toEqual([signUp.user.id]);

  // The organization deleted: its group goes.
  await auth.api.deleteOrganization({ body: { organizationId: org!.id }, headers });
  await settle();
  expect(groups.has(org!.id)).toBe(false);

  expect(rejected).toEqual([]);
  expect(await ctx.adapter.findMany({ model: "scimProvisioningJob" })).toEqual([]);
  expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["user.upsert", "group.upsert", "user.deactivate", "group.delete"]));
});

it("a request with the wrong secret is refused by the receiver, and the job is retried, not lost", async () => {
  const pending = new Set<Promise<unknown>>();
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "http-test-secret-that-is-at-least-32-characters",
    telemetry: { enabled: false },
    database: new DatabaseSync(":memory:"),
    emailAndPassword: { enabled: true },
    advanced: {
      backgroundTasks: {
        handler: (p: Promise<unknown>) => {
          const tracked = p.finally(() => pending.delete(tracked));
          pending.add(tracked);
        },
      },
    },
    plugins: [admin(), scimProvisioning({ targets: [{ id: "my-app", type: "webhook", url, secret: "a-different-secret-that-is-at-least-32-chars" }], retry: { baseDelayMs: 60_000 } })],
  });
  const ctx = await auth.$context;
  await (await getMigrations(ctx.options)).runMigrations();
  const before = rejected.length;
  const u = await ctx.internalAdapter.createUser({ email: "eve@example.com", name: "Eve", emailVerified: true }, { method: "admin" });
  while (pending.size) await Promise.allSettled([...pending]);
  expect(rejected.slice(before)).toEqual([expect.stringContaining("doesn't match")]);
  expect(users.has(u.id)).toBe(false);
  expect(await ctx.adapter.findMany({ model: "scimProvisioningJob" })).toEqual([expect.objectContaining({ failed: false, lastStatus: 401, lastError: expect.stringContaining("check the target's secret") })]);
});
