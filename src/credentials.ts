// How a target's requests are authorised: a bearer token (most SCIM apps), Basic, a header of the
// app's own (an API key), or OAuth 2.0 client credentials (Salesforce, Zoom, Microsoft Graph…),
// whose access tokens are fetched, cached per isolate, and refreshed before they expire.
import { ScimError } from "./scim-client";

export type ScimAuth =
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "header"; name: string; value: string }
  | {
      type: "oauth2";
      /** The token endpoint (https). */
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scope?: string | undefined;
      /** How the client authenticates to the token endpoint: form fields (default) or Basic. */
      clientAuth?: "body" | "basic" | undefined;
      /** Extra form fields, e.g. Zoom's `{ grant_type: "account_credentials", account_id }`. */
      params?: Record<string, string> | undefined;
    }
  | {
      /**
       * A Google service account with domain-wide delegation (Google Workspace): a JWT signed with
       * its key is exchanged for an access token acting as `subject`, a Workspace admin.
       */
      type: "google";
      clientEmail: string;
      /** The service account's private key (PEM, PKCS #8), as in its JSON key file. */
      privateKey: string;
      subject: string;
      scopes: string[];
      /** For tests; default Google's token endpoint. */
      tokenUrl?: string | undefined;
    };

export interface Credentials {
  /** Headers to send with each request. */
  headers(): Promise<Record<string, string>>;
  /** The app refused them (401): forget a cached token, so the next call fetches a new one. Whether a retry can help. */
  rejected(): boolean;
}

/**
 * OAuth access tokens that have arrived, per token endpoint and client, shared by every request in
 * this isolate. Only arrived ones: on Workers, a fetch started by a request that has ended is
 * cancelled, so a later request waiting on that fetch would wait for ever.
 */
const tokens = new Map<string, { token: string; renewAt: number }>();
/**
 * Renew a minute before a token expires (or halfway, for short-lived ones), so a request never
 * goes out with one about to lapse.
 */
const renewAt = (lifetimeMs: number) => Date.now() + lifetimeMs - Math.min(60_000, lifetimeMs / 2);

export function credentials(auth: ScimAuth, o: { fetch?: typeof fetch | undefined; timeoutMs?: number | undefined } = {}): Credentials {
  switch (auth.type) {
    case "bearer":
      return { headers: async () => ({ authorization: `Bearer ${auth.token}` }), rejected: () => false };
    case "basic":
      return { headers: async () => ({ authorization: `Basic ${base64(`${auth.username}:${auth.password}`)}` }), rejected: () => false };
    case "header":
      return { headers: async () => ({ [auth.name.toLowerCase()]: auth.value }), rejected: () => false };
    case "oauth2":
    case "google": {
      const key =
        auth.type === "oauth2"
          ? `${auth.tokenUrl}\n${auth.clientId}\n${auth.clientSecret}\n${auth.scope ?? ""}\n${JSON.stringify(auth.params ?? {})}`
          : `google\n${auth.tokenUrl ?? ""}\n${auth.clientEmail}\n${auth.privateKey}\n${auth.subject}\n${auth.scopes.join(" ")}`;
      // The secret is part of the key: after it's rotated, a token from the old one isn't reused.
      // A fetch in progress is shared only by this client's calls: one delivery, one request.
      let inFlight: Promise<string> | null = null;
      return {
        async headers() {
          const cached = tokens.get(key);
          if (cached && cached.renewAt > Date.now()) return { authorization: `Bearer ${cached.token}` };
          if (!inFlight) {
            inFlight = (auth.type === "oauth2" ? fetchToken(auth, o) : fetchGoogleToken(auth, o)).then(
              (t) => {
                tokens.set(key, { token: t.token, renewAt: renewAt(t.lifetimeMs) });
                inFlight = null;
                return t.token;
              },
              (e) => {
                // A failure isn't kept: the next call asks again.
                inFlight = null;
                throw e;
              },
            );
          }
          return { authorization: `Bearer ${await inFlight}` };
        },
        rejected() {
          tokens.delete(key);
          return true;
        },
      };
    }
  }
}

async function fetchToken(auth: Extract<ScimAuth, { type: "oauth2" }>, o: { fetch?: typeof fetch | undefined; timeoutMs?: number | undefined }) {
  const form = new URLSearchParams({ grant_type: "client_credentials", ...(auth.scope ? { scope: auth.scope } : {}), ...(auth.params ?? {}) });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (auth.clientAuth === "basic") headers.authorization = `Basic ${base64(`${encodeURIComponent(auth.clientId)}:${encodeURIComponent(auth.clientSecret)}`)}`;
  else {
    form.set("client_id", auth.clientId);
    form.set("client_secret", auth.clientSecret);
  }
  return requestToken(auth.tokenUrl, headers, form, o, "the target's OAuth client");
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** A JWT signed with the service account's key, exchanged for a token acting as `subject`. */
async function fetchGoogleToken(auth: Extract<ScimAuth, { type: "google" }>, o: { fetch?: typeof fetch | undefined; timeoutMs?: number | undefined }) {
  const tokenUrl = auth.tokenUrl ?? GOOGLE_TOKEN_URL;
  const now = Math.floor(Date.now() / 1000);
  const encode = (v: unknown) => base64url(new TextEncoder().encode(JSON.stringify(v)));
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: auth.clientEmail, sub: auth.subject, scope: auth.scopes.join(" "), aud: tokenUrl, iat: now, exp: now + 3600 })}`;
  let key: CryptoKey;
  try {
    const der = Uint8Array.from(atob(auth.privateKey.replace(/-----(BEGIN|END) PRIVATE KEY-----|\\n|\s/g, "")), (c) => c.charCodeAt(0));
    key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new ScimError("google: the service account's private key can't be read (a PKCS #8 PEM, as in its JSON key file)", null, false);
  }
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const form = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${base64url(signature)}` });
  return requestToken(tokenUrl, { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, form, o, `the service account, and that its domain-wide delegation allows ${auth.scopes.join(", ")}`);
}

async function requestToken(tokenUrl: string, headers: Record<string, string>, form: URLSearchParams, o: { fetch?: typeof fetch | undefined; timeoutMs?: number | undefined }, check: string) {
  const host = new URL(tokenUrl).host;
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(tokenUrl, { method: "POST", headers, body: form.toString(), redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
  } catch (e) {
    throw new ScimError(`token request to ${host}: ${(e as Error).name === "TimeoutError" ? "no response" : (e as Error).message}`, null, true);
  }
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; token_type?: unknown; error?: unknown } | null;
  if (!res.ok || typeof json?.access_token !== "string" || !json.access_token) {
    // The error code only: never the response body, which could echo credentials.
    const code = typeof json?.error === "string" ? ` ${json.error.slice(0, 100)}` : "";
    // A refused client is the host's configuration, like a bad token: retried until fixed.
    throw new ScimError(`token request to ${host}: ${res.status}${code} (check ${check})`, res.status, true);
  }
  if (typeof json.token_type === "string" && json.token_type.toLowerCase() !== "bearer")
    throw new ScimError(`token request to ${host}: token_type ${json.token_type.slice(0, 40)}, not Bearer`, null, false);
  const lifetimeMs = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in * 1000 : 3_600_000;
  return { token: json.access_token, lifetimeMs };
}

const base64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** For tests: forget every cached token. */
export const forgetTokens = () => tokens.clear();
