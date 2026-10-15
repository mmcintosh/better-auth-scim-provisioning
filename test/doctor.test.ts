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
    "Enterprise User extension": null,
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

it("says whether the app advertises the Enterprise User extension, by its ResourceTypes or its Schemas; neither, and it can't tell", async () => {
  const result = async (discovery: NonNullable<Parameters<typeof mockScim>[0]>["discovery"]) => {
    const app = mockScim(discovery ? { discovery } : {});
    const r = (await checkScimTarget({ url: app.url, token: app.token, fetch: app.fetch })).find((x) => x.id === "enterprise-user")!;
    expect(app.users.size).toBe(0);
    return [r.ok, r.detail] as const;
  };
  expect(await result({ resourceTypes: true, enterprise: true })).toEqual([true, "listed by /ResourceTypes"]);
  expect(await result({ resourceTypes: true, enterprise: false })).toEqual([false, expect.stringContaining("not listed by /ResourceTypes")]);
  expect(await result({ schemas: true, enterprise: true })).toEqual([true, "listed by /Schemas"]);
  expect(await result({ schemas: true, enterprise: false })).toEqual([false, expect.stringContaining("not listed by /Schemas")]);
  expect(await result(undefined)).toEqual([null, expect.stringContaining("can't tell")]);
  // The result comes before the test user's, so a failed create still ends the list.
  const app = mockScim({ discovery: { resourceTypes: true, enterprise: true } });
  const ids = (await checkScimTarget({ url: app.url, token: app.token, fetch: app.fetch })).map((r) => r.id);
  expect(ids.slice(0, 3)).toEqual(["service-provider-config", "enterprise-user", "create"]);
});

it("discovery's odd answers: 401 on those endpoints, no User type, a bare array, only the schema by id", async () => {
  const result = async (app: ReturnType<typeof mockScim>, fetch = app.fetch) => {
    const r = (await checkScimTarget({ url: app.url, token: app.token, fetch })).find((x) => x.id === "enterprise-user")!;
    expect(app.users.size).toBe(0);
    return r;
  };
  // A token without the discovery scope: the statuses are said, and the rest of the check goes on.
  const plain = mockScim();
  const gated: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return /\/(ResourceTypes|Schemas)/.test(url) ? new Response(JSON.stringify({ detail: "no scope" }), { status: 401, headers: { "content-type": "application/scim+json" } }) : plain.fetch(input, init);
  };
  expect(await result(plain, gated)).toMatchObject({ ok: null, detail: expect.stringMatching(/\/ResourceTypes 401 no scope, \/Schemas 401 no scope/) });
  // /ResourceTypes without a User type, then /Schemas as a bare array listing the extension.
  expect(await result(mockScim({ discovery: { resourceTypes: true, noUserType: true, schemas: true, bare: true, enterprise: true } }))).toMatchObject({ ok: true, detail: "listed by /Schemas" });
  // /ResourceTypes without a User type and no /Schemas at all: what was seen.
  expect(await result(mockScim({ discovery: { resourceTypes: true, noUserType: true } }))).toMatchObject({ ok: null, detail: expect.stringMatching(/\/ResourceTypes answered without a User type, \/Schemas 404/) });
  // Only the schema by its id.
  expect(await result(mockScim({ discovery: { schemaById: true, enterprise: true } }))).toMatchObject({ ok: true, detail: "served at /Schemas/<its id>" });
});
