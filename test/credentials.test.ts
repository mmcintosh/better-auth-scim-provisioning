// Auth methods per target: bearer, Basic, an app's own header, and OAuth 2.0 client credentials
// (tokens fetched once, shared, renewed before expiry, and replaced when the app rejects one).
import { afterEach, describe, expect, it } from "vitest";
import { scimProvisioning } from "../src";
import { forgetTokens } from "../src/credentials";
import { ScimError, scimClient } from "../src/scim-client";
import { createHost } from "./support/host";

afterEach(() => forgetTokens());

const user = { schemas: [], userName: "a@example.com", active: true };

/** A SCIM app that records each request's headers, plus a token endpoint issuing numbered tokens. */
function app(o: { expiresIn?: number; accept?: (auth: string | undefined) => boolean; tokenStatus?: number } = {}) {
  const seen: Record<string, string>[] = [];
  const tokenRequests: { headers: Record<string, string>; body: URLSearchParams }[] = [];
  let issued = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url === "https://login.example/token") {
      tokenRequests.push({ headers, body: new URLSearchParams(String(init?.body)) });
      if (o.tokenStatus) return new Response(JSON.stringify({ error: "invalid_client", error_description: "secret s3cr3t is wrong" }), { status: o.tokenStatus });
      return new Response(JSON.stringify({ access_token: `t${++issued}`, token_type: "Bearer", ...(o.expiresIn ? { expires_in: o.expiresIn } : {}) }));
    }
    seen.push(headers);
    if (o.accept && !o.accept(headers.authorization)) return new Response(null, { status: 401 });
    return new Response(JSON.stringify({ id: "u1" }), { status: 201 });
  };
  return { fetch, seen, tokenRequests };
}

const oauth = { type: "oauth2" as const, tokenUrl: "https://login.example/token", clientId: "client", clientSecret: "s3cr3t", scope: "scim" };

describe("auth methods", () => {
  it("bearer, Basic and a header of the app's own", async () => {
    const a = app();
    await scimClient({ url: "https://scim.example/v2", token: "tok", fetch: a.fetch }).create(user);
    await scimClient({ url: "https://scim.example/v2", auth: { type: "basic", username: "u", password: "p:w" }, fetch: a.fetch }).create(user);
    await scimClient({ url: "https://scim.example/v2", auth: { type: "header", name: "X-Api-Key", value: "k" }, fetch: a.fetch }).create(user);
    expect(a.seen.map((h) => h.authorization ?? h["x-api-key"])).toEqual(["Bearer tok", `Basic ${btoa("u:p:w")}`, "k"]);
  });

  it("OAuth: one token request, shared by every call, with the client in the form", async () => {
    const a = app({ expiresIn: 3600 });
    const client = scimClient({ url: "https://scim.example/v2", auth: oauth, fetch: a.fetch });
    await Promise.all([client.create(user), client.create(user), client.create(user)]);
    expect(a.tokenRequests).toHaveLength(1);
    expect(Object.fromEntries(a.tokenRequests[0]!.body)).toEqual({ grant_type: "client_credentials", scope: "scim", client_id: "client", client_secret: "s3cr3t" });
    expect(a.seen.map((h) => h.authorization)).toEqual(["Bearer t1", "Bearer t1", "Bearer t1"]);
  });

  it("OAuth: Basic client authentication, and extra fields (Zoom's account_credentials)", async () => {
    const a = app();
    await scimClient({ url: "https://scim.example/v2", auth: { ...oauth, clientAuth: "basic", params: { grant_type: "account_credentials", account_id: "acc" } }, fetch: a.fetch }).create(user);
    const req = a.tokenRequests[0]!;
    expect(req.headers.authorization).toBe(`Basic ${btoa("client:s3cr3t")}`);
    expect(Object.fromEntries(req.body)).toEqual({ grant_type: "account_credentials", scope: "scim", account_id: "acc" });
  });

  it("OAuth: renewed before it expires", async () => {
    const a = app({ expiresIn: 1 }); // renewed halfway through its one second
    const client = scimClient({ url: "https://scim.example/v2", auth: oauth, fetch: a.fetch });
    await client.create(user);
    await new Promise((r) => setTimeout(r, 600));
    await client.create(user);
    expect(a.seen.map((h) => h.authorization)).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("OAuth: a token the app rejects is replaced, once", async () => {
    const a = app({ expiresIn: 3600, accept: (auth) => auth !== "Bearer t1" });
    await scimClient({ url: "https://scim.example/v2", auth: oauth, fetch: a.fetch }).create(user);
    expect(a.seen.map((h) => h.authorization)).toEqual(["Bearer t1", "Bearer t2"]);
    const never = app({ accept: () => false });
    forgetTokens();
    const e = await scimClient({ url: "https://scim.example/v2", auth: oauth, fetch: never.fetch }).create(user).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 401, retryable: true });
    expect(never.tokenRequests).toHaveLength(2);
  });

  it("OAuth: a refused client is a retryable error that names the error code, never the secret", async () => {
    const a = app({ tokenStatus: 401 });
    const e = (await scimClient({ url: "https://scim.example/v2", auth: oauth, fetch: a.fetch }).create(user).catch((x: unknown) => x)) as ScimError;
    expect(e).toBeInstanceOf(ScimError);
    expect(e).toMatchObject({ status: 401, retryable: true });
    expect(e.message).toContain("invalid_client");
    expect(e.message).not.toContain("s3cr3t");
    // Not cached: the next call asks again.
    await scimClient({ url: "https://scim.example/v2", auth: oauth, fetch: a.fetch }).create(user).catch(() => {});
    expect(a.tokenRequests).toHaveLength(2);
  });
});

describe("auth options", () => {
  const target = (t: object) => () => scimProvisioning({ targets: [{ id: "a", url: "https://scim.example/v2", ...t } as never] });
  it("takes exactly one of token and auth", () => {
    expect(target({ token: "t" })).not.toThrow();
    expect(target({ auth: oauth })).not.toThrow();
    expect(target({})).toThrow(/token or auth/);
    expect(target({ token: "t", auth: oauth })).toThrow(/token or auth/);
  });
  it("checks the token URL like a target URL", () => {
    expect(target({ auth: { ...oauth, tokenUrl: "http://login.example/token" } })).toThrow(/tokenUrl/);
  });
});

it("provisions through an OAuth target end to end", async () => {
  const h = await createHost();
  forgetTokens();
  // The mock app accepts its own token; the token endpoint hands it out.
  const fetch: typeof globalThis.fetch = async (input, init) =>
    String(input) === "https://login.example/token" ? new Response(JSON.stringify({ access_token: h.app.token, token_type: "bearer", expires_in: 3600 })) : h.app.fetch(input, init);
  const { outbox } = await import("../src/outbox");
  const box = outbox({ targets: [{ id: "app", url: h.app.url, auth: oauth, fetch }] }, h.ctx.adapter as never, { warn() {}, error() {} });
  const u = await h.ctx.internalAdapter.createUser({ email: "oauth@example.com", name: "Oauth Person", emailVerified: true }, { method: "admin" });
  await h.settle(); // the host's own (bearer) target delivers it first: start over without it
  h.app.users.clear();
  await h.ctx.adapter.deleteMany({ model: "scimProvisioningLink", where: [] });
  await box.enqueue("app", u.id);
  expect(await box.runFor("app", u.id)).toBe("done");
  expect([...h.app.users.values()]).toEqual([expect.objectContaining({ userName: "oauth@example.com" })]);
});
