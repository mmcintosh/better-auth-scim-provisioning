// An in-memory SCIM 2.0 service provider, as a fetch function, that behaves like the strict ones:
// bearer token checked, userName unique case-insensitively (409 uniqueness), given and family
// names required (as AWS IAM Identity Center requires), PUT/PATCH/DELETE, and injectable faults.

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
export type Fault = { status: number; retryAfter?: string; detail?: string } | { timeout: true } | { lostReply: true };

/** `keepsExternalId: false`: an app that ignores externalId, as many do. */
export function mockScim(o: { token?: string; requireNames?: boolean; keepsExternalId?: boolean } = {}) {
  const token = o.token ?? "test-token";
  const users = new Map<string, StoredUser>();
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const faults: Fault[] = [];
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

    const fault = faults.shift();
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

    const m = /^\/Users(?:\/([^/?]+))?$/.exec(path);
    if (!m) return error(404, "no such endpoint");
    const id = m[1] ? decodeURIComponent(m[1]) : undefined;

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
      for (const op of (body?.Operations as { op: string; value?: { active?: boolean } }[]) ?? []) {
        if (op.op.toLowerCase() === "replace" && typeof op.value?.active === "boolean") existing.active = op.value.active;
      }
      return reply(200, view(existing));
    }
    if (method === "DELETE") {
      users.delete(existing.id);
      return reply(204);
    }
    return error(405, "method not allowed");
  }

  return {
    fetch: handler,
    users,
    requests,
    /** Answer the next requests with these instead (one fault per request, in order). */
    fail: (...f: Fault[]) => void faults.push(...f),
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
