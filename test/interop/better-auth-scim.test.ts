// Interoperability with Better Auth's own inbound SCIM server, @better-auth/scim, as a real
// receiver: another Better Auth app, in process, that our plugin provisions. Its link from a SCIM
// User to a Better Auth user is what an ID-JAG receiver resolves a `sub` through
// (`acquireActiveSCIMUserLink({ connectionId, externalId: sub })`), and an ID-JAG's `sub` is the
// issuer's Better Auth user id, which is our default externalId. So these tests pin that the link
// is found by the IdP's user id while the user is active, and not after they're deactivated or
// deleted, plus the profile, groups, and what deactivation does (and doesn't) do to sessions.
import { DatabaseSync } from "node:sqlite";
import { acquireActiveSCIMUserLink, scim } from "@better-auth/scim";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin, organization } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { defaultScimUser, scimProvisioning } from "../../src";
import type { ScimProvisioningOptions, ScimTarget } from "../../src/types";

const RECEIVER = "https://receiver.example";
const CONNECTION = "our-idp";
const TOKEN = "receiver-bearer-token-that-is-long-enough";

/** The app our users sign in to: Better Auth with @better-auth/scim, one connection for our IdP. */
async function receiver() {
  const lifecycle: { userId: string; active: boolean }[] = [];
  const auth = betterAuth({
    baseURL: RECEIVER,
    secret: "receiver-secret-that-is-at-least-32-characters",
    telemetry: { enabled: false },
    database: new DatabaseSync(":memory:"),
    emailAndPassword: { enabled: true },
    plugins: [
      // Cast: @better-auth/scim's schema type has an optional table, which BetterAuthPlugin's
      // doesn't allow under exactOptionalPropertyTypes. Its runtime is unaffected.
      scim({
        connections: [{ id: CONNECTION, credentials: [{ type: "bearer", id: "our-idp-token", token: TOKEN }] }],
        identity: {
          // The application's hook for a user's overall state, called on every change.
          reconcileUser(state) {
            lifecycle.push({ userId: state.userId, active: state.active });
          },
        },
      }) as unknown as BetterAuthPlugin,
    ],
  });
  const ctx = await auth.$context;
  await (await getMigrations(ctx.options)).runMigrations();
  /** What an ID-JAG receiver does with a `sub`: the active link for this connection, or null. */
  const linkFor = (externalId: string) => ctx.adapter.transaction((trx) => acquireActiveSCIMUserLink({ connectionId: CONNECTION, externalId }, { database: trx }));
  const scimUsers = () => ctx.adapter.findMany<Record<string, any>>({ model: "scimUser" });
  const userById = (id: string) => ctx.adapter.findOne<Record<string, any>>({ model: "user", where: [{ field: "id", value: id }] });
  return { auth, ctx, lifecycle, linkFor, scimUsers, userById };
}

/** Our side: an IdP with scimProvisioning whose one target is the receiver's SCIM endpoint. */
async function idp(app: Awaited<ReturnType<typeof receiver>>, o: Partial<ScimProvisioningOptions> & { target?: Partial<ScimTarget>; userFields?: string[] } = {}) {
  const pending = new Set<Promise<unknown>>();
  const { target: extra, userFields, ...options } = o;
  const target: ScimTarget = { id: "receiver", type: "scim", url: `${RECEIVER}/api/auth/scim/v2`, token: TOKEN, fetch: (input, init) => app.auth.handler(new Request(input, init)), ...extra };
  const auth = betterAuth({
    baseURL: "https://idp.example",
    secret: "idp-secret-that-is-at-least-32-characters-long",
    telemetry: { enabled: false },
    database: new DatabaseSync(":memory:"),
    emailAndPassword: { enabled: true },
    ...(userFields ? { user: { additionalFields: Object.fromEntries(userFields.map((f) => [f, { type: "string" as const, required: false }])) } } : {}),
    advanced: {
      backgroundTasks: {
        handler: (p: Promise<unknown>) => {
          const tracked = p.finally(() => pending.delete(tracked));
          pending.add(tracked);
        },
      },
    },
    plugins: [admin(), organization(), scimProvisioning({ targets: [target], ...options })],
  });
  const ctx = await auth.$context;
  await (await getMigrations(ctx.options)).runMigrations();
  const jobs = () => ctx.adapter.findMany<Record<string, any>>({ model: "scimProvisioningJob" });
  const settle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
  /** Every delivery done, and nothing left queued or failed. */
  const delivered = async () => {
    await settle();
    expect(await jobs()).toEqual([]);
  };
  const newUser = (email: string, name: string) => ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: "admin" });
  return { auth, ctx, settle, delivered, newUser };
}

describe("@better-auth/scim as the receiver", () => {
  it("the receiver's link is found by the IdP's user id (an ID-JAG sub) while active, and not after deactivation or deletion", async () => {
    const app = await receiver();
    const us = await idp(app);
    const ada = await us.newUser("ada@example.com", "Ada Lovelace");
    await us.delivered();

    const [stored] = await app.scimUsers();
    expect(stored).toMatchObject({ connectionId: CONNECTION, externalId: ada.id, active: true });
    const link = await app.linkFor(ada.id);
    expect(link).toMatchObject({ userId: stored!.userId });
    expect(await app.userById(link!.userId)).toMatchObject({ email: "ada@example.com", name: "Ada Lovelace" });
    expect(await app.linkFor("someone-else")).toBeNull();

    // Changes reach the same user there.
    await us.ctx.internalAdapter.updateUser(ada.id, { name: "Ada King" });
    await us.delivered();
    expect(await app.userById(link!.userId)).toMatchObject({ name: "Ada King" });

    // Banned: inactive there, so an ID-JAG for her finds no user. Unbanned: found again, the same user.
    await us.ctx.internalAdapter.updateUser(ada.id, { banned: true });
    await us.delivered();
    expect(await app.linkFor(ada.id)).toBeNull();
    await us.ctx.internalAdapter.updateUser(ada.id, { banned: false });
    await us.delivered();
    expect(await app.linkFor(ada.id)).toEqual(link);

    // Deleted here (deprovision "deactivate", the default): kept there but inactive, never found.
    await us.ctx.internalAdapter.deleteUser(ada.id);
    await us.delivered();
    expect(await app.linkFor(ada.id)).toBeNull();
    expect(await app.scimUsers()).toEqual([expect.objectContaining({ externalId: ada.id, active: false })]);
    expect(app.lifecycle.at(-1)).toEqual({ userId: link!.userId, active: false });
  });

  it('deprovision "delete" removes the SCIM User there; the link is gone', async () => {
    const app = await receiver();
    const us = await idp(app, { target: { deprovision: "delete" } });
    const bo = await us.newUser("bo@example.com", "Bo Bell");
    await us.delivered();
    expect(await app.linkFor(bo.id)).not.toBeNull();
    await us.ctx.internalAdapter.deleteUser(bo.id);
    await us.delivered();
    expect(await app.linkFor(bo.id)).toBeNull();
    expect(await app.scimUsers()).toEqual([]);
  });

  it("deactivation ends the user's sessions there (@better-auth/scim does, once no SCIM source is active)", async () => {
    const app = await receiver();
    const us = await idp(app);
    const cy = await us.newUser("cy@example.com", "Cy Young");
    await us.delivered();
    const { userId } = (await app.linkFor(cy.id))!;
    const sessions = () => app.ctx.adapter.count({ model: "session", where: [{ field: "userId", value: userId }] });
    await app.ctx.internalAdapter.createSession(userId);
    await us.ctx.internalAdapter.updateUser(cy.id, { name: "Cy Old" });
    await us.delivered();
    expect(await sessions()).toBe(1); // a change while active leaves them
    await us.ctx.internalAdapter.updateUser(cy.id, { banned: true });
    await us.delivered();
    expect(await sessions()).toBe(0);
  });

  it("organizations arrive as SCIM Groups with their provisioned members", async () => {
    const app = await receiver();
    const us = await idp(app, { target: { groups: true } });
    const di = await us.newUser("di@example.com", "Di Prince");
    const ed = await us.newUser("ed@example.com", "Ed Elric");
    const org = await us.auth.api.createOrganization({ body: { name: "Acme", slug: "acme", userId: di.id } });
    await us.auth.api.addMember({ body: { userId: ed.id, organizationId: org!.id, role: "member" } });
    await us.delivered();

    const groups = await app.ctx.adapter.findMany<Record<string, any>>({ model: "scimGroup" });
    expect(groups).toEqual([expect.objectContaining({ connectionId: CONNECTION, displayName: "Acme", externalId: org!.id })]);
    const memberships = await app.ctx.adapter.findMany<Record<string, any>>({ model: "scimGroupMember" });
    const members = (await app.scimUsers()).filter((u) => memberships.some((m) => m.scimUserId === u.id)).map((u) => u.externalId);
    expect(members.sort()).toEqual([di.id, ed.id].sort());
  });

  it("an externalId changed with mapUser is what the receiver links by: the IdP's user id (the ID-JAG sub) no longer finds the user", async () => {
    const app = await receiver();
    const us = await idp(app, { target: { mapUser: (user) => ({ ...defaultScimUser(user), externalId: `emp-${user.email}` }) } });
    const fay = await us.newUser("fay@example.com", "Fay Wray");
    await us.delivered();
    expect(await app.linkFor("emp-fay@example.com")).not.toBeNull();
    expect(await app.linkFor(fay.id)).toBeNull();
  });

  it.each([["put"], ["patch"]] as const)("the Enterprise User extension arrives (%s), the manager as the receiver's SCIM id for them", async (update) => {
    const app = await receiver();
    const us = await idp(app, { target: { enterprise: true, update }, userFields: ["employeeNumber", "department", "costCenter", "organization", "division", "managerId"] });
    const boss = await us.newUser("gus@example.com", "Gus Boss");
    const hal = await us.newUser("hal@example.com", "Hal Report");
    await us.ctx.internalAdapter.updateUser(hal.id, { employeeNumber: "E-42", department: "Ops", costCenter: "CC1", organization: "Acme", division: "North", managerId: boss.id });
    await us.delivered();
    const scimIdOf = async (externalId: string) => ((await app.scimUsers()).find((u) => u.externalId === externalId) as { id: string }).id;
    const res = await app.auth.handler(new Request(`${RECEIVER}/api/auth/scim/v2/Users/${await scimIdOf(hal.id)}`, { headers: { authorization: `Bearer ${TOKEN}` } }));
    const user = (await res.json()) as Record<string, any>;
    expect(user.schemas).toContain("urn:ietf:params:scim:schemas:extension:enterprise:2.0:User");
    expect(user["urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"]).toMatchObject({
      employeeNumber: "E-42",
      department: "Ops",
      costCenter: "CC1",
      organization: "Acme",
      division: "North",
      manager: { value: await scimIdOf(boss.id) },
    });
    // Cleared here: cleared there (PUT leaves it out, PATCH removes it; never-set ones are removed too, and accepted).
    await us.ctx.internalAdapter.updateUser(hal.id, { department: null, managerId: null });
    await us.delivered();
    const after = (await (await app.auth.handler(new Request(`${RECEIVER}/api/auth/scim/v2/Users/${await scimIdOf(hal.id)}`, { headers: { authorization: `Bearer ${TOKEN}` } }))).json()) as Record<string, any>;
    const ext = after["urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"] ?? {};
    expect(ext.department).toBeUndefined();
    expect(ext.manager).toBeUndefined();
    expect(ext.employeeNumber).toBe("E-42");
  });
});
