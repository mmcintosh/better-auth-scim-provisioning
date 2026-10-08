// With a registry, many organizations' targets share one delivery queue: a scheduled run gives no
// target more than half its batch while others' jobs are due, stored targets wait at most 30 s for
// an answer, and an organization's target is queued only for its own organization's teams.
import { describe, expect, it } from "vitest";
import { type Adapter, outbox, staticTargets } from "../../src/outbox";
import { storedSettingsSchema } from "../../src/registry";
import type { Target } from "../../src/types";
import { createHost } from "../support/host";
import { mockScim } from "../support/mock-scim";

describe("registry: sharing the queue", () => {
  it("one target with most of what's due takes at most half a run; the others' go too", async () => {
    const h = await createHost({ targets: [] });
    const busy = mockScim();
    const quiet = mockScim();
    const targets: Target[] = [
      { id: "busy", type: "scim", url: busy.url, token: busy.token, fetch: busy.fetch },
      { id: "quiet", type: "scim", url: quiet.url, token: quiet.token, fetch: quiet.fetch },
    ];
    const adapter = h.ctx.adapter as unknown as Adapter;
    const box = outbox({ targets }, adapter, { warn: () => {}, error: () => {} }, staticTargets(targets));
    for (let i = 0; i < 12; i++) {
      const u = await h.user(`Busy ${i}`);
      await box.enqueue("busy", u.id);
    }
    // Queued last, so oldest-first alone would leave them out of a batch of 4.
    for (let i = 0; i < 2; i++) {
      const u = await h.user(`Quiet ${i}`);
      await box.enqueue("quiet", u.id);
    }
    await box.runDue(4);
    expect(quiet.users.size).toBe(2);
    expect(busy.users.size).toBe(2);
    // Alone, a target fills the batch.
    await box.runDue(4);
    expect(busy.users.size).toBe(6);
  });

  it("a stored target's timeoutMs is at most 30 s", () => {
    expect(storedSettingsSchema.safeParse({ timeoutMs: 30_000 }).success).toBe(true);
    expect(storedSettingsSchema.safeParse({ timeoutMs: 30_001 }).success).toBe(false);
  });

  it("an organization's target is queued for that organization's teams only", async () => {
    const h = await createHost({ targets: [] });
    const adapter = h.ctx.adapter as unknown as Adapter;
    const org = (name: string) => h.ctx.adapter.create<Record<string, unknown>, { id: string }>({ model: "organization", data: { name, slug: name.toLowerCase(), createdAt: new Date() } });
    const acme = await org("Acme");
    const globex = await org("Globex");
    const ada = await h.user("Ada Lovelace");
    const team = async (organizationId: string, name: string) => {
      const t = await h.ctx.adapter.create<Record<string, unknown>, { id: string }>({ model: "team", data: { name, organizationId, createdAt: new Date() } });
      await h.ctx.adapter.create({ model: "teamMember", data: { teamId: t.id, userId: ada.id, createdAt: new Date() } });
      return t;
    };
    const mine = await team(acme.id, "Acme team");
    await team(globex.id, "Globex team");
    const remote = mockScim();
    const target: Target = { id: "acme-app", type: "scim", url: remote.url, token: remote.token, fetch: remote.fetch, organizationId: acme.id, teamGroups: true };
    const box = outbox({ targets: [target] }, adapter, { warn: () => {}, error: () => {} }, staticTargets([target]));
    expect(await box.groupsOf(target, ada.id)).toEqual([{ kind: "team", id: mine.id }]);
    // A target for every organization still has both.
    const all: Target = { ...target, id: "all", organizationId: undefined };
    expect((await box.groupsOf(all, ada.id)).map((r) => r.id).sort()).toHaveLength(2);
  });
});
