// An in-memory SCIM 2.0 service provider, as a fetch function, that behaves like the strict ones:
// bearer token checked, userName unique case-insensitively (409 uniqueness), given and family
// names required (as AWS IAM Identity Center requires), PUT/PATCH/DELETE, and injectable faults.

const ENTERPRISE = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

export interface StoredUser {
  id: string;
  userName: string;
  externalId?: string;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  displayName?: string;
  emails?: { value: string; primary?: boolean }[];
  active: boolean;
}

/** A reply instead of the real one, no reply at all, or the real work done and the reply lost. */
export interface StoredGroup {
  id: string;
  displayName: string;
  externalId?: string;
  members: { value: string }[];
}

export type Fault = { status: number; retryAfter?: string; detail?: string } | { timeout: true } | { lostReply: true };

/**
 * `keepsExternalId: false`: an app that ignores externalId, as many do. `patch: true`: PATCH can
 * replace any attribute (without a path, or a top-level path); otherwise only `active`.
 */
/**
 * `like`: behave as a specific app documents. "aws" (IAM Identity Center): no PUT for groups; a
 * group's GET shows no members (they're listed with `Users?filter=groups.value eq "…"`, a cursor
 * page at a time); at most 100 members on create and 100 member changes per PATCH; no member
 * "replace" and no empty member lists. "atlassian": groups can't be renamed.
 */
/**
 * `membersOnRequest`: a group's members are only in a response that asks for them
 * (`attributes=members`), as apps may do. `indexPaged`: users in a group are listed with
 * `Users?filter=groups.value eq "…"`, pageSize at a time, by startIndex and totalResults (no cursor).
 */
export function mockScim(o: { token?: string; requireNames?: boolean; keepsExternalId?: boolean; patch?: boolean; like?: "aws" | "atlassian"; pageSize?: number; membersOnRequest?: boolean; indexPaged?: boolean } = {}) {
  const token = o.token ?? "test-token";
  const users = new Map<string, StoredUser>();
  const groups = new Map<string, StoredGroup>();
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const faults: Fault[] = [];
  const aimed: { method: string; path: RegExp; fault: Fault }[] = [];
  let next = 1;
  let gate: Promise<void> | null = null;

  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/scim+json", ...headers } });
  const error = (status: number, detail: string, scimType?: string) =>
    reply(status, { schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: String(status), detail, ...(scimType ? { scimType } : {}) });
  const taken = (userName: string, except?: string) =>
    [...users.values()].some((u) => u.id !== except && u.userName.toLowerCase() === userName.toLowerCase());
  const invalid = (u: Partial<StoredUser>) =>
    !u.userName ? "userName is required" : o.requireNames && (!u.name?.givenName || !u.name?.familyName) ? "name.givenName and name.familyName are required" : null;
  const view = (u: StoredUser) => ({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], ...u });

  const handler: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const path = url.pathname.replace(/^.*\/scim\/v2/, "");
    requests.push({ method, path: path + url.search, ...(body ? { body } : {}) });
    if (gate) await gate;

    const at = aimed.findIndex((a) => a.method === method && a.path.test(path));
    const fault = at >= 0 ? aimed.splice(at, 1)[0]?.fault : faults.shift();
    if (fault && "lostReply" in fault) {
      await answer(url, method, path, body, init);
      throw new TypeError("network connection lost");
    }
    if (fault && "timeout" in fault) {
      // Never answer: the client's AbortSignal ends the wait.
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }
    if (fault) {
      const res = error(fault.status, fault.detail ?? "injected");
      if (fault.retryAfter) res.headers.set("retry-after", fault.retryAfter);
      return res;
    }
    return answer(url, method, path, body, init);
  };

  async function answer(url: URL, method: string, path: string, body: Record<string, unknown> | undefined, init: RequestInit | undefined): Promise<Response> {
    if (body && o.keepsExternalId === false) delete body.externalId;
    if ((init?.headers as Record<string, string> | undefined)?.authorization !== `Bearer ${token}`) return error(401, "bad token");

    const g = /^\/Groups(?:\/([^/?]+))?$/.exec(path);
    if (g) return group(url, method, g[1] ? decodeURIComponent(g[1]) : undefined, body);

    const m = /^\/Users(?:\/([^/?]+))?$/.exec(path);
    if (!m) return error(404, "no such endpoint");
    const id = m[1] ? decodeURIComponent(m[1]) : undefined;

    if (method === "GET" && !id && o.indexPaged && /^groups\.value eq "/.test(url.searchParams.get("filter") ?? "")) {
      const gid = JSON.parse((url.searchParams.get("filter") ?? "").replace(/^groups\.value eq /, "")) as string;
      const ids = groups.get(gid)?.members.map((m) => m.value) ?? [];
      const size = o.pageSize ?? 100;
      const start = Math.max(1, Number(url.searchParams.get("startIndex") || 1));
      const page = ids.slice(start - 1, start - 1 + size).map((uid) => users.get(uid)).filter(Boolean).map((x) => view(x as StoredUser));
      return reply(200, { schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: ids.length, startIndex: start, itemsPerPage: page.length, Resources: page });
    }
    if (method === "GET" && !id && o.like === "aws" && /^groups\.value eq "/.test(url.searchParams.get("filter") ?? "")) {
      const gid = JSON.parse((url.searchParams.get("filter") ?? "").replace(/^groups\.value eq /, "")) as string;
      const ids = groups.get(gid)?.members.map((m) => m.value) ?? [];
      const size = o.pageSize ?? 100;
      const start = Number(url.searchParams.get("cursor") || 0);
      const page = ids.slice(start, start + size).map((uid) => users.get(uid)).filter(Boolean).map((x) => view(x as StoredUser));
      // As AWS does (found live): without a cursor parameter, even an empty one, one page and no
      // nextCursor, so a reader that leaves it out sees at most a page of members.
      const cursored = url.searchParams.has("cursor");
      return reply(200, { schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], itemsPerPage: page.length, ...(cursored && start + size < ids.length ? { nextCursor: String(start + size) } : {}), Resources: page });
    }
    if (method === "GET" && !id) {
      const f = /^userName eq "(.*)"$/.exec(url.searchParams.get("filter") ?? "");
      const want = f ? (JSON.parse(`"${f[1]}"`) as string).toLowerCase() : null;
      const hits = [...users.values()].filter((u) => want === null || u.userName.toLowerCase() === want).map(view);
      return reply(200, { schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: hits.length, Resources: hits });
    }
    if (method === "POST" && !id) {
      const u = body as Partial<StoredUser>;
      const bad = invalid(u);
      if (bad) return error(400, bad, "invalidValue");
      if (taken(u.userName as string)) return error(409, "userName already exists", "uniqueness");
      const stored: StoredUser = { ...(u as StoredUser), id: `u${next++}`, active: u.active ?? true };
      delete (stored as { schemas?: unknown }).schemas;
      users.set(stored.id, stored);
      return reply(201, view(stored));
    }
    const existing = id ? users.get(id) : undefined;
    if (!existing) return error(404, "no such user");
    if (method === "GET") return reply(200, view(existing));
    if (method === "PUT") {
      const u = body as Partial<StoredUser>;
      const bad = invalid(u);
      if (bad) return error(400, bad, "invalidValue");
      if (taken(u.userName as string, existing.id)) return error(409, "userName already exists", "uniqueness");
      const stored: StoredUser = { ...(u as StoredUser), id: existing.id, active: u.active ?? true };
      delete (stored as { schemas?: unknown }).schemas;
      users.set(existing.id, stored);
      return reply(200, view(stored));
    }
    if (method === "PATCH") {
      for (const op of (body?.Operations as { op: string; path?: string; value?: unknown }[]) ?? []) {
        // A remove of an Enterprise User attribute ("<urn>:department"), as RFC 7644 §3.5.2.2.
        if (op.op.toLowerCase() === "remove" && o.patch && op.path?.startsWith(`${ENTERPRISE}:`)) {
          const ext = (existing as unknown as Record<string, Record<string, unknown> | undefined>)[ENTERPRISE];
          if (ext) delete ext[op.path.slice(ENTERPRISE.length + 1)];
          continue;
        }
        if (op.op.toLowerCase() !== "replace") continue;
        const value = op.value as Record<string, unknown> | undefined;
        if (!o.patch) {
          if (typeof value?.active === "boolean") existing.active = value.active;
          continue;
        }
        const changes = op.path ? { [op.path]: op.value } : { ...value };
        delete changes.id;
        delete changes.schemas;
        if (o.keepsExternalId === false) delete changes.externalId;
        if (typeof changes.userName === "string" && taken(changes.userName, existing.id)) return error(409, "userName already exists", "uniqueness");
        // A complex attribute's sub-attributes are merged, the others kept (RFC 7644 §3.5.2.3).
        const ext = changes[ENTERPRISE] as Record<string, unknown> | undefined;
        if (ext) changes[ENTERPRISE] = { ...((existing as unknown as Record<string, object | undefined>)[ENTERPRISE] ?? {}), ...ext };
        Object.assign(existing, changes);
      }
      return reply(200, view(existing));
    }
    if (method === "DELETE") {
      users.delete(existing.id);
      // A deleted user leaves every group, as real apps do.
      for (const gr of groups.values()) gr.members = gr.members.filter((x) => x.value !== existing.id);
      return reply(204);
    }
    return error(405, "method not allowed");
  }

  /** /Groups: displayName unique (case-insensitive), members must be known users, PATCH members. */
  function group(url: URL, method: string, id: string | undefined, body: Record<string, unknown> | undefined): Response {
    const asked = (url.searchParams.get("attributes") ?? "").split(",").includes("members");
    const view = (gr: StoredGroup) => {
      const { members, ...rest } = gr;
      const shown = o.like === "aws" ? [] : o.membersOnRequest && !asked ? undefined : members;
      return { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], ...rest, ...(shown === undefined ? {} : { members: shown }) };
    };
    const named = (name: string, except?: string) => [...groups.values()].some((x) => x.id !== except && x.displayName.toLowerCase() === name.toLowerCase());
    const membersOf = (v: unknown) => {
      const list = Array.isArray(v) ? (v as { value?: unknown }[]) : [];
      if (list.some((x) => typeof x.value !== "string" || !users.has(x.value))) return null;
      return list.map((x) => ({ value: x.value as string }));
    };
    if (method === "GET" && !id) {
      const f = /^displayName eq "(.*)"$/.exec(url.searchParams.get("filter") ?? "");
      const want = f ? (JSON.parse(`"${f[1]}"`) as string).toLowerCase() : null;
      const hits = [...groups.values()].filter((x) => want === null || x.displayName.toLowerCase() === want).map(view);
      return reply(200, { schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: hits.length, Resources: hits });
    }
    if (method === "POST" && !id) {
      const displayName = body?.displayName;
      if (typeof displayName !== "string" || !displayName) return error(400, "displayName is required", "invalidValue");
      if (named(displayName)) return error(409, "displayName already exists", "uniqueness");
      const members = membersOf(body?.members ?? []);
      if (!members) return error(400, "unknown member", "invalidValue");
      if (o.like === "aws" && members.length > 100) return error(400, "A maximum of 100 members can be added in a single request", "invalidValue");
      const gr: StoredGroup = { id: `g${next++}`, displayName, members, ...(typeof body?.externalId === "string" ? { externalId: body.externalId } : {}) };
      groups.set(gr.id, gr);
      return reply(201, view(gr));
    }
    const existing = id ? groups.get(id) : undefined;
    if (!existing) return error(404, "no such group");
    if (method === "GET") return reply(200, view(existing));
    if (method === "PUT" && o.like === "aws") return error(400, "ValidationException: the operation is unsupported", "invalidValue");
    if (method === "PUT" && o.like === "atlassian" && typeof body?.displayName === "string" && body.displayName !== existing.displayName)
      return error(400, "Renaming groups after they've synced isn't supported", "mutability");
    if (method === "PUT") {
      const displayName = body?.displayName;
      if (typeof displayName !== "string" || !displayName) return error(400, "displayName is required", "invalidValue");
      if (named(displayName, existing.id)) return error(409, "displayName already exists", "uniqueness");
      const members = membersOf(body?.members ?? []);
      if (!members) return error(400, "unknown member", "invalidValue");
      Object.assign(existing, { displayName, members, ...(typeof body?.externalId === "string" ? { externalId: body.externalId } : {}) });
      return reply(200, view(existing));
    }
    if (method === "PATCH") {
      const ops = (body?.Operations as { op: string; path?: string; value?: unknown }[]) ?? [];
      if (o.like === "aws") {
        const changes = ops.filter((x) => x.path === "members").reduce((n, x) => n + (Array.isArray(x.value) ? x.value.length : 0), 0);
        if (changes > 100) return error(400, "A maximum of 100 membership changes are allowed in a single request", "invalidValue");
        if (ops.some((x) => x.path === "members" && (x.op.toLowerCase() === "replace" || !Array.isArray(x.value) || x.value.length === 0)))
          return error(400, "Replacing or removing all group memberships in a single request isn't supported", "invalidValue");
        if (ops.some((x) => !x.path)) return error(400, "Only displayName, members and externalId are allowed", "invalidPath");
      }
      for (const op of ops) {
        const kind = op.op.toLowerCase();
        if (op.path === "displayName" && kind === "replace" && typeof op.value === "string") {
          if (o.like === "atlassian" && op.value !== existing.displayName) return error(400, "Renaming groups after they've synced isn't supported", "mutability");
          existing.displayName = op.value;
          continue;
        }
        if (op.path === "externalId" && kind === "replace" && typeof op.value === "string") {
          existing.externalId = op.value;
          continue;
        }
        if (op.path === "members" || (kind === "replace" && !op.path && (op.value as { members?: unknown })?.members !== undefined)) {
          const members = membersOf(op.path ? op.value : (op.value as { members?: unknown }).members);
          if (!members) return error(400, "unknown member", "invalidValue");
          if (kind === "add") existing.members = [...existing.members, ...members.filter((x) => !existing.members.some((y) => y.value === x.value))];
          else if (kind === "remove") existing.members = existing.members.filter((y) => !members.some((x) => x.value === y.value));
          else existing.members = members;
        }
        const dn = (op.value as { displayName?: unknown } | undefined)?.displayName;
        if (kind === "replace" && typeof dn === "string") existing.displayName = dn;
      }
      return reply(200, view(existing));
    }
    if (method === "DELETE") {
      groups.delete(existing.id);
      return reply(204);
    }
    return error(405, "method not allowed");
  }

  return {
    fetch: handler,
    users,
    groups,
    requests,
    /** Answer the next requests with these instead (one fault per request, in order). */
    fail: (...f: Fault[]) => void faults.push(...f),
    /** Answer the next request with this method and path (e.g. POST, /^\/Groups$/) with `fault` instead, once. */
    failOn: (method: string, path: RegExp, fault: Fault) => void aimed.push({ method, path, fault }),
    /** Hold every request until the returned function is called (to change things mid-delivery). */
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
    token,
    url: "https://scim.test/tenant/scim/v2",
  };
}
