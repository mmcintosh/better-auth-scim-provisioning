// Found in the third review: a token with a line break (a multi-line paste) made fetch fail with
// "… is an invalid header value", repeating the header, secret and all, into logs, the stored
// lastError, scimProvisioningFailures, onFailure and the check CLI's output. Secrets with control
// characters are refused at startup now, and such an error never repeats the header.
import { expect, it } from "vitest";
import { checkScimTarget, scimProvisioning } from "../../src";
import { scimClient } from "../../src/scim-client";

const SECRET = "s3cr3t-part-one\nsecret-part-two";

it("a token, password, header value or webhook secret with a control character is refused at startup", () => {
  const scim = { id: "app", url: "https://app.example.com/scim/v2" };
  for (const target of [
    { ...scim, token: SECRET },
    { ...scim, auth: { type: "basic", username: "u", password: SECRET } },
    { ...scim, auth: { type: "header", name: "X-Key", value: SECRET } },
    { id: "hook", type: "webhook", url: "https://hooks.example.com/x", secret: `${"x".repeat(32)}\t` },
  ]) {
    expect(() => scimProvisioning({ targets: [target] as never })).toThrow(/control characters/);
  }
});

it("an invalid header never puts the secret in an error (client and check CLI)", async () => {
  const user = { schemas: [], userName: "a@example.com", active: true };
  const e = (await scimClient({ url: "https://scim.example/v2", token: SECRET }).create(user).catch((x: unknown) => x)) as Error;
  expect(e.message).toMatch(/invalid header value/);
  expect(e.message).not.toContain("secret-part-two");
  expect(e.message).not.toContain("s3cr3t");
  const results = await checkScimTarget({ url: "https://scim.example/v2", token: SECRET });
  expect(JSON.stringify(results)).not.toContain("s3cr3t");
});
