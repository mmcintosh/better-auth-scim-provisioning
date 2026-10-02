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
    };

export interface Credentials {
  /** Headers to send with each request. */
  headers(): Promise<Record<string, string>>;
  /** The app refused them (401): forget a cached token, so the next call fetches a new one. Whether a retry can help. */
  rejected(): boolean;
}

/** OAuth access tokens, per token endpoint and client, shared by every request in this isolate. */
const tokens = new Map<string, { token: Promise<string>; renewAt: number }>();
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
    case "oauth2": {
      const key = `${auth.tokenUrl}\n${auth.clientId}\n${auth.scope ?? ""}\n${JSON.stringify(auth.params ?? {})}`;
      return {
        async headers() {
          let cached = tokens.get(key);
          if (!cached || cached.renewAt <= Date.now()) {
            const fetched = fetchToken(auth, o);
            // Until it arrives, everyone waits for this one request; a failure isn't kept.
            cached = { token: fetched.then((t) => t.token), renewAt: Number.POSITIVE_INFINITY };
            tokens.set(key, cached);
            const entry = cached;
            fetched.then(
              (t) => {
                entry.renewAt = renewAt(t.lifetimeMs);
              },
              () => {
                if (tokens.get(key) === entry) tokens.delete(key);
              },
            );
          }
          return { authorization: `Bearer ${await cached.token}` };
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
  const host = new URL(auth.tokenUrl).host;
  const form = new URLSearchParams({ grant_type: "client_credentials", ...(auth.scope ? { scope: auth.scope } : {}), ...(auth.params ?? {}) });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (auth.clientAuth === "basic") headers.authorization = `Basic ${base64(`${encodeURIComponent(auth.clientId)}:${encodeURIComponent(auth.clientSecret)}`)}`;
  else {
    form.set("client_id", auth.clientId);
    form.set("client_secret", auth.clientSecret);
  }
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(auth.tokenUrl, { method: "POST", headers, body: form.toString(), redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
  } catch (e) {
    throw new ScimError(`token request to ${host}: ${(e as Error).name === "TimeoutError" ? "no response" : (e as Error).message}`, null, true);
  }
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; token_type?: unknown; error?: unknown } | null;
  if (!res.ok || typeof json?.access_token !== "string" || !json.access_token) {
    // The error code only: never the response body, which could echo credentials.
    const code = typeof json?.error === "string" ? ` ${json.error.slice(0, 100)}` : "";
    // A refused client is the host's configuration, like a bad token (S1-4): retried until fixed.
    throw new ScimError(`token request to ${host}: ${res.status}${code} (check the target's OAuth client)`, res.status, true);
  }
  if (typeof json.token_type === "string" && json.token_type.toLowerCase() !== "bearer")
    throw new ScimError(`token request to ${host}: token_type ${json.token_type.slice(0, 40)}, not Bearer`, null, false);
  const lifetimeMs = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in * 1000 : 3_600_000;
  return { token: json.access_token, lifetimeMs };
}

const base64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** For tests: forget every cached token. */
export const forgetTokens = () => tokens.clear();
