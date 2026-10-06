// Found in review: the plugin kept its queue in closure state that each Better Auth instance's
// init replaced. One scimProvisioning() passed to two instances (per-tenant databases; and Better
// Auth itself builds a second context from the same options to run migrations) made the first
// instance queue and deliver through the second one's database. Each instance has its own now.
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { expect, it } from "vitest";
import { scimProvisioning } from "../../src";
import { mockScim } from "../support/mock-scim";

it("one plugin object in two Better Auth instances: each queues and delivers through its own database", async () => {
  const app = mockScim({ requireNames: false });
  const plugin = scimProvisioning({ targets: [{ id: "app", url: app.url, token: app.token, fetch: app.fetch }] });
  const make = async () => {
    const db = new DatabaseSync(":memory:");
    const pending = new Set<Promise<unknown>>();
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "test-secret-that-is-at-least-32-characters-long",
      telemetry: { enabled: false },
      database: db,
      advanced: {
        backgroundTasks: {
          handler: (p: Promise<unknown>) => {
            const tracked = p.finally(() => pending.delete(tracked));
            pending.add(tracked);
          },
        },
      },
      plugins: [plugin],
    });
    const ctx = await auth.$context;
    await (await getMigrations(ctx.options)).runMigrations();
    const settle = async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    };
    const links = () => db.prepare('SELECT "userId" FROM "scimProvisioningLink"').all() as { userId: string }[];
    return { auth, ctx, settle, links };
  };
  const a = await make();
  const b = await make();

  const ada = await a.ctx.internalAdapter.createUser({ email: "ada@example.com", name: "Ada Lovelace", emailVerified: true }, { method: "admin" } as never);
  await a.settle();
  await b.settle();
  expect(a.links().map((l) => l.userId)).toEqual([ada.id]);
  expect(b.links()).toEqual([]);

  const bea = await b.ctx.internalAdapter.createUser({ email: "bea@example.com", name: "Bea Berg", emailVerified: true }, { method: "admin" } as never);
  await b.settle();
  expect(b.links().map((l) => l.userId)).toEqual([bea.id]);
  expect(a.links().map((l) => l.userId)).toEqual([ada.id]);
  // The endpoints too: each instance runs its own queue.
  expect(await a.auth.api.scimProvisioningReconcile({ body: {} })).toEqual({ queued: 1, next: null });
});
