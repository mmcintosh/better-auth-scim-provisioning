// A Google Workspace target an organization's owner stores through the registry's API, in a real
// Workspace: the check (a lookup in the admin's own domain) answers ok, a member added is created
// there through the stored, sealed credentials and the DNS-checking fetch, a member removed is
// suspended, and deleting the target stops delivery. The test user is deleted at Google afterwards.
// Runs only with GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_ADMIN_EMAIL and GOOGLE_TEST_DOMAIN
// set (in .env.live); GOOGLE_ORG_UNIT (e.g. "/SCIM Test") is where the test user is made.
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin, organization } from "better-auth/plugins";
import { afterAll, describe, expect, it } from "vitest";
import { scimProvisioning } from "../../src";
import { GOOGLE_DIRECTORY_URL, googleWorkspaceClient } from "../../src/google";
import { guardedFetch } from "../../src/registry";
import type { GoogleWorkspaceTarget } from "../../src/types";

const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
// A PEM in an env file usually has its line breaks written as "\n".
const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const adminEmail = process.env.GOOGLE_ADMIN_EMAIL;
const domain = process.env.GOOGLE_TEST_DOMAIN;
const orgUnitPath = process.env.GOOGLE_ORG_UNIT || undefined;
const configured = !!(clientEmail && privateKey && adminEmail && domain);

describe.skipIf(!configured)("live Google Workspace target in the registry", () => {
  const email = `scim-live-reg-${Date.now().toString(36)}@${domain}`;
  /** Every create and change Google accepted, with the user it answered with. */
  const writes: { method: string; user: Record<string, any> }[] = [];
  const guarded = guardedFetch();
  const recording: typeof fetch = async (input, init) => {
    const res = await guarded(input, init);
    const method = init?.method ?? "GET";
    if (res.ok && (method === "POST" || method === "PATCH" || method === "PUT") && String(input instanceof Request ? input.url : input).startsWith(GOOGLE_DIRECTORY_URL)) {
      const user = (await res.clone().json().catch(() => null)) as Record<string, any> | null;
      if (user?.id && user.primaryEmail) writes.push({ method, user });
    }
    return res;
  };
  const cleanupTarget: GoogleWorkspaceTarget = { id: "cleanup", type: "google-workspace", google: { clientEmail: clientEmail!, privateKey: privateKey!, adminEmail: adminEmail! } };
  const created = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  afterAll(async () => {
    if (!configured) return;
    const client = googleWorkspaceClient(cleanupTarget);
    // A user created moments ago can't be deleted yet (412): asked again for up to a minute.
    for (const id of created) {
      for (let i = 0; ; i++) {
        try {
          await client.remove(id);
          console.log(`cleanup ${id}: deleted`);
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

  it("check answers ok; a member added is created, removed is suspended; a deleted target delivers nothing", async () => {
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "live-secret-that-is-at-least-32-characters-long",
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
      plugins: [admin(), organization(), scimProvisioning({ targets: [], registry: { fetch: recording }, retry: { baseDelayMs: 1000 } })],
    });
    const ctx = await auth.$context;
    await (await getMigrations(ctx.options)).runMigrations();
    const jobs = () => ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningJob" });
    /** Every background delivery, then the scheduled run until nothing is due: Google's directory can lag. */
    const settle = async () => {
      for (const until = Date.now() + 240_000; Date.now() < until; ) {
        while (pending.size) await Promise.allSettled([...pending]);
        if (!(await jobs()).some((j) => !j.failed)) return;
        await sleep(2000);
        await auth.api.scimProvisioningRun({ body: {} });
      }
    };
    const seen = (id: string) => [...writes].reverse().find((w) => w.user.id === id)?.user ?? null;

    // The owner (not in the Workspace domain, so never provisioned) and their organization.
    const up = await auth.api.signUpEmail({ body: { email: "owner@example.com", password: "correct-horse-battery", name: "Owner" } });
    await ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    const res = await auth.api.signInEmail({ body: { email: "owner@example.com", password: "correct-horse-battery" }, asResponse: true });
    const headers = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
    const org = (await auth.api.createOrganization({ body: { name: "Live", slug: "live" }, headers }))!;
    await settle();

    // 1. Stored, then checked: the lookup in the admin's own domain finds nobody, and says ok.
    const { target } = await auth.api.scimProvisioningCreateTarget!({
      body: { organizationId: org.id, settings: { type: "google-workspace", name: "Workspace", google: { clientEmail: clientEmail!, adminEmail: adminEmail!, ...(orgUnitPath ? { orgUnitPath } : {}) } }, credentials: { privateKey: privateKey! } } as never,
      headers,
    });
    expect(JSON.stringify(target)).not.toContain("PRIVATE KEY");
    const check = await auth.api.scimProvisioningCheckTarget!({ body: { id: target.id }, headers });
    console.log(`1 check: ${JSON.stringify(check)}`);
    expect(check).toEqual({ ok: true });
    await settle();
    expect(writes).toEqual([]); // the owner isn't sent: their email is outside the Workspace (they fail, not created)

    // 2. A member added: created in the Workspace, marked ours, in the org unit.
    const u = await ctx.internalAdapter.createUser({ email, name: "Registry Live Tester", emailVerified: true }, { method: "admin" });
    await auth.api.addMember({ body: { userId: u.id, organizationId: org.id, role: "member" } });
    await settle();
    const link = (await ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningLink" })).find((l) => l.userId === u.id && l.targetId === target.id);
    if (!link?.remoteId) throw new Error(`not provisioned: ${JSON.stringify(await jobs())}`);
    created.add(link.remoteId);
    let g = seen(link.remoteId);
    console.log(`2 added: primaryEmail=${g?.primaryEmail} suspended=${g?.suspended} orgUnitPath=${g?.orgUnitPath}`);
    expect(g).toMatchObject({ primaryEmail: email, suspended: false });
    if (orgUnitPath) expect(g?.orgUnitPath).toBe(orgUnitPath);
    expect(g?.externalIds?.find((x: any) => x.customType === "better-auth")?.value).toBe(u.id);

    // 3. Removed from the organization: suspended there.
    await auth.api.removeMember({ body: { memberIdOrEmail: email, organizationId: org.id }, headers });
    await settle();
    g = seen(link.remoteId);
    console.log(`3 removed: suspended=${g?.suspended}`);
    expect(g?.suspended).toBe(true);

    // 4. The target deleted: its links and jobs go, and a later change sends nothing.
    await auth.api.scimProvisioningDeleteTarget!({ body: { id: target.id }, headers });
    const before = writes.length;
    await auth.api.addMember({ body: { userId: u.id, organizationId: org.id, role: "member" } });
    await settle();
    expect(writes.length).toBe(before);
    expect((await ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningLink" })).filter((l) => l.targetId === target.id)).toEqual([]);
  }, 1_800_000);
});
