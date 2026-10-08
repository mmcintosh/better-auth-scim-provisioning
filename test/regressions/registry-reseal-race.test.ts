// During a secret rotation, a stored target's credentials are sealed again with the current
// secret only if they're still the ones read: an administrator's new credentials saved meanwhile
// were overwritten with the old (perhaps leaked) ones.
import { describe, expect, it } from "vitest";
import type { Adapter } from "../../src/outbox";
import { registrySource, seal, TARGET_MODEL, unseal } from "../../src/registry";
import { createHost } from "../support/host";

const OLD = "old-secret-that-is-at-least-32-characters-long";
const NEW = "new-secret-that-is-at-least-32-characters-long";

describe("registry: sealing again after a rotation", () => {
  it("keeps credentials saved meanwhile", async () => {
    const h = await createHost({ targets: [], registry: {} });
    const old = { keys: new Map([[1, OLD]]), currentVersion: 1 };
    const rotated = { keys: new Map([[2, NEW], [1, OLD]]), currentVersion: 2 };
    const org = await h.ctx.adapter.create<Record<string, unknown>, { id: string }>({ model: "organization", data: { name: "Acme", slug: "acme", createdAt: new Date() } });
    await h.ctx.adapter.create({ model: TARGET_MODEL, data: { targetId: "t1", organizationId: org.id, type: "scim", config: JSON.stringify({ url: "https://app.example.com/scim/v2" }), sealed: await seal(old, "t1", org.id, { token: "leaked-old-token" }, { url: "https://app.example.com/scim/v2" }), enabled: true, createdAt: new Date(), updatedAt: new Date() } });
    const real = h.ctx.adapter as unknown as Adapter;
    // The re-seal's write, delayed by one step: the administrator's update lands first (as the
    // update endpoint writes it: sealed with the current key).
    const adapter: Adapter = {
      create: (a) => real.create(a),
      findOne: (a) => real.findOne(a),
      findMany: (a) => real.findMany(a),
      updateMany: async (a) => {
        if (a.model === TARGET_MODEL && "sealed" in a.update) {
          await real.update({ model: TARGET_MODEL, where: [{ field: "targetId", value: "t1" }], update: { sealed: await seal(rotated, "t1", org.id, { token: "fresh-rotated-token" }, { url: "https://app.example.com/scim/v2" }), updatedAt: new Date() } });
        }
        return real.updateMany(a);
      },
      deleteMany: (a) => real.deleteMany(a),
      count: (a) => real.count(a),
      update: async (a) => {
        if (a.model === TARGET_MODEL && "sealed" in a.update) {
          await real.update({ model: TARGET_MODEL, where: [{ field: "targetId", value: "t1" }], update: { sealed: await seal(rotated, "t1", org.id, { token: "fresh-rotated-token" }, { url: "https://app.example.com/scim/v2" }), updatedAt: new Date() } });
        }
        return real.update(a);
      },
    } as Adapter;
    const source = registrySource([], adapter, rotated, {}, { error: () => {} });
    await source.get("t1");
    const [row] = (await real.findMany({ model: TARGET_MODEL })) as { targetId: string; organizationId: string; sealed: string; config: string }[];
    expect(await unseal(rotated, row!)).toEqual({ token: "fresh-rotated-token" });
  });
});
