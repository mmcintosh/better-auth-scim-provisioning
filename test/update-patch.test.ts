// update: "patch" sends only our attributes, so what an admin set at the app survives; PUT
// (the default) replaces the whole user.
import { describe, expect, it } from "vitest";
import { createHost } from "./support/host";

describe("update mode", () => {
  for (const update of ["put", "patch"] as const) {
    it(`${update}: a rename ${update === "patch" ? "keeps" : "drops"} an attribute set at the app`, async () => {
      const h = await createHost({ targets: [{ id: "app", update, patch: true }] });
      const u = await h.user("Ada Lovelace");
      const at = [...h.app.users.values()][0] as unknown as Record<string, unknown>;
      at.title = "Analyst"; // set by an admin at the app
      await h.ctx.internalAdapter.updateUser(u.id, { name: "Ada King" });
      await h.settle();
      const now = [...h.app.users.values()][0] as unknown as Record<string, unknown>;
      expect(now).toMatchObject({ displayName: "Ada King", name: { givenName: "Ada", familyName: "King" }, active: true });
      expect(now.title).toBe(update === "patch" ? "Analyst" : undefined);
      expect(h.app.requests.filter((r) => r.path.startsWith("/Users/")).map((r) => r.method)).toEqual([update === "patch" ? "PATCH" : "PUT"]);
    });
  }

  it("patch: an account made by hand is adopted with a PATCH", async () => {
    const h = await createHost({ targets: [{ id: "app", update: "patch", patch: true }] });
    await h.app.fetch(`${h.app.url}/Users`, { method: "POST", headers: { authorization: `Bearer ${h.app.token}` }, body: JSON.stringify({ userName: "hand@example.com", title: "Kept", name: { givenName: "Hand", familyName: "Made" } }) });
    const u = await h.ctx.internalAdapter.createUser({ email: "hand@example.com", name: "Hand Made", emailVerified: true }, { method: "admin" });
    await h.settle();
    expect([...h.app.users.values()]).toEqual([expect.objectContaining({ externalId: u.id, title: "Kept", active: true })]);
  });
});
