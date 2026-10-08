// Two changes to a target at once can't mix one's URL with the other's credentials: the change
// is written only over the row as read (409 otherwise). Before, a settings-only change that read
// before an administrator's URL-and-credentials fix, and wrote after it, sent the new credentials
// to the old (perhaps an attacker's) URL.
import { describe, expect, it, vi } from "vitest";
import { TARGET_MODEL, unseal } from "../../src/registry";
import { createHost } from "../support/host";
import { mockScim } from "../support/mock-scim";

describe("registry: two changes at once", () => {
  it("the later one is refused (409); credentials never sit beside a URL they weren't given for", async () => {
    const remote = mockScim();
    const h = await createHost({ targets: [], registry: { fetch: remote.fetch } });
    const up = await h.auth.api.signUpEmail({ body: { email: "olive@example.com", password: "correct-horse-battery", name: "Olive" } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    const res = await h.auth.api.signInEmail({ body: { email: "olive@example.com", password: "correct-horse-battery" }, asResponse: true });
    const headers = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
    const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers }))!;
    // A malicious co-admin points the target at their own host, with throwaway credentials (allowed: credentials given).
    const EVIL = "https://collector.attacker.example/scim/v2";
    const { target } = await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, enabled: false, settings: { url: EVIL }, credentials: { token: "throwaway" } }, headers });
    await h.settle();
    const real = h.ctx.adapter.updateMany.bind(h.ctx.adapter);
    let armed = true;
    let fixed = false;
    vi.spyOn(h.ctx.adapter, "updateMany").mockImplementation(async (a: any) => {
      if (armed && a.model === TARGET_MODEL && a.update.config && !a.update.sealed) {
        armed = false;
        // The honest admin's fix lands between the co-admin's read and write.
        await h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: "the-real-production-token" } }, headers });
        fixed = true;
      }
      return real(a);
    });
    // The co-admin's settings-only update (it read url = EVIL, so "same destination": no credentials needed): refused.
    const e = await h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, settings: { url: EVIL, name: "x" } }, headers }).catch((x) => x);
    expect(fixed).toBe(true);
    expect(e?.statusCode).toBe(409);
    const [row] = await h.ctx.adapter.findMany<any>({ model: TARGET_MODEL });
    expect(JSON.parse(row.config).url).toBe("https://app.example.com/scim/v2");
    expect(await unseal(h.ctx.secretConfig as never, row)).toEqual({ token: "the-real-production-token" });
  });
});
