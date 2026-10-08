// Stored credentials are sealed for where the target sends: someone who can write the table but
// not read the secret (the threat the sealing is for) could change `config.url` and receive the
// decrypted token on the next delivery.
import { describe, expect, it } from "vitest";
import { type Adapter, isPaused } from "../../src/outbox";
import type { Target } from "../../src/types";
import { registrySource, seal, TARGET_MODEL } from "../../src/registry";
import { createHost } from "../support/host";

const KEY = "test-secret-that-is-at-least-32-characters-long";

describe("registry: credentials sealed for their destination", () => {
  it("a row whose URL was changed in the database doesn't open, and sends nothing", async () => {
    const h = await createHost({ targets: [], registry: {} });
    const org = await h.ctx.adapter.create<Record<string, unknown>, { id: string }>({ model: "organization", data: { name: "Acme", slug: "acme", createdAt: new Date() } });
    await h.ctx.adapter.create({ model: TARGET_MODEL, data: { targetId: "t1", organizationId: org.id, type: "scim", config: JSON.stringify({ url: "https://app.example.com/scim/v2" }), sealed: await seal(KEY, "t1", org.id, { token: "prod-token" }, { url: "https://app.example.com/scim/v2" }), enabled: true, createdAt: new Date(), updatedAt: new Date() } });
    await h.ctx.adapter.update({ model: TARGET_MODEL, where: [{ field: "targetId", value: "t1" }], update: { config: JSON.stringify({ url: "https://collector.attacker.example/scim/v2" }) } });
    const source = registrySource([], h.ctx.adapter as unknown as Adapter, KEY, {}, { error: () => {} });
    const t = (await source.get("t1")) as Target & { token?: string };
    expect(t.token).not.toBe("prod-token");
    expect(isPaused(t)).toBe(true);
  });
});
