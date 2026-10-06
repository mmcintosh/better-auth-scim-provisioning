// A Better Auth host on in-memory SQLite with the admin and organization plugins and
// scimProvisioning, its targets served by mock SCIM apps. Background work is collected, so a test
// can wait for deliveries to finish (`settle`).
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin, organization } from "better-auth/plugins";
import { scimProvisioning } from "../../src";
import type { ScimProvisioningOptions, ScimTarget, Target, TargetOptions, TargetRegistryOptions } from "../../src/types";
import { mockGoogle } from "./mock-google";
import { mockScim } from "./mock-scim";
import { mockWebhook } from "./mock-webhook";

type TargetSpec = Omit<TargetOptions, "fetch"> & Pick<ScimTarget, "update" | "compat"> & { type?: "scim" | "google-workspace" | "webhook"; requireNames?: boolean; keepsExternalId?: boolean; patch?: boolean; like?: "aws" | "atlassian"; pageSize?: number; membersOnRequest?: boolean; indexPaged?: boolean };

/** A database for Better Auth's `database` option, and whether it needs Better Auth's migrations. */
export interface HostDatabase {
  database: unknown;
  migrate: boolean;
}

/**
 * The host's plugins with a placeholder target: the same tables as createHost's, for building an
 * ORM schema (test/adapters/orm-schemas.ts) or running Better Auth's migrations on a raw database.
 */
export function schemaOptions(database?: unknown) {
  return {
    ...(database === undefined ? {} : { database: database as never }),
    plugins: [admin(), organization({ teams: { enabled: true } }), scimProvisioning({ targets: [{ id: "schema", type: "scim", url: "https://schema.invalid/scim/v2", token: "t" }] as Target[], registry: {} })],
  };
}

export async function createHost(o: { targets?: TargetSpec[]; retry?: ScimProvisioningOptions["retry"]; onFailure?: ScimProvisioningOptions["onFailure"]; registry?: TargetRegistryOptions; concurrency?: number; database?: HostDatabase; googleLag?: number; googleRenameLag?: number; googleGroupLag?: number; googleGroupReadLag?: number; googleGroupScope?: boolean; googleMembersPageSize?: number } = {}) {
  const specs = o.targets ?? [{ id: "app" }];
  const apps = Object.fromEntries(specs.map((s) => [s.id, mockScim({ requireNames: s.requireNames ?? true, keepsExternalId: s.keepsExternalId ?? true, patch: s.patch ?? false, ...(s.like ? { like: s.like } : {}), ...(s.pageSize ? { pageSize: s.pageSize } : {}), ...(s.membersOnRequest ? { membersOnRequest: true } : {}), ...(s.indexPaged ? { indexPaged: true } : {}) })]));
  // A Google Workspace target gets a mock Directory API instead (one per host).
  const google = specs.some((s) => s.type === "google-workspace") ? await mockGoogle({ lag: o.googleLag, renameLag: o.googleRenameLag, groupLag: o.googleGroupLag, groupReadLag: o.googleGroupReadLag, groupScope: o.googleGroupScope, membersPageSize: o.googleMembersPageSize }) : undefined;
  const webhook = specs.some((s) => s.type === "webhook") ? mockWebhook() : undefined;
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
        targets: specs.map(({ requireNames: _, keepsExternalId: __, patch: ___, like: ____, pageSize: _____, membersOnRequest: ______, indexPaged: _______, ...s }) =>
          s.type === "webhook" && webhook
            ? { ...s, type: "webhook", url: webhook.url, secret: webhook.secret, fetch: webhook.fetch }
            : s.type === "google-workspace" && google
            ? { ...s, type: "google-workspace", url: google.url, google: { clientEmail: google.clientEmail, privateKey: google.privateKey, adminEmail: google.admin, tokenUrl: google.tokenUrl }, fetch: google.fetch }
            : { ...s, type: "scim", url: apps[s.id]!.url, token: apps[s.id]!.token, fetch: apps[s.id]!.fetch },
        ) as Target[],
        ...(o.retry ? { retry: o.retry } : {}),
        ...(o.concurrency ? { concurrency: o.concurrency } : {}),
        ...(o.onFailure ? { onFailure: o.onFailure } : {}),
        ...(o.registry ? { registry: o.registry } : {}),
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
  return { auth, ctx, db, apps, app: (specs[0] ? apps[specs[0].id] : undefined) as (typeof apps)[string], google: google as NonNullable<typeof google>, webhook: webhook as NonNullable<typeof webhook>, settle, user, jobs, links };
}
