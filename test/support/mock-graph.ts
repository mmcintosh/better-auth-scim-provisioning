// An in-memory Microsoft Graph (users) and Entra token endpoint, as a fetch function, behaving like
// the real one where it matters (as probed live in a test tenant): client credentials for the
// tenant's own token endpoint, users found by id or `$filter` on userPrincipalName or
// onPremisesImmutableId, accountEnabled/displayName/mailNickname/userPrincipalName required to
// create, a verified domain required, an immutableId required on a federated domain and a password
// on a managed one, userPrincipalName unique among users and onPremisesImmutableId unique among
// users AND the recycle bin (400 ObjectConflict naming the holder as ConflictingObjects
// `User_<id>`), a deleted user kept in the bin under `<id without hyphens><old UPN>` until
// restored (back under its UPN) or purged, a POST without a body answered 411, and "not found" as
// Graph's JSON error. Anything else gets a plain 404.
// `lose`: as found live (a disable three seconds after an enable, answered 204 and never applied),
// the next `lose.accountEnabled` PATCHes that change accountEnabled and the next `lose.delete`
// deletes are answered as done and dropped whole.
// `refuse.manager`: setting a manager answers 400. `refuse.conflict`: the next create meets an
// ObjectConflict on that property (proxyAddresses, say).
// `deleteLag`: as found live, a user deleted moments ago still reads as live by id (GET 200) though
// changes to it 404, for the next `deleteLag` reads.
// `lag`: as found live, a user created moments ago isn't there by id or userPrincipalName yet
// (GET, PATCH and DELETE 404) though the immutableId lookup finds it, for the next `lag` requests
// by id or userPrincipalName.

export interface GraphStoredUser {
  id: string;
  userPrincipalName: string;
  displayName: string;
  mailNickname: string;
  accountEnabled: boolean;
  givenName?: string | null;
  surname?: string | null;
  onPremisesImmutableId?: string | null;
  passwordProfile?: { password: string; forceChangePasswordNextSignIn?: boolean };
  employeeId?: string | null;
  department?: string | null;
  companyName?: string | null;
  employeeOrgData?: { costCenter?: string | null; division?: string | null } | null;
  jobTitle?: string | null;
  businessPhones?: string[];
  mobilePhone?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  manager?: string;
  /** The UPN it had before it went into the bin. */
  binnedUpn?: string;
}

export function mockGraph(o: { domains?: Record<string, "Federated" | "Managed">; lag?: number | undefined; deleteLag?: number | undefined } = {}) {
  const domains = o.domains ?? { "example.com": "Federated", "managed.example": "Managed" };
  const tenantId = "00000000-0000-4000-8000-000000000001";
  const clientId = "11111111-2222-3333-4444-555555555555";
  const clientSecret = "graph-client-secret-for-tests";
  const url = "https://graph.microsoft.test/v1.0";
  const tokenUrl = `https://login.microsoftonline.test/${tenantId}/oauth2/v2.0/token`;
  const users = new Map<string, GraphStoredUser>();
  const bin = new Map<string, GraphStoredUser>();
  const tokens = new Set<string>();
  const settling = new Map<string, number>();
  const revoked: string[] = [];
  /** Users deleted moments ago that still read as live (by id), for this many more reads. */
  const ghosts = new Map<string, number>();
  /** Writes to answer as done and drop, like Graph's replicas sometimes do. */
  const lose = { accountEnabled: 0, delete: 0 };
  const refuse: { manager: boolean; conflict: string | null } = { manager: false, conflict: null };
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const tokenRequests: { body: URLSearchParams }[] = [];
  let next = 1;

  const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const gerror = (status: number, code: string, message: string, details?: { code: string; target: string }[]) =>
    json(status, { error: { code, message, ...(details ? { details } : {}), innerError: { date: new Date().toISOString(), "request-id": crypto.randomUUID() } } });
  const notFound = (id: string) => gerror(404, "Request_ResourceNotFound", `Resource '${id}' does not exist or one of its queried reference-property objects are not present.`);
  const conflict = (property: string, holder: string) =>
    gerror(400, "Request_BadRequest", `Another object with the same value for property ${property} already exists.`, [
      { code: "ObjectConflict", target: property },
      { code: "ConflictingObjects", target: `User_${holder}` },
    ]);
  const view = (u: GraphStoredUser) => {
    const { passwordProfile: _, manager: __, binnedUpn: ___, ...rest } = u;
    return { "@odata.type": "#microsoft.graph.user", ...rest };
  };
  const select = (u: GraphStoredUser, q: URLSearchParams) => {
    const fields = q.get("$select");
    const all = view(u) as Record<string, unknown>;
    return fields ? Object.fromEntries(fields.split(",").map((f) => [f, all[f] ?? null])) : all;
  };
  const byUpn = (upn: string, except?: string) => [...users.values()].find((u) => u.id !== except && u.userPrincipalName.toLowerCase() === upn.toLowerCase());
  const immutableHolder = (imm: string, except?: string) => [...users.values(), ...bin.values()].find((u) => u.id !== except && u.onPremisesImmutableId === imm);
  /** A user just created isn't visible by id or UPN for a few requests (counted down here). */
  const hidden = (id: string) => {
    const left = settling.get(id) ?? 0;
    if (left <= 0) return false;
    settling.set(id, left - 1);
    return true;
  };
  const domainOf = (upn: string) => domains[upn.split("@")[1]?.toLowerCase() ?? ""];

  function token(body: URLSearchParams) {
    tokenRequests.push({ body });
    if (body.get("grant_type") !== "client_credentials") return json(400, { error: "unsupported_grant_type" });
    if (body.get("client_id") !== clientId || body.get("client_secret") !== clientSecret) return json(401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." });
    // The scope names this Graph (a national cloud's has its own origin).
    if (body.get("scope") !== `${new URL(url).origin}/.default`) return json(400, { error: "invalid_scope" });
    const t = `eyJ0eXAi.mock-${next++}`;
    tokens.add(t);
    return json(200, { token_type: "Bearer", expires_in: 3599, access_token: t });
  }

  /** The fields a create or update may set, checked like Graph does. */
  function apply(u: GraphStoredUser, body: Record<string, unknown>): Response | null {
    if (typeof body.userPrincipalName === "string" && body.userPrincipalName.toLowerCase() !== u.userPrincipalName.toLowerCase()) {
      if (!domainOf(body.userPrincipalName)) return gerror(400, "Request_BadRequest", "The domain portion of the userPrincipalName property is invalid. You must use one of the verified domain names in your organization.");
      const holder = byUpn(body.userPrincipalName, u.id);
      if (holder) return conflict("userPrincipalName", holder.id);
    }
    if ("onPremisesImmutableId" in body && body.onPremisesImmutableId !== u.onPremisesImmutableId) {
      const holder = typeof body.onPremisesImmutableId === "string" ? immutableHolder(body.onPremisesImmutableId, u.id) : undefined;
      if (holder) return conflict("onPremisesImmutableId", holder.id);
    }
    for (const k of ["userPrincipalName", "displayName", "givenName", "surname", "accountEnabled", "onPremisesImmutableId", "employeeId", "department", "companyName", "employeeOrgData", "mailNickname", "jobTitle", "businessPhones", "mobilePhone", "streetAddress", "city", "state", "postalCode", "country"] as const) {
      if (k in body) (u as unknown as Record<string, unknown>)[k] = body[k];
    }
    if (typeof u.employeeId === "string" && u.employeeId.length > 16) return gerror(400, "Request_BadRequest", "Invalid value specified for property 'employeeId' of resource 'User'.");
    return null;
  }

  const handler: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    if (u.href === tokenUrl) return token(new URLSearchParams(String(init?.body ?? "")));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (!u.href.startsWith(url)) return new Response("not found", { status: 404 });
    if (!tokens.has(auth.replace(/^Bearer /, ""))) return gerror(401, "InvalidAuthenticationToken", "Access token is empty.");
    const path = decodeURIComponent(u.pathname.slice(new URL(url).pathname.length));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ method, path, ...(body ? { body } : {}) });
    // As found live: Graph wants a length on a POST, body or not.
    if (method === "POST" && body === undefined) return new Response("Length Required", { status: 411 });
    const q = u.searchParams;
    const deletedItem = path.match(/^\/directory\/deletedItems\/([^/]+)(\/restore)?$/);
    const userPath = path.match(/^\/users\/([^/]+)(\/manager\/\$ref|\/revokeSignInSessions)?$/);

    if (path === "/users" && method === "GET") {
      const filter = (q.get("$filter") ?? "").match(/^(userPrincipalName|onPremisesImmutableId) eq '((?:[^']|'')*)'$/);
      if (!filter) return gerror(400, "Request_UnsupportedQuery", "Unsupported query.");
      const value = filter[2]!.replace(/''/g, "'");
      const found =
        filter[1] === "userPrincipalName" ? [...users.values()].filter((x) => x.userPrincipalName.toLowerCase() === value.toLowerCase() && !hidden(x.id)) : [...users.values()].filter((x) => x.onPremisesImmutableId === value);
      return json(200, { "@odata.context": `${url}/$metadata#users`, value: found.map((x) => select(x, q)) });
    }
    if (path === "/users" && method === "POST") {
      const b = body ?? {};
      for (const k of ["accountEnabled", "displayName", "mailNickname", "userPrincipalName"]) if (b[k] === undefined) return gerror(400, "Request_BadRequest", `Property '${k}' value is required but is empty or missing.`);
      if (/[@\s()\\[\]";:<>,]/.test(String(b.mailNickname))) return gerror(400, "Request_BadRequest", "Invalid value specified for property 'mailNickname' of resource 'User'.");
      const kind = domainOf(String(b.userPrincipalName));
      if (!kind) return gerror(400, "Request_BadRequest", "The domain portion of the userPrincipalName property is invalid. You must use one of the verified domain names in your organization.");
      if (kind === "Federated" && !b.onPremisesImmutableId) return gerror(400, "Request_BadRequest", "Property 'onPremisesImmutableId' is required when creating a user on a federated domain.");
      if (kind === "Managed" && !(b.passwordProfile as { password?: string } | undefined)?.password) return gerror(400, "Request_BadRequest", "Property passwordProfile.password value is required but is empty or missing.");
      if (refuse.conflict) {
        const property = refuse.conflict;
        refuse.conflict = null;
        return conflict(property, "someone-else");
      }
      const holderUpn = byUpn(String(b.userPrincipalName));
      if (holderUpn) return conflict("userPrincipalName", holderUpn.id);
      const holderImm = typeof b.onPremisesImmutableId === "string" ? immutableHolder(b.onPremisesImmutableId) : undefined;
      if (holderImm) return conflict("onPremisesImmutableId", holderImm.id);
      const stored: GraphStoredUser = { id: crypto.randomUUID(), userPrincipalName: "", displayName: "", mailNickname: "", accountEnabled: false };
      const refused = apply(stored, b);
      if (refused) return refused;
      if (b.passwordProfile) stored.passwordProfile = b.passwordProfile as GraphStoredUser["passwordProfile"] & object;
      users.set(stored.id, stored);
      if (o.lag) settling.set(stored.id, o.lag);
      return json(201, view(stored));
    }
    if (deletedItem) {
      const m = deletedItem;
      const binned = bin.get(m[1]!);
      if (!binned) return notFound(m[1]!);
      if (!m[2] && method === "GET") return json(200, select(binned, q));
      if (m[2] && method === "POST") {
        const upn = binned.binnedUpn ?? binned.userPrincipalName;
        const holder = byUpn(upn);
        if (holder) return conflict("userPrincipalName", holder.id);
        bin.delete(binned.id);
        binned.userPrincipalName = upn;
        delete binned.binnedUpn;
        users.set(binned.id, binned);
        return json(200, view(binned));
      }
      if (!m[2] && method === "DELETE") {
        bin.delete(binned.id);
        return new Response(null, { status: 204 });
      }
      return gerror(405, "Request_BadRequest", "method not allowed");
    }
    if (userPath) {
      const m = userPath;
      const key = m[1]!;
      const ghost = bin.get(key);
      if (ghost && !m[2] && method === "GET" && (ghosts.get(key) ?? 0) > 0) {
        ghosts.set(key, (ghosts.get(key) ?? 0) - 1);
        return json(200, select({ ...ghost, userPrincipalName: ghost.binnedUpn ?? ghost.userPrincipalName }, q));
      }
      const user = users.get(key) ?? byUpn(key);
      if (!user || hidden(user.id)) return notFound(key);
      if (m[2] === "/revokeSignInSessions" && method === "POST") {
        revoked.push(user.id);
        return json(200, { value: true });
      }
      if (m[2] === "/manager/$ref") {
        if (method === "PUT") {
          if (refuse.manager) return gerror(400, "Request_BadRequest", "Invalid object identifier.");
          const ref = String(body?.["@odata.id"] ?? "");
          const managerId = ref.split("/").pop() ?? "";
          if (!ref.startsWith(`${url}/directoryObjects/`) || !users.has(managerId)) return notFound(managerId);
          user.manager = managerId;
          return new Response(null, { status: 204 });
        }
        if (method === "DELETE") {
          if (!user.manager) return notFound("manager");
          delete user.manager;
          return new Response(null, { status: 204 });
        }
      }
      if (m[2]) return gerror(405, "Request_BadRequest", "method not allowed");
      if (method === "GET") return json(200, select(user, q));
      if (method === "PATCH") {
        const b = { ...(body ?? {}) };
        if ("accountEnabled" in b && lose.accountEnabled > 0) {
          lose.accountEnabled--;
          return new Response(null, { status: 204 });
        }
        const refused = apply(user, b);
        return refused ?? new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        if (lose.delete > 0) {
          lose.delete--;
          return new Response(null, { status: 204 });
        }
        users.delete(user.id);
        user.binnedUpn = user.userPrincipalName;
        user.userPrincipalName = `${user.id.replace(/-/g, "")}${user.userPrincipalName}`;
        bin.set(user.id, user);
        if (o.deleteLag) ghosts.set(user.id, o.deleteLag);
        return new Response(null, { status: 204 });
      }
    }
    return new Response("not found", { status: 404 });
  };

  return { url, tokenUrl, tenantId, clientId, clientSecret, users, bin, revoked, lose, refuse, requests, tokenRequests, fetch: handler };
}
