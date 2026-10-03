// Provisioning required a verified email, with no way out, so users whose
// sign-in provider leaves emailVerified false (some SSO and OAuth setups) were never provisioned.
import { describe, expect, it } from "vitest";
import { createHost } from "../support/host";

describe("requireVerifiedEmail: false", () => {
  it("provisions an unverified user when the target allows it", async () => {
    const h = await createHost({ targets: [{ id: "app", requireVerifiedEmail: false }] });
    const u = await h.user("Unverified Person", false);
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ externalId: u.id, active: true })]);
  });

  it("still requires it by default", async () => {
    const h = await createHost();
    await h.user("Unverified Person", false);
    expect(h.app.users.size).toBe(0);
  });
});
