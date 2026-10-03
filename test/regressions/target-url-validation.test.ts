// The target URL check could be fooled (`http://localhost:80@evil.example`
// sent the token in cleartext to evil.example), accepted query strings that broke every path, and
// fetch followed redirects, replaying the bearer token and request body to wherever they pointed.
import { describe, expect, it } from "vitest";
import { scimProvisioning } from "../../src";
import { ScimError, scimClient } from "../../src/scim-client";

const target = (url: string) => () => scimProvisioning({ targets: [{ id: "a", url, token: "t" }] });

describe("target URLs", () => {
  it("refuses credentials, queries, fragments and non-loopback http", () => {
    expect(target("http://localhost:80@evil.example/scim/v2")).toThrow(/url/);
    expect(target("https://user:pw@scim.example/scim/v2")).toThrow(/url/);
    expect(target("https://scim.example/scim/v2?t=1")).toThrow(/url/);
    expect(target("https://scim.example/scim/v2#x")).toThrow(/url/);
    expect(target("http://scim.example/scim/v2")).toThrow(/url/);
  });

  it("still takes https and loopback http", () => {
    expect(target("https://scim.example/tenant/scim/v2")).not.toThrow();
    expect(target("http://localhost:8787/scim/v2")).not.toThrow();
    expect(target("http://127.0.0.1/scim/v2")).not.toThrow();
    expect(target("http://[::1]:9000/scim/v2")).not.toThrow();
  });

  it("never follows a redirect", async () => {
    let redirect: RequestRedirect | undefined;
    const client = scimClient({
      url: "https://scim.example/scim/v2",
      token: "t",
      fetch: async (_i, init) => {
        redirect = init?.redirect;
        return new Response(null, { status: 307, headers: { location: "https://elsewhere.example/scim/v2/Users" } });
      },
    });
    const e = await client.create({ schemas: [], userName: "a@example.com", active: true }).catch((x: unknown) => x);
    expect(redirect).toBe("manual");
    expect(e).toBeInstanceOf(ScimError);
    // Not followed, and retried: a passing redirect (maintenance) clears, and a wrong URL is the host's to fix.
    expect(e).toMatchObject({ status: 307, retryable: true, message: expect.stringContaining("elsewhere.example") });
  });
});
