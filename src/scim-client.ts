// A small SCIM 2.0 client (RFC 7644) for the operations provisioning needs: find a user by
// userName, create, replace, set active, delete. Every failure is a ScimError that says whether
// retrying later can help (429, 5xx, 401/403, timeouts, network errors) or not (other 4xx).

import { credentials, type ScimAuth } from "./credentials";

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH_OP_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export interface ScimUser {
  schemas: string[];
  externalId?: string | undefined;
  userName: string;
  name?: { givenName?: string | undefined; familyName?: string | undefined; formatted?: string | undefined } | undefined;
  displayName?: string | undefined;
  emails?: { value: string; type?: string | undefined; primary?: boolean | undefined }[] | undefined;
  active: boolean;
}

export interface ScimEndpoint {
  /** The SCIM base URL, without /Users (for example https://scim.us-east-2.amazonaws.com/<id>/scim/v2). */
  url: string;
  /** How requests are authorised; `token` is short for `{ type: "bearer", token }`. */
  auth?: ScimAuth | undefined;
  /** Bearer token. */
  token?: string | undefined;
  /** Per request; default 10 seconds. */
  timeoutMs?: number | undefined;
  /** For tests. */
  fetch?: typeof fetch | undefined;
}

export class ScimError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly retryAfterMs?: number | undefined,
    readonly scimType?: string | undefined,
  ) {
    super(message);
    this.name = "ScimError";
  }
}

const DAY_MS = 86_400_000;

/**
 * `Retry-After` as milliseconds: delay-seconds or an HTTP date, at most a day (a huge value would
 * park the job for years, or make an invalid date, S2-9); undefined if absent or unreadable.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header.trim())) return Math.min(DAY_MS, Number(header.trim()) * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.min(DAY_MS, Math.max(0, at - now));
}

/** A SCIM filter string literal: quotes and backslashes escaped (RFC 7644 §3.4.2.2, JSON rules). */
export const scimString = (value: string) => JSON.stringify(value);

export function scimClient(endpoint: ScimEndpoint) {
  const base = endpoint.url.replace(/\/+$/, "");
  const doFetch = endpoint.fetch ?? fetch;
  const timeoutMs = endpoint.timeoutMs ?? 10_000;
  const auth: ScimAuth = endpoint.auth ?? { type: "bearer", token: endpoint.token ?? "" };
  const creds = credentials(auth, { fetch: doFetch, timeoutMs });

  async function request(method: string, path: string, body?: unknown, retried = false): Promise<{ status: number; json: unknown }> {
    let res: Response;
    const authorization = await creds.headers();
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...authorization,
          accept: "application/scim+json, application/json",
          ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // Never follow: a redirect would replay the token and body to wherever it points (S2-13).
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
      throw new ScimError(`${method} ${path}: ${timedOut ? `no response within ${timeoutMs} ms` : (e as Error).message}`, null, true);
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.ok) return { status: res.status, json };
    // A cached OAuth token the app no longer accepts: once, with a new one.
    if (res.status === 401 && !retried && creds.rejected()) return request(method, path, body, true);
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get("location");
      throw new ScimError(`${method} ${path}: redirected (${res.status})${to ? ` to ${to.slice(0, 200)}` : ""}; use the final URL as the target's url`, res.status, false);
    }
    const detail = (json as { detail?: unknown } | null)?.detail;
    const scimType = (json as { scimType?: unknown } | null)?.scimType;
    // 401/403 are the host's token, not the user: retried, so jobs recover once it's fixed (S1-4).
    const auth = res.status === 401 || res.status === 403;
    const retryable = res.status === 429 || res.status >= 500 || auth;
    throw new ScimError(
      `${method} ${path}: ${res.status}${auth ? " (check the target's token)" : ""}${typeof detail === "string" ? ` ${detail.slice(0, 300)}` : ""}`,
      res.status,
      retryable,
      retryable ? retryAfterMs(res.headers.get("retry-after")) : undefined,
      typeof scimType === "string" ? scimType : undefined,
    );
  }

  const idOf = (json: unknown, what: string) => {
    const id = (json as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !id) throw new ScimError(`${what}: the response has no id`, null, false);
    return id;
  };

  return {
    /** The user with this userName (its id and externalId), or null. */
    async findByUserName(userName: string): Promise<{ id: string; externalId: string | null } | null> {
      const { json } = await request("GET", `/Users?filter=${encodeURIComponent(`userName eq ${scimString(userName)}`)}&count=2`);
      const list = json as { schemas?: unknown; Resources?: unknown } | null;
      const resources = Array.isArray(list?.Resources) ? (list.Resources as { id?: unknown; userName?: unknown; externalId?: unknown }[]) : [];
      // SCIM compares userName case-insensitively; so do we, but only an exact hit is ours.
      const hit = resources.find((r) => typeof r.userName === "string" && r.userName.toLowerCase() === userName.toLowerCase());
      return hit ? { id: idOf(hit, "GET /Users"), externalId: typeof hit.externalId === "string" && hit.externalId ? hit.externalId : null } : null;
    },
    async create(user: ScimUser): Promise<string> {
      return idOf((await request("POST", "/Users", user)).json, "POST /Users");
    },
    async replace(id: string, user: ScimUser): Promise<void> {
      await request("PUT", `/Users/${encodeURIComponent(id)}`, { ...user, id });
    },
    /** Like replace, but only the attributes we send change: anything set at the app is kept. */
    async patch(id: string, user: ScimUser): Promise<void> {
      const { schemas: _, ...value } = user;
      await request("PATCH", `/Users/${encodeURIComponent(id)}`, { schemas: [PATCH_OP_SCHEMA], Operations: [{ op: "replace", value }] });
    },
    async setActive(id: string, active: boolean): Promise<void> {
      await request("PATCH", `/Users/${encodeURIComponent(id)}`, {
        schemas: [PATCH_OP_SCHEMA],
        Operations: [{ op: "replace", value: { active } }],
      });
    },
    async remove(id: string): Promise<void> {
      try {
        await request("DELETE", `/Users/${encodeURIComponent(id)}`);
      } catch (e) {
        // Already gone is what we wanted.
        if (e instanceof ScimError && e.status === 404) return;
        throw e;
      }
    },
  };
}

export type ScimClient = ReturnType<typeof scimClient>;
