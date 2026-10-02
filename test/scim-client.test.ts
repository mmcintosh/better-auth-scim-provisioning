import { describe, expect, it } from "vitest";
import { retryAfterMs, SCIM_USER_SCHEMA, ScimError, scimClient, type ScimUser } from "../src/scim-client";
import { mockScim } from "./support/mock-scim";

const ada: ScimUser = {
  schemas: [SCIM_USER_SCHEMA],
  externalId: "user-1",
  userName: "ada@example.com",
  name: { givenName: "Ada", familyName: "Lovelace" },
  displayName: "Ada Lovelace",
  emails: [{ value: "ada@example.com", primary: true }],
  active: true,
};

const setup = (o: Parameters<typeof mockScim>[0] = {}, timeoutMs?: number) => {
  const sp = mockScim(o);
  return { sp, client: scimClient({ url: sp.url, token: sp.token, fetch: sp.fetch, ...(timeoutMs ? { timeoutMs } : {}) }) };
};

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ScimError);
    return e as ScimError;
  }
  throw new Error("expected a ScimError");
};

describe("scimClient", () => {
  it("creates, finds, replaces, deactivates and deletes a user", async () => {
    const { sp, client } = setup({ requireNames: true });
    const id = await client.create(ada);
    expect(await client.findByUserName("ADA@example.com")).toEqual({ id, externalId: "user-1" }); // case-insensitive, as SCIM
    await client.replace(id, { ...ada, displayName: "Countess of Lovelace" });
    expect(sp.users.get(id)?.displayName).toBe("Countess of Lovelace");
    await client.setActive(id, false);
    expect(sp.users.get(id)?.active).toBe(false);
    await client.remove(id);
    expect(sp.users.size).toBe(0);
    // Already gone: a 404, left to the caller, which asks the app's list before believing it.
    await expect(client.remove(id)).rejects.toMatchObject({ status: 404 });
    expect(await client.findByUserName(ada.userName)).toBeNull();
  });

  it("sends the bearer token and SCIM media type", async () => {
    const { client } = setup();
    const bad = scimClient({ url: mockScim().url, token: "wrong", fetch: mockScim().fetch });
    expect(await failure(bad.create(ada))).toMatchObject({ status: 401, retryable: true, message: expect.stringContaining("check the target's token") });
    await expect(client.create(ada)).resolves.toMatch(/^u\d+$/);
  });

  it("escapes the filter value", async () => {
    const { sp, client } = setup();
    const tricky = 'a"b\\c@example.com';
    const id = await client.create({ ...ada, userName: tricky });
    expect((await client.findByUserName(tricky))?.id).toBe(id);
    expect(sp.requests.at(-1)?.path).toContain(encodeURIComponent('userName eq "a\\"b\\\\c@example.com"'));
  });

  it("classifies failures: 4xx won't fix itself; 429, 5xx, timeouts will, with Retry-After", async () => {
    const { sp, client } = setup({ requireNames: true });
    const invalid = await failure(client.create({ ...ada, name: { givenName: "Ada" } }));
    expect(invalid).toMatchObject({ status: 400, retryable: false, scimType: "invalidValue" });

    await client.create(ada);
    expect(await failure(client.create(ada))).toMatchObject({ status: 409, retryable: false, scimType: "uniqueness" });

    sp.fail({ status: 429, retryAfter: "7" });
    expect(await failure(client.findByUserName("x@example.com"))).toMatchObject({ status: 429, retryable: true, retryAfterMs: 7000 });
    sp.fail({ status: 503 });
    expect(await failure(client.findByUserName("x@example.com"))).toMatchObject({ status: 503, retryable: true });
  });

  it("gives up on a silent service after timeoutMs, as retryable", async () => {
    const { sp, client } = setup({}, 50);
    sp.fail({ timeout: true });
    const e = await failure(client.findByUserName("x@example.com"));
    expect(e).toMatchObject({ status: null, retryable: true });
    expect(e.message).toContain("no response within 50 ms");
  });

  it("reads Retry-After as seconds or a date", () => {
    expect(retryAfterMs("12")).toBe(12_000);
    expect(retryAfterMs(new Date(1_000_000 + 5_000).toUTCString(), 1_000_000)).toBe(5_000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
  });
});

it("trims trailing slashes quickly, even a long run of them", async () => {
  const { trimSlashes } = await import("../src/scim-client");
  expect(trimSlashes("https://x.test/scim/v2///")).toBe("https://x.test/scim/v2");
  const started = performance.now();
  expect(trimSlashes(`https://x.test${"/".repeat(100_000)}a`)).toBe(`https://x.test${"/".repeat(100_000)}a`);
  expect(performance.now() - started).toBeLessThan(100);
});
