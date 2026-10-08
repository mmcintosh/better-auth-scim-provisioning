// An organization's stored target may read only the user fields the host allows (registry.enterpriseFields); a hidden field or the host role is refused.
import { expect, it } from "vitest";
import { createHost } from "../support/host";
import { mockScim } from "../support/mock-scim";

it("a stored target can't read a hidden user field or the host role; the default fields work", async () => {
  const remote = mockScim({ patch: true });
  const h = await createHost({
    targets: [],
    registry: { fetch: remote.fetch },
    userFields: { internalNote: { type: "string", returned: false } as never },
  });
  const signIn = async (email: string) => {
    const up = await h.auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name: email.split("@")[0]! } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    await h.settle();
    const res = await h.auth.api.signInEmail({ body: { email, password: "correct-horse-battery" }, asResponse: true });
    return { id: up.user.id, headers: new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") }) };
  };
  const owner = await signIn("olive@example.com");
  const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: owner.headers }))!;
  const mia = await signIn("mia@example.com");
  await h.ctx.internalAdapter.updateUser(mia.id, { internalNote: "fraud review pending", role: "admin" });
  await h.auth.api.addMember({ body: { userId: mia.id, organizationId: acme.id, role: "member" } });
  await h.settle();
  // Refused: those fields aren't on the host's allowlist (registry.enterpriseFields).
  const refused = await h.auth.api
    .scimProvisioningCreateTarget({
      body: { organizationId: acme.id, settings: { name: "x", url: "https://app.example.com/scim/v2", enterprise: { department: "internalNote", costCenter: "role" } }, credentials: { token: remote.token } } as never,
      headers: owner.headers,
    })
    .catch((e: { statusCode?: number; body?: { issues?: string[] } }) => e);
  expect((refused as { statusCode?: number }).statusCode).toBe(400);
  expect(JSON.stringify((refused as { body?: unknown }).body)).toMatch(/reads (role, internalNote|internalNote, role)/);
  // The default fields are fine, and only those are read.
  await h.auth.api.scimProvisioningCreateTarget({
    body: { organizationId: acme.id, settings: { name: "y", url: "https://app.example.com/scim/v2", enterprise: true }, credentials: { token: remote.token } } as never,
    headers: owner.headers,
  });
  await h.settle();
  for (let i = 0; i < 5; i++) await h.auth.api.scimProvisioningRun({ body: {} });
  await h.settle();
  const sent = [...remote.users.values()].find((u) => u.userName === "mia@example.com") as any;
  // What the plugin should guarantee: nothing beyond what the host chose to expose.
  expect(sent?.["urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"]?.department).toBeUndefined();
  expect(sent?.["urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"]?.costCenter).toBeUndefined();
});
