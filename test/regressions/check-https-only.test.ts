// checkScimTarget (and the CLI) sent the token to any URL, plain http included, although the
// plugin itself only allows https (or loopback http).
import { expect, it } from "vitest";
import { checkScimTarget } from "../../src";

it("refuses a plain-http URL without sending anything", async () => {
  let sent = 0;
  const fetch: typeof globalThis.fetch = async () => {
    sent++;
    return new Response("{}", { status: 200 });
  };
  await expect(checkScimTarget({ url: "http://scim.example.com/scim/v2", token: "secret-token", fetch })).rejects.toThrow(/https/);
  expect(sent).toBe(0);
});
