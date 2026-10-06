// A small SCIM 2.0 client (RFC 7644) for the operations provisioning needs: find a user by
// userName, create, replace, set active, delete. Every failure is a ScimError that says whether
// retrying later can help (429, 5xx, 401/403, timeouts, network errors) or not (other 4xx).

import { credentials, type ScimAuth } from "./credentials";

/**
 * A SCIM base URL: https, or http to a loopback address; no credentials, query or fragment, which
 * would send the token elsewhere or break every path built on it.
 */
export function targetUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.username || u.password || u.search || u.hash || value.includes("?") || value.includes("#")) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
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

export interface ScimGroup {
  schemas: string[];
  externalId?: string | undefined;
  displayName: string;
  /** The members' ids at the app. */
  members: { value: string }[];
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
 * park the job for years, or make an invalid date); undefined if absent or unreadable.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header.trim())) return Math.min(DAY_MS, Number(header.trim()) * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.min(DAY_MS, Math.max(0, at - now));
}

/** `s` without trailing slashes (a loop, not /\/+$/, which is slow on long runs of slashes). */
export function trimSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  return s.slice(0, end);
}

/** A SCIM filter string literal: quotes and backslashes escaped (RFC 7644 §3.4.2.2, JSON rules). */
export const scimString = (value: string) => JSON.stringify(value);

/** `items` in batches of at most `size` (one batch when no size). */
const batches = <T>(items: T[], size?: number): T[][] => {
  if (!size || items.length <= size) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export function scimClient(endpoint: ScimEndpoint) {
  const base = trimSlashes(endpoint.url);
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
        // Never follow: a redirect would replay the token and body to wherever it points.
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
      // Retried, like a wrong URL: a maintenance page or a login bounce passes, and a wrong URL is
      // the host's to fix. Failing the job would leave a banned user active until a reconcile.
      throw new ScimError(`${method} ${path}: redirected (${res.status})${to ? ` to ${to.slice(0, 200)}` : ""}; check the target's url (use the final URL)`, res.status, true, retryAfterMs(res.headers.get("retry-after")));
    }
    const detail = (json as { detail?: unknown } | null)?.detail;
    const scimType = (json as { scimType?: unknown } | null)?.scimType;
    // 401/403 are the host's token, not the user: retried, so jobs recover once it's fixed.
    const auth = res.status === 401 || res.status === 403;
    // /Users itself can't be missing: a 404 there is a wrong URL, the host's to fix, like a token.
    const misplaced = res.status === 404 && /^\/(Users|Groups)(\?|$)/.test(path);
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500 || auth || misplaced;
    throw new ScimError(
      `${method} ${path}: ${res.status}${auth ? " (check the target's token)" : misplaced ? " (check the target's url)" : ""}${typeof detail === "string" ? ` ${detail.slice(0, 300)}` : ""}`,
      res.status,
      retryable,
      retryable ? retryAfterMs(res.headers.get("retry-after")) : undefined,
      typeof scimType === "string" ? scimType : undefined,
    );
  }

  /**
   * A group's current member ids: from the group itself, or by listing users in it. Members are
   * asked for by name (`attributes=members`): apps may leave them out of a plain GET, and SCIM
   * leaves out empty attributes, so only once asked for does "no members" mean an empty group.
   * Listing users follows cursors and startIndex pages alike.
   */
  async function groupMemberIds(id: string, from: "group" | "users-filter"): Promise<string[]> {
    if (from === "group") {
      const { json } = await request("GET", `/Groups/${encodeURIComponent(id)}?attributes=members`);
      const members = (json as { members?: { value?: unknown }[] } | null)?.members;
      return Array.isArray(members) ? members.map((m) => m.value).filter((v): v is string => typeof v === "string") : [];
    }
    const ids = new Set<string>();
    const filter = encodeURIComponent(`groups.value eq ${scimString(id)}`);
    let cursor = "";
    let startIndex = 1;
    for (let pages = 0; pages < 10_000; pages++) {
      const { json } = await request("GET", `/Users?filter=${filter}&cursor=${encodeURIComponent(cursor)}&startIndex=${startIndex}`);
      const list = json as { Resources?: { id?: unknown }[]; nextCursor?: unknown; totalResults?: unknown; itemsPerPage?: unknown } | null;
      if (!list || !Array.isArray(list.Resources)) throw new ScimError("GET /Users: not a SCIM ListResponse (check the target's url)", null, true);
      for (const r of list.Resources) if (typeof r.id === "string") ids.add(r.id);
      if (typeof list.nextCursor === "string" && list.nextCursor) {
        cursor = list.nextCursor;
        continue;
      }
      // Index paging: more to read while totalResults says so and this page wasn't empty.
      const total = typeof list.totalResults === "number" ? list.totalResults : 0;
      if (!list.Resources.length || startIndex - 1 + list.Resources.length >= total) break;
      startIndex += list.Resources.length;
    }
    return [...ids];
  }

  const idOf = (json: unknown, what: string) => {
    const id = (json as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !id) throw new ScimError(`${what}: the response has no id`, null, false);
    return id;
  };

  return {
    /** The user with this userName (its id and externalId), or null. */
    async findByUserName(userName: string): Promise<{ id: string; externalId: string | null; active?: boolean } | null> {
      const { json } = await request("GET", `/Users?filter=${encodeURIComponent(`userName eq ${scimString(userName)}`)}&count=2`);
      const list = json as { schemas?: unknown; Resources?: unknown; totalResults?: unknown } | null;
      // A page that isn't a SCIM list (a wrong URL that answers 200): never read as "no such user".
      if (!list || (!Array.isArray(list.Resources) && typeof list.totalResults !== "number"))
        throw new ScimError("GET /Users: not a SCIM ListResponse (check the target's url)", null, true);
      const resources = Array.isArray(list?.Resources) ? (list.Resources as { id?: unknown; userName?: unknown; externalId?: unknown; active?: unknown }[]) : [];
      // SCIM compares userName case-insensitively; so do we, but only an exact hit is ours.
      const hit = resources.find((r) => typeof r.userName === "string" && r.userName.toLowerCase() === userName.toLowerCase());
      // `active` only when the app says: absent is not "deactivated".
      return hit ? { id: idOf(hit, "GET /Users"), externalId: typeof hit.externalId === "string" && hit.externalId ? hit.externalId : null, ...(typeof hit.active === "boolean" ? { active: hit.active } : {}) } : null;
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
    /** A 404 is left to the caller: it can mean gone, or a wrong URL. */
    async remove(id: string): Promise<void> {
      await request("DELETE", `/Users/${encodeURIComponent(id)}`);
    },
    /** The group with this displayName (its id and externalId), or null. */
    /** By displayName; `externalId` is for clients that find groups by it instead (Google Workspace). */
    async findGroupByName(displayName: string, _externalId?: string | null): Promise<{ id: string; externalId: string | null } | null> {
      const { json } = await request("GET", `/Groups?filter=${encodeURIComponent(`displayName eq ${scimString(displayName)}`)}&count=2`);
      const list = json as { Resources?: unknown; totalResults?: unknown } | null;
      if (!list || (!Array.isArray(list.Resources) && typeof list.totalResults !== "number"))
        throw new ScimError("GET /Groups: not a SCIM ListResponse (check the target's url)", null, true);
      const resources = Array.isArray(list.Resources) ? (list.Resources as { id?: unknown; displayName?: unknown; externalId?: unknown }[]) : [];
      const hit = resources.find((r) => typeof r.displayName === "string" && r.displayName.toLowerCase() === displayName.toLowerCase());
      return hit ? { id: idOf(hit, "GET /Groups"), externalId: typeof hit.externalId === "string" && hit.externalId ? hit.externalId : null } : null;
    },
    /** The ids of a group's members, as the app lists them (asked for by name). */
    async groupMembers(id: string): Promise<string[]> {
      return groupMemberIds(id, "group");
    },
    async createGroup(group: ScimGroup): Promise<string> {
      return idOf((await request("POST", "/Groups", group)).json, "POST /Groups");
    },
    async replaceGroup(id: string, group: ScimGroup): Promise<void> {
      await request("PUT", `/Groups/${encodeURIComponent(id)}`, { ...group, id });
    },
    /** A 404 is left to the caller. */
    async removeGroup(id: string): Promise<void> {
      await request("DELETE", `/Groups/${encodeURIComponent(id)}`);
    },
    /**
     * Update a group by PATCH, for apps without PUT on groups: its name and externalId, then the
     * members that differ, added and removed in batches. The current members come from the group,
     * or from `Users?filter=groups.value eq` for apps whose groups don't list them.
     */
    async patchGroup(id: string, group: ScimGroup, o: { membersFrom?: "group" | "users-filter" | undefined; batch?: number | undefined } = {}): Promise<void> {
      const path = `/Groups/${encodeURIComponent(id)}`;
      await request("PATCH", path, {
        schemas: [PATCH_OP_SCHEMA],
        Operations: [{ op: "replace", path: "displayName", value: group.displayName }, ...(group.externalId ? [{ op: "replace", path: "externalId", value: group.externalId }] : [])],
      });
      const current = new Set(await groupMemberIds(id, o.membersFrom ?? "group"));
      const wanted = new Set(group.members.map((m) => m.value));
      for (const [op, ids] of [["add", [...wanted].filter((m) => !current.has(m))], ["remove", [...current].filter((m) => !wanted.has(m))]] as const) {
        for (const batch of batches(ids, o.batch)) {
          await request("PATCH", path, { schemas: [PATCH_OP_SCHEMA], Operations: [{ op, path: "members", value: batch.map((value) => ({ value })) }] });
        }
      }
    },
    /** Create a group with at most `batch` members, then add the rest. */
    async createGroupInBatches(group: ScimGroup, batch?: number): Promise<string> {
      const [first = [], ...rest] = batches(group.members.map((m) => m.value), batch);
      const id = idOf((await request("POST", "/Groups", { ...group, members: first.map((value) => ({ value })) })).json, "POST /Groups");
      for (const more of rest) {
        await request("PATCH", `/Groups/${encodeURIComponent(id)}`, { schemas: [PATCH_OP_SCHEMA], Operations: [{ op: "add", path: "members", value: more.map((value) => ({ value })) }] });
      }
      return id;
    },
  };
}

export type ScimClient = ReturnType<typeof scimClient>;
