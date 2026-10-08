// The registry's audit lines (who created, changed or removed which target) are logged at warn,
// Better Auth's default level: at info they were dropped unless the host lowered the level.
import { describe, expect, it, vi } from "vitest";
import { createHost } from "../support/host";
import { mockScim } from "../support/mock-scim";

describe("registry: audit lines", () => {
  it("creating a target is logged at the default level", async () => {
    const remote = mockScim();
    const h = await createHost({ targets: [], registry: { fetch: remote.fetch } });
    const up = await h.auth.api.signUpEmail({ body: { email: "olive@example.com", password: "correct-horse-battery", name: "Olive" } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    const res = await h.auth.api.signInEmail({ body: { email: "olive@example.com", password: "correct-horse-battery" }, asResponse: true });
    const headers = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
    const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers }))!;
    const lines: string[] = [];
    for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: remote.token } }, headers });
    await h.settle();
    expect(lines.some((l) => l.includes("registry: user"))).toBe(true);
  });
});
