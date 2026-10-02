// checkScimTarget reports what an app supports, and always cleans up its test user. The mock app
// is a fair stand-in for a limited one: no ServiceProviderConfig, and PATCH only for `active`.
import { expect, it } from "vitest";
import { checkScimTarget } from "../src";
import { mockScim } from "./support/mock-scim";

it("reports what a limited app supports, and leaves nothing behind", async () => {
  const app = mockScim({ requireNames: true });
  const results = await checkScimTarget({ url: app.url, token: app.token, fetch: app.fetch });
  const ok = Object.fromEntries(results.map((r) => [r.name, r.ok]));
  expect(ok).toEqual({
    ServiceProviderConfig: null,
    "create a user": true,
    "keeps externalId": true,
    "find by userName": true,
    "find by userName, any case": true,
    "duplicate userName refused (409)": true,
    "update with PUT": true,
    "update with PATCH (no path)": false,
    "update with PATCH (path)": false,
    "deactivate (PATCH active false)": true,
    delete: true,
  });
  expect(app.users.size).toBe(0);
});

it("stops after a failed create, and says why", async () => {
  const app = mockScim({ requireNames: true });
  const results = await checkScimTarget({ url: app.url, token: "wrong", fetch: app.fetch });
  expect(results.at(-1)).toMatchObject({ name: "create a user", ok: false, detail: expect.stringContaining("401") });
});

it("an app that ignores externalId is reported", async () => {
  const app = mockScim({ keepsExternalId: false });
  const results = await checkScimTarget({ url: app.url, token: app.token, fetch: app.fetch });
  expect(results.find((r) => r.name === "keeps externalId")).toMatchObject({ ok: false, detail: expect.stringContaining("our own links") });
});
