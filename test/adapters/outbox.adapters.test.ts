// The outbox on real databases (CI's `adapters` job): its leases, version checks, date
// comparisons and booleans are exactly what differs between databases, so SQLite passing isn't
// enough. ADAPTER_DB is postgres, mysql or mongodb (Kysely and MongoDB adapters), drizzle-postgres,
// drizzle-mysql or prisma-postgres (the same servers through an ORM), or d1 (Cloudflare D1, local,
// through Miniflare; no ADAPTER_URL). ADAPTER_URL points at a server where the test may create
// databases. Each test gets a fresh, empty database.
import { afterEach, describe, expect, it } from "vitest";
import { createHost, type HostDatabase, schemaOptions } from "../support/host";

const KIND = process.env.ADAPTER_DB;
const URL_ = process.env.ADAPTER_URL ?? "";
if (process.env.ADAPTER_REQUIRED && (!KIND || (!URL_ && KIND !== "d1"))) throw new Error("ADAPTER_REQUIRED is set, but ADAPTER_DB or ADAPTER_URL is empty");

const fresh = () => `scim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

type Db = HostDatabase & { close(): Promise<void> };

/** Better Auth's own migrator creates the tables on the raw connection, as `npx auth migrate` would. */
async function migrated(raw: Db): Promise<Db> {
  const { getMigrations } = await import("better-auth/db/migration");
  await (await getMigrations(schemaOptions(raw.database) as never)).runMigrations();
  return raw;
}

/** Drizzle over the same server, with a schema built from Better Auth's table definitions. */
async function withDrizzle(raw: Db, provider: "pg" | "mysql"): Promise<Db> {
  await migrated(raw);
  const { drizzleAdapter } = await import("better-auth/adapters/drizzle");
  const schemas = await import("./orm-schemas");
  const db = provider === "pg" ? (await import("drizzle-orm/node-postgres")).drizzle(raw.database as never) : (await import("drizzle-orm/mysql2")).drizzle(raw.database as never);
  const schema = provider === "pg" ? await schemas.drizzlePgSchema(schemaOptions() as never) : await schemas.drizzleMysqlSchema(schemaOptions() as never);
  return { database: drizzleAdapter(db as never, { provider, schema: schema as never }), migrate: false, close: raw.close };
}

/** Prisma 7 over Postgres: a client generated from a schema built from the same definitions. */
async function withPrisma(raw: Db & { url: string }): Promise<Db> {
  await migrated(raw);
  const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  // Inside the project, so the generated client resolves the installed @prisma/client.
  const cache = join(process.cwd(), "node_modules/.cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "scim-prisma-"));
  const { prismaSchema } = await import("./orm-schemas");
  writeFileSync(join(dir, "schema.prisma"), prismaSchema(schemaOptions() as never, join(dir, "client")));
  execFileSync(join(process.cwd(), "node_modules/.bin/prisma"), ["generate", "--schema", join(dir, "schema.prisma")], { stdio: "pipe" });
  // The prisma-client generator writes TypeScript (client.ts), which Vitest loads directly.
  const { PrismaClient } = (await import(pathToFileURL(join(dir, "client/client.ts")).href)) as { PrismaClient: new (o: unknown) => { $disconnect(): Promise<void> } };
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: raw.url }) });
  const { prismaAdapter } = await import("better-auth/adapters/prisma");
  return {
    database: prismaAdapter(prisma as never, { provider: "postgresql" }),
    migrate: false,
    async close() {
      await prisma.$disconnect();
      await raw.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const databases: Record<string, () => Promise<Db>> = {
  async postgres() {
    const { Pool } = await import("pg");
    const name = fresh();
    const admin = new Pool({ connectionString: URL_ });
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(URL_);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.toString(), max: 10 });
    pool.on("error", () => {});
    return {
      database: pool,
      migrate: true,
      url: url.toString(),
      async close() {
        await pool.end();
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.end();
      },
    };
  },
  async mysql() {
    const mysql = await import("mysql2/promise");
    const name = fresh();
    const admin = await mysql.createConnection(URL_);
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(URL_);
    url.pathname = `/${name}`;
    const pool = mysql.createPool({ uri: url.toString(), connectionLimit: 10, timezone: "Z" });
    return {
      database: pool,
      migrate: true,
      async close() {
        await pool.end();
        await admin.query(`DROP DATABASE IF EXISTS ${name}`);
        await admin.end();
      },
    };
  },
  async mongodb() {
    const { MongoClient } = await import("mongodb");
    const { mongodbAdapter } = await import("better-auth/adapters/mongodb");
    const client = new MongoClient(URL_);
    await client.connect();
    const db = client.db(fresh());
    return {
      // No migrations: the adapter creates collections and (UNIQUE) indexes on first use.
      database: mongodbAdapter(db, { client }),
      migrate: false,
      async close() {
        await db.dropDatabase();
        await client.close();
      },
    };
  },
  "drizzle-postgres": async () => withDrizzle(await databases.postgres!(), "pg"),
  "drizzle-mysql": async () => withDrizzle(await databases.mysql!(), "mysql"),
  "prisma-postgres": async () => withPrisma((await databases.postgres!()) as Db & { url: string }),
  // Cloudflare D1, run locally by Miniflare: the SQLite that Workers apps actually use, with D1's
  // limits (at most 100 bound parameters per query, which reconcile's `in` queries once exceeded).
  async d1() {
    const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default { fetch: () => new Response(null) }", d1Databases: ["DB"] }));
    return { database: await mf.getD1Database("DB"), migrate: true, close: () => mf.dispose() };
  },
};

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) await d.close();
});

async function host(o: Parameters<typeof createHost>[0] = {}) {
  const make = databases[KIND as string];
  if (!make) throw new Error(`unknown ADAPTER_DB ${KIND}`);
  const database = await make();
  open.push(database);
  return createHost({ ...o, database });
}

const appUsers = (app: { users: Map<string, unknown> }) => [...app.users.values()] as Record<string, any>[];

describe.skipIf(!KIND || (!URL_ && KIND !== "d1"))(`the outbox on ${KIND}`, () => {
  it("a user's life: create, change, ban, unban, delete", async () => {
    const h = await host();
    const u = await h.user("Ada King Lovelace");
    expect(appUsers(h.app)).toEqual([expect.objectContaining({ externalId: u.id, active: true, name: expect.objectContaining({ familyName: "Lovelace" }) })]);
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada Byron" });
    await h.settle();
    expect(appUsers(h.app)[0]?.displayName).toBe("Ada Byron");
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(appUsers(h.app)[0]?.active).toBe(false);
    await h.ctx.internalAdapter.updateUser(u.id, { banned: false });
    await h.settle();
    expect(appUsers(h.app)[0]?.active).toBe(true);
    await h.ctx.internalAdapter.deleteUser(u.id);
    await h.settle();
    expect(appUsers(h.app)[0]?.active).toBe(false);
    expect(await h.jobs()).toEqual([]);
  });

  it("two workers on one job: exactly one delivers (the lease)", async () => {
    const h = await host({ retry: { baseDelayMs: 0 } });
    h.app.fail({ status: 503 });
    await h.user();
    const runs = await Promise.all([1, 2, 3].map(() => h.auth.api.scimProvisioningRun({ body: {} })));
    expect(runs.reduce((n, r) => n + r.done, 0)).toBe(1);
    expect(h.app.users.size).toBe(1);
    expect(h.app.requests.filter((r) => r.method === "POST")).toHaveLength(2); // the 503, then the one delivery
  });

  it("a change during delivery is delivered too (the version check)", async () => {
    const h = await host();
    const u = await h.user("First Name");
    const release = h.app.hold();
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Second Name" });
    await new Promise((r) => setTimeout(r, 50));
    await h.ctx.internalAdapter.updateUser(u.id, { name: "Third Name" });
    release();
    await h.settle();
    expect(appUsers(h.app)[0]?.displayName).toBe("Third Name");
    expect(await h.jobs()).toEqual([]);
  });

  it("retries wait for their time (dates), and failed jobs stay out of the run (booleans)", async () => {
    const h = await host({ retry: { baseDelayMs: 60_000 } });
    h.app.fail({ status: 503 });
    await h.user();
    expect(await h.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 0, retry: 0 });
    const h2 = await host({ retry: { baseDelayMs: 0 } });
    h2.app.fail({ status: 400 });
    await h2.user();
    expect(await h2.jobs()).toEqual([expect.objectContaining({ failed: true })]);
    expect(await h2.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 0 });
  });

  it("adoption refuses another user's account", async () => {
    const h = await host();
    const a = await h.ctx.internalAdapter.createUser({ email: "same@example.com", name: "First Owner", emailVerified: true }, { method: "admin" });
    await h.settle();
    await h.ctx.internalAdapter.deleteUser(a.id);
    await h.settle();
    const b = await h.ctx.internalAdapter.createUser({ email: "same@example.com", name: "Second Person", emailVerified: true }, { method: "admin" });
    await h.settle();
    expect(appUsers(h.app)).toEqual([expect.objectContaining({ externalId: a.id, active: false })]);
    expect(await h.jobs()).toEqual([expect.objectContaining({ userId: b.id, failed: true })]);
  });

  it("status counts (count with ne, lt and gte)", async () => {
    const h = await host({ retry: { maxAttempts: 1, baseDelayMs: 0 } });
    await h.user("Ada Lovelace");
    h.app.fail({ status: 503 });
    await h.user("Bea Berg");
    const status = await h.auth.api.scimProvisioningStatus({ body: {} });
    expect(status.targets).toEqual([{ id: "app", queued: 0, waiting: 0, stuck: 1, failed: 0, accounts: 1, groups: 0 }]);
  });

  it("failures are listed a page at a time (id order, gt)", async () => {
    const h = await host({ retry: { maxAttempts: 1, baseDelayMs: 0 } });
    h.app.fail({ status: 400 }, { status: 503 }, { status: 400 });
    const ids = [(await h.user("Ada Lovelace")).id, (await h.user("Bea Berg")).id, (await h.user("Cy Chen")).id];
    const first = await h.auth.api.scimProvisioningFailures({ body: { limit: 2 } });
    const second = await h.auth.api.scimProvisioningFailures({ body: { after: first.next!, limit: 2 } });
    expect([...first.items, ...second.items].map((i) => i.subjectId).sort()).toEqual(ids.sort());
    expect(second.next).toBeNull();
  });

  it("reconcile covers existing and deleted users", async () => {
    const h = await host();
    const kept = await h.user("Kept Person");
    const gone = await h.user("Gone Person");
    await h.ctx.adapter.delete({ model: "user", where: [{ field: "id", value: gone.id }] });
    expect(await h.auth.api.scimProvisioningReconcile({ body: {} })).toEqual({ queued: 2, next: null });
    await h.auth.api.scimProvisioningRun({ body: {} });
    expect(appUsers(h.app)).toEqual(
      expect.arrayContaining([expect.objectContaining({ externalId: kept.id, active: true }), expect.objectContaining({ externalId: gone.id, active: false })]),
    );
  });

  it("reconcile with more linked users than one query may bind (D1 allows 100 parameters)", async () => {
    const h = await host();
    // 150 accounts at the app whose users are gone: reconcile looks their links up by user id.
    for (let i = 0; i < 150; i++) {
      await h.ctx.adapter.create({ model: "scimProvisioningLink", data: { key: `app:gone-${i}`, targetId: "app", userId: `gone-${i}`, remoteId: `r${i}`, userName: `gone-${i}@example.com`, active: false, syncedAt: new Date() } });
    }
    expect(await h.auth.api.scimProvisioningReconcile({ body: {} })).toEqual({ queued: 150, next: null });
  });

  it("reconcile in pages (id order, gt and in queries)", async () => {
    const h = await host();
    const users = [await h.user("One Person"), await h.user("Two Person"), await h.user("Three Person")];
    const gone = await h.user("Gone Person");
    await h.ctx.adapter.delete({ model: "user", where: [{ field: "id", value: gone.id }] });
    let queued = 0;
    let next: string | null | undefined;
    do {
      const r = await h.auth.api.scimProvisioningReconcile({ body: { limit: 1, ...(next ? { after: next } : {}) } });
      queued += r.queued;
      next = r.next;
    } while (next);
    expect(queued).toBe(4);
    expect((await h.jobs()).map((j) => j.userId).sort()).toEqual([...users.map((u) => u.id), gone.id].sort());
  });

  it("a lost create reply, then a ban: the pending link finds the account", async () => {
    const h = await host({ retry: { baseDelayMs: 60_000 } });
    h.app.fail({ lostReply: true });
    const u = await h.user();
    expect(await h.links()).toEqual([expect.objectContaining({ userId: u.id, remoteId: "" })]);
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true });
    await h.settle();
    expect(appUsers(h.app)).toEqual([expect.objectContaining({ externalId: u.id, active: false })]);
  });

  it("adoption refuses an account linked to another user, by remoteId", async () => {
    const h = await host({ targets: [{ id: "app", keepsExternalId: false }] });
    const a = await h.ctx.internalAdapter.createUser({ email: "same@example.com", name: "First Owner", emailVerified: true }, { method: "admin" });
    await h.settle();
    await h.ctx.internalAdapter.deleteUser(a.id);
    await h.settle();
    const b = await h.ctx.internalAdapter.createUser({ email: "same@example.com", name: "Second Person", emailVerified: true }, { method: "admin" });
    await h.settle();
    expect(appUsers(h.app)).toEqual([expect.objectContaining({ active: false, displayName: "First Owner" })]);
    expect(await h.jobs()).toEqual([expect.objectContaining({ userId: b.id, failed: true })]);
  });

  it("groups: an organization's group with its members, following a leave (gt, in, kind)", async () => {
    const h = await host({ targets: [{ id: "app", groups: true }] });
    const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
    await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
    const headers = { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers });
    const ada = await h.user("Ada Lovelace");
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: "member" } });
    await h.settle();
    const members = () => [...h.app.groups.values()].map((g) => [g.displayName, g.members.length]);
    expect(members()).toEqual([["Acme", 2]]);
    await h.auth.api.removeMember({ body: { memberIdOrEmail: ada.email, organizationId: org!.id }, headers });
    await h.settle();
    expect(members()).toEqual([["Acme", 1]]);
  });

  it("team and role groups (teamMember, comma-separated roles, group link kind)", async () => {
    const h = await host({ targets: [{ id: "app", teamGroups: true, roleGroups: ["admin"] }] });
    const signUp = await h.auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Olive Owner" } });
    await h.ctx.internalAdapter.updateUser(signUp.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
    const headers = { cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
    const org = await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers });
    const ada = await h.user("Ada Lovelace");
    await h.auth.api.addMember({ body: { userId: ada.id, organizationId: org!.id, role: ["admin", "member"] } });
    const team = await h.auth.api.createTeam({ body: { name: "Red", organizationId: org!.id }, headers });
    await h.auth.api.addTeamMember({ body: { teamId: team.id, userId: ada.id }, headers });
    await h.settle();
    const sizes = () => Object.fromEntries([...h.app.groups.values()].map((g) => [g.displayName, g.members.length]));
    expect(sizes()).toMatchObject({ "Acme / Red": 1, "Acme / admin": 1 });
  });

  it("a timed ban is lifted when it runs out", async () => {
    const h = await host();
    const u = await h.user();
    await h.ctx.internalAdapter.updateUser(u.id, { banned: true, banExpires: new Date(Date.now() + 1500) });
    await h.settle();
    expect(appUsers(h.app)[0]?.active).toBe(false);
    await new Promise((r) => setTimeout(r, 1600));
    expect(await h.auth.api.scimProvisioningRun({ body: {} })).toMatchObject({ done: 1 });
    expect(appUsers(h.app)[0]?.active).toBe(true);
  });
});
