// The photo (Better Auth's `image`) as SCIM `photos`, and the rest of RFC 7643 §4.1.1's
// single-valued attributes: nickName, profileUrl, and the middle name and honorifics in `name`.
// Each only when named; URLs only https; each cleared when empty, by path with PATCH.
import { describe, expect, it, vi } from "vitest";
import { scimProvisioning } from "../src";
import { createHost } from "./support/host";

const FIELDS = { nick: { type: "string" }, profile: { type: "string" }, middle: { type: "string" }, prefix: { type: "string" }, suffix: { type: "string" } } as const;
const NAMED = { photo: "image", nickName: "nick", profileUrl: "profile", middleName: "middle", honorificPrefix: "prefix", honorificSuffix: "suffix" };

async function setup(target: Record<string, unknown> = {}) {
  const h = await createHost({ targets: [{ id: "app", attributes: NAMED, ...target }], userFields: FIELDS });
  const set = async (id: string, fields: Record<string, unknown>) => {
    await h.ctx.internalAdapter.updateUser(id, fields);
    await h.settle();
  };
  const remote = (email: string) => [...h.app.users.values()].find((u) => u.userName === email) as any;
  const lastPatch = () => [...h.app.requests].reverse().find((r) => r.method === "PATCH" && r.path.startsWith("/Users/"))?.body as { Operations: { op: string; path?: string; value?: any }[] } | undefined;
  return { h, set, remote, lastPatch };
}

describe("the photo, nickName, profileUrl, and the middle name and honorifics", () => {
  it("are sent from the fields named, the name parts beside the given and family names", async () => {
    const { h, set, remote } = await setup();
    const ada = await h.user("Ada Lovelace");
    await set(ada.id, { image: "https://cdn.example.com/ada.png", nick: "Ada", profile: "https://example.com/u/ada", middle: "Augusta", prefix: "Countess", suffix: "FRS" });
    expect(remote(ada.email)).toMatchObject({
      photos: [{ value: "https://cdn.example.com/ada.png", type: "photo", primary: true }],
      nickName: "Ada",
      profileUrl: "https://example.com/u/ada",
      name: { givenName: "Ada", familyName: "Lovelace", middleName: "Augusta", honorificPrefix: "Countess", honorificSuffix: "FRS" },
    });
  });

  it("aren't read by true", async () => {
    const { h, set, remote } = await setup({ attributes: true });
    const ada = await h.user("Ada Lovelace");
    await set(ada.id, { image: "https://cdn.example.com/ada.png", nick: "Ada", middle: "Augusta" });
    expect(remote(ada.email)).not.toHaveProperty("photos");
    expect(remote(ada.email)).not.toHaveProperty("nickName");
    expect(remote(ada.email).name).not.toHaveProperty("middleName");
  });

  it("with PATCH: empty ones removed by path; a URL that isn't https left out and logged, the app's left as it was", async () => {
    const { h, set, remote, lastPatch } = await setup({ update: "patch", patch: true });
    const warn = vi.spyOn(h.ctx.logger, "warn");
    const ada = await h.user("Ada Lovelace");
    await set(ada.id, { image: "https://cdn.example.com/ada.png", nick: "Ada", profile: "https://example.com/u/ada", middle: "Augusta" });
    await set(ada.id, { image: "http://cdn.example.com/ada.png", profile: "javascript:alert(1)", nick: null, middle: null });
    const removes = lastPatch()?.Operations.filter((o) => o.op === "remove").map((o) => o.path);
    expect(removes?.sort()).toEqual(["name.honorificPrefix", "name.honorificSuffix", "name.middleName", "nickName"]);
    expect(remote(ada.email)).toMatchObject({ photos: [{ value: "https://cdn.example.com/ada.png" }], profileUrl: "https://example.com/u/ada" });
    expect(remote(ada.email)).not.toHaveProperty("nickName");
    expect(remote(ada.email).name).not.toHaveProperty("middleName");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/profileUrl, photo left out, not a valid value/);
    // Cleared: the photo too.
    await set(ada.id, { image: null });
    expect(lastPatch()?.Operations.filter((o) => o.op === "remove").map((o) => o.path)).toContain("photos");
    expect(remote(ada.email)).not.toHaveProperty("photos");
  });

  it("a mapUser's own take precedence", async () => {
    const h = await createHost({
      targets: [{ id: "app", attributes: NAMED, mapUser: (u) => ({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: u.email, externalId: u.id, active: true, name: { givenName: "A", familyName: "L", middleName: "M" }, nickName: "Mine", photos: [{ value: "https://mine.example.com/p.png" }] }) }],
      userFields: FIELDS,
    });
    const ada = await h.user("Ada Lovelace");
    await h.ctx.internalAdapter.updateUser(ada.id, { image: "https://cdn.example.com/ada.png", nick: "Ada", middle: "Augusta", prefix: "Countess" });
    await h.settle();
    expect([...h.app.users.values()][0]).toMatchObject({ nickName: "Mine", photos: [{ value: "https://mine.example.com/p.png" }], name: { middleName: "M", honorificPrefix: "Countess" } });
  });

  it("are checked by the option's schema", () => {
    expect(() => scimProvisioning({ targets: [{ id: "a", url: "https://app.example.com/scim/v2", token: "t", attributes: { photo: "image", nickname: "nick" } as never }] })).toThrow(/attributes/);
  });
});
