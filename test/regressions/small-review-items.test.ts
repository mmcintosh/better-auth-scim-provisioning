// Small things found in review: an OAuth token kept being used after its client secret was
// rotated (the token cache didn't know the secret); and the `check` command said nothing about
// the test user when the app's create answered oddly, though the app may have made it.
import { afterEach, expect, it } from "vitest";
import { checkScimTarget } from "../../src";
import { forgetTokens } from "../../src/credentials";
import { scimClient } from "../../src/scim-client";

afterEach(() => forgetTokens());

it("a rotated client secret gets a new token, not the cached one", async () => {
  const tokenRequests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input) === "https://login.example/token") {
      tokenRequests.push(new URLSearchParams(String(init?.body)).get("client_secret") ?? "");
      return new Response(JSON.stringify({ access_token: `t${tokenRequests.length}`, token_type: "Bearer", expires_in: 3600 }));
    }
    return new Response(JSON.stringify({ id: "u1" }), { status: 201 });
  };
  const oauth = { type: "oauth2" as const, tokenUrl: "https://login.example/token", clientId: "client", scope: "scim" };
  const user = { schemas: [], userName: "a@example.com", active: true };
  await scimClient({ url: "https://scim.example/v2", auth: { ...oauth, clientSecret: "old-secret" }, fetch }).create(user);
  await scimClient({ url: "https://scim.example/v2", auth: { ...oauth, clientSecret: "new-secret" }, fetch }).create(user);
  expect(tokenRequests).toEqual(["old-secret", "new-secret"]);
});

it("check says to remove the test user by hand when the create answered without an id", async () => {
  const fetch: typeof globalThis.fetch = async (input, init) =>
    init?.method === "POST" && String(input).endsWith("/Users") ? new Response(JSON.stringify({ userName: "x" }), { status: 201 }) : new Response("{}", { status: 404 });
  const results = await checkScimTarget({ url: "https://scim.example/v2", token: "t", fetch, userName: "check@example.com" });
  const create = results.find((r) => r.name === "create a user");
  expect(create?.ok).toBe(false);
  expect(create?.detail).toMatch(/201 without an id.*remove the test user check@example\.com/);
});
