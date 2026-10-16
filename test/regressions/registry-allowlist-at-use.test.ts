// A stored target's allowlist (registry.enterpriseFields, registry.attributeFields) is checked when
// the target is used, not only when it's stored: a row rewritten outside the API to read a hidden
// field pauses the target, and the field never reaches the app. Mutation-checked: without the
// re-check in registrySource.build, the delivery goes out with the hidden value.
import { expect, it } from "vitest";
import { createHost } from "../support/host";
import { mockScim } from "../support/mock-scim";

const ENT = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const FIELDS = { internalNote: { type: "string" }, title: { type: "string" }, department: { type: "string" } } as const;

async function setup(registry: Record<string, unknown> = {}) {
  const remote = mockScim({ patch: true });
  const h = await createHost({ targets: [], registry: { fetch: remote.fetch, ...registry }, userFields: FIELDS });
  const signIn = async (email: string) => {
    const up = await h.auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name: email.split("@")[0]! } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email, password: "correct-horse-battery" }, asResponse: true });
    return { id: up.user.id, email, headers: new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) };
  };
  const owner = await signIn("olive@example.com");
  const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: owner.headers }))!;
  const create = (settings: Record<string, unknown>) =>
    h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings: { name: "x", url: "https://app.example.com/scim/v2", ...settings }, credentials: { token: remote.token } } as never, headers: owner.headers });
  const run = async () => {
    for (let i = 0; i < 3; i++) await h.auth.api.scimProvisioningRun({ body: {} });
    await h.settle();
  };
  return { h, remote, signIn, owner, acme, create, run };
}

for (const [option, hidden, read] of [
  ["attributes", { title: "internalNote" }, (u: any) => u?.title],
  ["enterprise", { department: "internalNote" }, (u: any) => u?.[ENT]?.department],
] as const) {
  it(`${option}: a row rewritten to read a hidden field pauses the target, and nothing is sent`, async () => {
    const { h, remote, signIn, acme, create, run } = await setup();
    const { target } = await create({ [option]: option === "attributes" ? { title: "title" } : { department: "department" } });
    const mia = await signIn("mia@example.com");
    await h.ctx.internalAdapter.updateUser(mia.id, { internalNote: "fraud review pending", title: "Analyst", department: "Ops" });
    await h.auth.api.addMember({ body: { userId: mia.id, organizationId: acme.id, role: "member" } });
    await run();
    const sent = () => [...remote.users.values()].find((u) => u.userName === mia.email) as any;
    expect(sent()).toBeTruthy();
    // An operator with database access rewrites the row to read the hidden field.
    await h.ctx.adapter.updateMany({ model: "scimProvisioningTarget", where: [{ field: "targetId", value: target.id }], update: { config: JSON.stringify({ name: "x", url: "https://app.example.com/scim/v2", [option]: hidden }) } });
    await h.ctx.internalAdapter.updateUser(mia.id, { name: "Mia Renamed" });
    await run();
    // Nothing went out since: the earlier value stands, the note never appears, the rename isn't there.
    expect(read(sent())).toBe(option === "attributes" ? "Analyst" : "Ops");
    expect(JSON.stringify(sent())).not.toContain("fraud review pending");
    expect(sent().displayName).not.toBe("Mia Renamed");
    // Paused as unreadable: the job waits (tried again in a while), it hasn't failed.
    const job = (await h.jobs()).find((j) => j.targetId === target.id && j.userId === mia.id)!;
    expect(job.failed).toBe(false);
    expect(new Date(job.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now() + 60_000);
  });
}

it("`true` reads the fields the users have, so a narrowed allowlist that covers those is enough", async () => {
  const { create } = await setup({ attributeFields: ["title"], enterpriseFields: ["department"] });
  await expect(create({ attributes: true, enterprise: true })).resolves.toBeTruthy();
  const { create: strict } = await setup({ attributeFields: [], enterpriseFields: [] });
  const refused = await strict({ attributes: true }).catch((e: { statusCode?: number; body?: unknown }) => e);
  expect((refused as { statusCode?: number }).statusCode).toBe(400);
  expect(JSON.stringify((refused as { body?: unknown }).body)).toMatch(/settings.attributes: reads title/);
});
