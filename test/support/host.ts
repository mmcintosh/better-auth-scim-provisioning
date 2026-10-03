// A Better Auth host on in-memory SQLite with the admin and organization plugins and
// scimProvisioning, its targets served by mock SCIM apps. Background work is collected, so a test
// can wait for deliveries to finish (`settle`).
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin, organization } from "better-auth/plugins";
import { scimProvisioning } from "../../src";
import type { ScimProvisioningOptions, ScimTarget } from "../../src/types";
import { mockScim } from "./mock-scim";

type TargetSpec = Omit<ScimTarget, "url" | "token" | "fetch"> & { requireNames?: boolean; keepsExternalId?: boolean; patch?: boolean };

/** A database for Better Auth's `database` option, and whether it needs Better Auth's migrations. */
export interface HostDatabase {
  database: unknown;
  migrate: boolean;
}

export async function createHost(o: { targets?: TargetSpec[]; retry?: ScimProvisioningOptions["retry"]; concurrency?: number; database?: HostDatabase } = {}) {
  const specs = o.targets ?? [{ id: "app" }];
  const apps = Object.fromEntries(specs.map((s) => [s.id, mockScim({ requireNames: s.requireNames ?? true, keepsExternalId: s.keepsExternalId ?? true, patch: s.patch ?? false })]));
  const pending = new Set<Promise<unknown>>();
  const db = new DatabaseSync(":memory:");
  const database = o.database ?? { database: db, migrate: true };
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-that-is-at-least-32-characters-long",
    telemetry: { enabled: false },
    database: database.database as never,
    emailAndPassword: { enabled: true },
    advanced: {
      backgroundTasks: {
        handler: (p: Promise<unknown>) => {
          const tracked = p.finally(() => pending.delete(tracked));
          pending.add(tracked);
        },
      },
    },
    plugins: [
      admin(),
      // Teams on, so team groups can be tested; nothing else changes without teamGroups.
      organization({ teams: { enabled: true } }),
      scimProvisioning({
        targets: specs.map(({ requireNames: _, keepsExternalId: __, patch: ___, ...s }) => ({ ...s, url: apps[s.id]!.url, token: apps[s.id]!.token, fetch: apps[s.id]!.fetch })),
        ...(o.retry ? { retry: o.retry } : {}),
        ...(o.concurrency ? { concurrency: o.concurrency } : {}),
      }),
    ],
  });
  const ctx = await auth.$context;
  if (database.migrate) await (await getMigrations(ctx.options)).runMigrations();

  /** Wait for every background delivery (and any it starts). */
  const settle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };

  let n = 0;
  /** A user as Better Auth creates it, verified unless told otherwise. */
  const user = async (name = "Ada Lovelace", verified = true) => {
    const email = `user${++n}@example.com`;
    // One write, so one change to deliver: verified (or not) from the start.
    const created = await ctx.internalAdapter.createUser({ email, name, emailVerified: verified }, { method: "admin" });
    await settle();
    return (await ctx.internalAdapter.findUserById(created.id))!;
  };

  const jobs = () => ctx.adapter.findMany<Record<string, unknown>>({ model: "scimProvisioningJob" });
  const links = () => ctx.adapter.findMany<Record<string, unknown>>({ model: "scimProvisioningLink" });
  return { auth, ctx, db, apps, app: apps[specs[0]!.id]!, settle, user, jobs, links };
}
