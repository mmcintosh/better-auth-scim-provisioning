// The Enterprise User extension, live: at AWS IAM Identity Center (read back over SCIM) and at
// Google Workspace (checked against Google's answers to each write: its reads trail its writes).
// A manager and a report with every attribute; then one attribute cleared and the manager
// removed. Everything made is deleted at the end. Each part runs only with its credentials in
// .env.live (AWS_SCIM_URL and AWS_SCIM_TOKEN; GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY,
// GOOGLE_ADMIN_EMAIL and GOOGLE_TEST_DOMAIN, with GOOGLE_ORG_UNIT optional).
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins";
import { afterAll, describe, expect, it } from "vitest";
import { awsIamIdentityCenter, scimProvisioning } from "../../src";
import { GOOGLE_DIRECTORY_URL, googleWorkspaceClient } from "../../src/google";
import { SCIM_ENTERPRISE_USER_SCHEMA as ENT } from "../../src/scim-client";
import type { GoogleWorkspaceTarget, Target } from "../../src/types";

const FIELDS = ["employeeNumber", "costCenter", "organization", "division", "department", "managerId"] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A host with one target and the Enterprise User fields; deliveries finished by settle(). */
async function host(target: Target) {
  const pending = new Set<Promise<unknown>>();
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "live-secret-that-is-at-least-32-characters-long",
    telemetry: { enabled: false },
    database: new DatabaseSync(":memory:"),
    emailAndPassword: { enabled: true },
    user: { additionalFields: Object.fromEntries(FIELDS.map((f) => [f, { type: "string" as const, required: false }])) },
    advanced: {
      backgroundTasks: {
        handler: (p: Promise<unknown>) => {
          const tracked = p.finally(() => pending.delete(tracked));
          pending.add(tracked);
        },
      },
    },
    plugins: [admin(), scimProvisioning({ targets: [target], retry: { baseDelayMs: 1000 } })],
  });
  const ctx = await auth.$context;
  await (await getMigrations(ctx.options)).runMigrations();
  const jobs = () => ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningJob" });
  const settle = async () => {
    for (const until = Date.now() + 240_000; Date.now() < until; ) {
      while (pending.size) await Promise.allSettled([...pending]);
      if (!(await jobs()).some((j) => !j.failed)) return;
      await sleep(2000);
      await auth.api.scimProvisioningRun({ body: {} });
    }
  };
  const link = async (userId: string) => (await ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningLink" })).find((l) => l.userId === userId);
  return { auth, ctx, settle, jobs, link };
}

const awsUrl = process.env.AWS_SCIM_URL?.replace(/\/+$/, "");
const awsToken = process.env.AWS_SCIM_TOKEN;

describe.skipIf(!(awsUrl && awsToken))("live Enterprise User at AWS IAM Identity Center", () => {
  const stamp = Date.now().toString(36);
  const made = new Set<string>();
  const headers = () => ({ authorization: `Bearer ${awsToken}`, accept: "application/scim+json" });
  const get = async (id: string) => (await (await fetch(`${awsUrl}/Users/${id}`, { headers: headers() })).json()) as Record<string, any>;

  afterAll(async () => {
    for (const id of made) {
      const res = await fetch(`${awsUrl}/Users/${id}`, { method: "DELETE", headers: headers() });
      console.log(`cleanup AWS user ${id}: ${res.status}`);
    }
  });

  it("every attribute, the manager as AWS's id for them; a cleared one and the manager removed", async () => {
    const h = await host(awsIamIdentityCenter({ id: "aws", url: awsUrl!, token: awsToken!, enterprise: true }));
    const boss = await h.ctx.internalAdapter.createUser({ email: `scim-live-${stamp}-boss@example.com`, name: "Live Boss", emailVerified: true }, { method: "admin" });
    await h.settle();
    const rep = await h.ctx.internalAdapter.createUser({ email: `scim-live-${stamp}-rep@example.com`, name: "Live Report", emailVerified: true }, { method: "admin" });
    await h.settle();
    const bossId = (await h.link(boss.id))!.remoteId as string;
    const repId = (await h.link(rep.id))!.remoteId as string;
    made.add(repId).add(bossId);
    await h.ctx.internalAdapter.updateUser(rep.id, { employeeNumber: "E-42", costCenter: "CC1", organization: "Acme", division: "North", department: "Ops", managerId: boss.id });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    const got = await get(repId);
    console.log(`AWS enterprise: ${JSON.stringify(got[ENT])}`);
    expect(got[ENT]).toMatchObject({ employeeNumber: "E-42", costCenter: "CC1", organization: "Acme", division: "North", department: "Ops", manager: expect.objectContaining({ value: bossId }) });
    await h.ctx.internalAdapter.updateUser(rep.id, { department: null, managerId: null });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    const after = (await get(repId))[ENT] ?? {};
    console.log(`AWS enterprise after clearing: ${JSON.stringify(after)}`);
    expect(after.department).toBeUndefined();
    expect(after.manager).toBeUndefined();
    expect(after.employeeNumber).toBe("E-42");
  }, 600_000);
});

const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const adminEmail = process.env.GOOGLE_ADMIN_EMAIL;
const domain = process.env.GOOGLE_TEST_DOMAIN;
const orgUnitPath = process.env.GOOGLE_ORG_UNIT || undefined;

describe.skipIf(!(clientEmail && privateKey && adminEmail && domain))("live Enterprise User at Google Workspace", () => {
  const stamp = Date.now().toString(36);
  /** Every user Google answered a create or change with. */
  const writes: Record<string, any>[] = [];
  const recording: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const method = init?.method ?? "GET";
    if (res.ok && (method === "POST" || method === "PATCH") && String(input).startsWith(`${GOOGLE_DIRECTORY_URL}/users`)) {
      const u = (await res.clone().json().catch(() => null)) as Record<string, any> | null;
      if (u?.id && u.primaryEmail) writes.push(u);
    }
    return res;
  };
  const target: GoogleWorkspaceTarget = { id: "gw", type: "google-workspace", enterprise: true, fetch: recording, google: { clientEmail: clientEmail!, privateKey: privateKey!, adminEmail: adminEmail!, orgUnitPath } };
  const made = new Set<string>();

  afterAll(async () => {
    const client = googleWorkspaceClient(target);
    for (const id of made) {
      for (let i = 0; ; i++) {
        try {
          await client.remove(id);
          console.log(`cleanup Google user ${id}: deleted`);
          break;
        } catch (e) {
          if (i >= 12 || !/412|creation is not complete/.test((e as Error).message)) {
            console.log(`cleanup of ${id} failed: ${(e as Error).message}`);
            break;
          }
          await sleep(5000);
        }
      }
    }
  }, 300_000);

  it("the primary organization, the employee id and the manager relation; cleared ones removed", async () => {
    const h = await host(target);
    const bossEmail = `scim-live-${stamp}-boss@${domain}`;
    const boss = await h.ctx.internalAdapter.createUser({ email: bossEmail, name: "Live Boss", emailVerified: true }, { method: "admin" });
    await h.settle();
    const rep = await h.ctx.internalAdapter.createUser({ email: `scim-live-${stamp}-rep@${domain}`, name: "Live Report", emailVerified: true }, { method: "admin" });
    await h.settle();
    for (const u of [boss, rep]) {
      const l = await h.link(u.id);
      if (l?.remoteId) made.add(l.remoteId);
    }
    const repId = (await h.link(rep.id))!.remoteId as string;
    const last = () => [...writes].reverse().find((w) => w.id === repId)!;
    await h.ctx.internalAdapter.updateUser(rep.id, { employeeNumber: "E-42", costCenter: "CC1", organization: "Acme", division: "North", department: "Ops", managerId: boss.id });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    let g = last();
    console.log(`Google: organizations=${JSON.stringify(g.organizations)} relations=${JSON.stringify(g.relations)} externalIds=${JSON.stringify(g.externalIds)}`);
    expect(g.organizations).toEqual([expect.objectContaining({ primary: true, name: "Acme", department: "Ops", costCenter: "CC1", description: "North" })]);
    expect(g.relations).toEqual([expect.objectContaining({ type: "manager", value: bossEmail })]);
    expect(g.externalIds).toEqual(expect.arrayContaining([expect.objectContaining({ type: "organization", value: "E-42" })]));
    await h.ctx.internalAdapter.updateUser(rep.id, { department: null, managerId: null });
    await h.settle();
    expect(await h.jobs()).toEqual([]);
    g = last();
    console.log(`Google after clearing: organizations=${JSON.stringify(g.organizations)} relations=${JSON.stringify(g.relations)}`);
    expect(g.organizations?.[0]?.department).toBeUndefined();
    expect((g.relations ?? []).some((r: any) => r.type === "manager")).toBe(false);
  }, 900_000);
});
