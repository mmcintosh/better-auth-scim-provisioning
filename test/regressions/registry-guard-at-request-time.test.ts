// A stored target's every request is checked against the URL rules when it's made: IP literals
// skipped the lookup and went straight out, and a row allowed once (an allowHosts entry since
// removed, a row restored from another environment) kept reaching private addresses.
import { describe, expect, it } from "vitest";
import { guardedFetch } from "../../src/registry";

describe("registry: the URL rules at request time", () => {
  it.each(["https://10.0.0.5/scim/v2/Users", "https://169.254.169.254/latest/meta-data", "https://[fd00::1]/scim/v2/Users", "https://127.0.0.1:8443/scim"])("%s is refused at request time", async (url) => {
    const seen: string[] = [];
    const inner = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("{}");
    }) as typeof fetch;
    await guardedFetch([], inner)(url).catch(() => {});
    expect(seen).toEqual([]);
  });
});
