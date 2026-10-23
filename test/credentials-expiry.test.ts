// Credentials that expire: shown in the status (as configured, or a bearer JWT's own `exp`), and
// warned about before they do: at warn from 30 days out, at error and through onFailure from 7
// (or once past), once a day per target. A stored target's go with its credentials.
import { describe, expect, it, vi } from "vitest";
import type { DeliveryFailure } from "../src";
import { type Adapter, credentialsExpiry, outbox } from "../src/outbox";
import { createHost } from "./support/host";
import { mockScim } from "./support/mock-scim";

const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const jwt = (payload: Record<string, unknown>) => ["e30", btoa(JSON.stringify(payload)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), "c2ln"].join(".");
const logger = () => ({ warn: vi.fn(), error: vi.fn() });

describe("credentials that expire", () => {
  it("are read from credentialsExpireAt, or a bearer token that's a JWT", () => {
    const at = { id: "a", url: "https://app.example.com/scim/v2" };
    expect(credentialsExpiry({ ...at, token: "opaque", credentialsExpireAt: "2027-01-02T00:00:00Z" })?.toISOString()).toBe("2027-01-02T00:00:00.000Z");
    expect(credentialsExpiry({ ...at, token: jwt({ exp: 1_900_000_000 }) })?.toISOString()).toBe(new Date(1_900_000_000_000).toISOString());
    expect(credentialsExpiry({ ...at, auth: { type: "header", name: "Authorization", value: `Bearer ${jwt({ exp: 1_900_000_000 })}` } })?.getTime()).toBe(1_900_000_000_000);
    // Configured wins; a token that isn't a JWT, or has no exp, says nothing.
    expect(credentialsExpiry({ ...at, token: jwt({ exp: 1 }), credentialsExpireAt: new Date(5_000) })?.getTime()).toBe(5_000);
    expect(credentialsExpiry({ ...at, token: "a.b.c" })).toBeNull();
    expect(credentialsExpiry({ ...at, token: jwt({ sub: "x" }) })).toBeNull();
    expect(credentialsExpiry({ ...at, token: "opaque" })).toBeNull();
  });

  it("are warned about: from 30 days out at warn, from 7 at error and through onFailure, once a day", async () => {
    const h = await createHost();
    const app = mockScim();
    const onFailure = vi.fn<(f: DeliveryFailure) => void>();
    const log = logger();
    const t = (id: string, expires: Date) => ({ id, url: app.url, token: app.token, fetch: app.fetch, credentialsExpireAt: expires });
    const box = outbox({ targets: [t("later", days(90)), t("soon", days(20)), t("now", days(3)), t("gone", days(-1))], onFailure }, h.ctx.adapter as unknown as Adapter, log);
    await box.runDue();
    expect(log.warn.mock.calls.flat()).toEqual([expect.stringMatching(/soon: its credentials expire on .*, in 20 days/)]);
    expect(log.error.mock.calls.flat()).toEqual([expect.stringMatching(/now: its credentials expire on .*, in 3 days/), expect.stringMatching(/gone: its credentials expired on/)]);
    expect(onFailure.mock.calls.map(([f]) => [f.targetId, f.kind, f.failed])).toEqual([
      ["now", "credentials", false],
      ["gone", "credentials", true],
    ]);
    // Not again within the hour (nor the day).
    await box.runDue();
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect((await box.status(["now", "later"])).map((s) => s.credentialsExpireAt)).toEqual([days(3).toISOString().slice(0, 13), days(90).toISOString().slice(0, 13)].map((p) => expect.stringContaining(p)));
  });

  it("are shown in the status, and none is null", async () => {
    const h = await createHost();
    const { targets } = (await h.auth.api.scimProvisioningStatus({ body: {} })) as { targets: { credentialsExpireAt: string | null }[] };
    expect(targets[0]?.credentialsExpireAt).toBeNull();
  });

  it("an organization's target: set in its settings, shown in its status, and cleared with new credentials", async () => {
    const remote = mockScim();
    const h = await createHost({ targets: [], registry: { fetch: remote.fetch } });
    const up = await h.auth.api.signUpEmail({ body: { email: "olive@example.com", password: "correct-horse-battery", name: "Olive" } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    const res = await h.auth.api.signInEmail({ body: { email: "olive@example.com", password: "correct-horse-battery" }, asResponse: true });
    const headers = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
    const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers }))!;
    const settings = { url: "https://app.example.com/scim/v2", credentialsExpireAt: "2027-06-01T00:00:00Z" };
    const { target } = await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings, credentials: { token: remote.token } }, headers });
    const status = async () => ((await h.auth.api.scimProvisioningTargetStatus({ body: { id: target.id }, headers })) as unknown as { credentialsExpireAt: string | null }).credentialsExpireAt;
    expect(await status()).toBe("2027-06-01T00:00:00.000Z");
    const refused = await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings: { ...settings, credentialsExpireAt: "next june" }, credentials: { token: remote.token } }, headers }).catch((e: { body?: { issues?: string[] } }) => e.body?.issues);
    expect(refused).toEqual([expect.stringMatching(/^settings\.credentialsExpireAt: /)]);
    // New credentials: their own expiry, or none.
    await h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, credentials: { token: remote.token } }, headers });
    expect(await status()).toBeNull();
    await h.auth.api.scimProvisioningUpdateTarget({ body: { id: target.id, settings: { ...settings, credentialsExpireAt: "2028-01-01T00:00:00Z" }, credentials: { token: remote.token } }, headers });
    expect(await status()).toBe("2028-01-01T00:00:00.000Z");
  });

  it("must be a date", async () => {
    const { scimProvisioning } = await import("../src");
    expect(() => scimProvisioning({ targets: [{ id: "a", url: "https://app.example.com/scim/v2", token: "t", credentialsExpireAt: "soon" }] })).toThrow(/credentialsExpireAt/);
  });

  it("once a day per target: a later hour the same day says nothing new, the next day says it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-02T08:00:00Z"));
      const h = await createHost();
      const app = mockScim();
      const onFailure = vi.fn();
      const box = outbox({ targets: [{ id: "now", url: app.url, token: app.token, fetch: app.fetch, credentialsExpireAt: "2026-11-05T00:00:00Z" }], onFailure }, h.ctx.adapter as unknown as Adapter, logger());
      await box.runDue();
      vi.setSystemTime(new Date("2026-11-02T15:00:00Z"));
      await box.runDue();
      expect(onFailure).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date("2026-11-03T08:00:00Z"));
      await box.runDue();
      expect(onFailure).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("every process together alerts once a day, and a higher level the same day still goes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-02T08:00:00Z"));
      const h = await createHost();
      const app = mockScim();
      const onFailure = vi.fn<(f: DeliveryFailure) => void>();
      const log = logger();
      const boxOf = () => outbox({ targets: [{ id: "t", url: app.url, token: app.token, fetch: app.fetch, credentialsExpireAt: "2026-11-09T12:00:00Z" }], onFailure }, h.ctx.adapter as unknown as Adapter, log);
      // 7.2 days out: a warning, from one of two processes.
      await boxOf().runDue();
      await boxOf().runDue();
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(onFailure).not.toHaveBeenCalled();
      // The same day, 6.7 days out: the alert goes, once.
      vi.setSystemTime(new Date("2026-11-02T20:00:00Z"));
      await boxOf().runDue();
      await boxOf().runDue();
      expect(onFailure).toHaveBeenCalledTimes(1);
      // The marker is in no target's counts.
      expect((await boxOf().status(["t"]))[0]).toMatchObject({ queued: 0, waiting: 0, stuck: 0, failed: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a bearer token given as auth is read too; a stored target's JWT expiry is kept in its settings", async () => {
    expect(credentialsExpiry({ id: "a", url: "https://app.example.com/scim/v2", auth: { type: "bearer", token: jwt({ exp: 1_900_000_000 }) } })?.getTime()).toBe(1_900_000_000_000);
    const remote = mockScim();
    const h = await createHost({ targets: [], registry: { fetch: remote.fetch } });
    const up = await h.auth.api.signUpEmail({ body: { email: "olive@example.com", password: "correct-horse-battery", name: "Olive" } });
    await h.ctx.internalAdapter.updateUser(up.user.id, { emailVerified: true });
    const res = await h.auth.api.signInEmail({ body: { email: "olive@example.com", password: "correct-horse-battery" }, asResponse: true });
    const headers = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
    const acme = (await h.auth.api.createOrganization({ body: { name: "Acme", slug: "acme" }, headers }))!;
    const { target } = await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: jwt({ exp: 1_900_000_000 }) } }, headers });
    expect(target.settings).toMatchObject({ credentialsExpireAt: new Date(1_900_000_000_000).toISOString() });
    // Expiring soon: alerted, which notes it; removing the target removes the note.
    const soon = await h.auth.api.scimProvisioningCreateTarget({ body: { organizationId: acme.id, settings: { url: "https://app.example.com/scim/v2" }, credentials: { token: jwt({ exp: Math.floor(Date.now() / 1000) + 3 * 86_400 }) } }, headers });
    await h.auth.api.scimProvisioningRun({ body: {} });
    const marker = () => h.ctx.adapter.count({ model: "scimProvisioningJob", where: [{ field: "key", value: `${soon.target.id}:credentials:alert` }] });
    expect(await marker()).toBe(1);
    await h.auth.api.scimProvisioningDeleteTarget({ body: { id: soon.target.id }, headers });
    expect(await marker()).toBe(0);
    // A date alone is a date: midnight UTC.
    expect(credentialsExpiry({ id: "a", url: "https://app.example.com/scim/v2", token: "t", credentialsExpireAt: "2027-01-01" })?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
