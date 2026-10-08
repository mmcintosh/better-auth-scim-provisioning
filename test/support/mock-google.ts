// An in-memory Google Workspace Directory API (users) and token endpoint, as a fetch function,
// behaving like the real one where it matters: the service account's JWT is verified (signature,
// iss, sub, scope, aud), users are found by id, primary email or alias, primary emails and aliases
// are unique (409), only the Workspace's domains are accepted (400), a password and both names are
// required to create, and "not found" is Google's JSON error. Anything else gets a plain 404.
// `lag`: as found live, a user created moments ago isn't there by id yet (GET and PATCH 404)
// though it is by email, and can't be deleted yet (412), for the next `lag` requests by id.
// `renameLag`: as found live, while an email change is applied, the next `renameLag` changes to
// that user answer 409 "Entity already exists".

export interface GoogleStoredGroup {
  id: string;
  email: string;
  name: string;
  description?: string;
  members: Set<string>;
}

export interface GoogleStoredUser {
  id: string;
  primaryEmail: string;
  name: { givenName?: string; familyName?: string };
  suspended: boolean;
  externalIds?: { value: string; type: string; customType?: string }[] | undefined;
  aliases?: string[];
  orgUnitPath?: string;
  password?: string;
}

export async function mockGoogle(o: { domains?: string[]; admin?: string; lag?: number | undefined; renameLag?: number | undefined; groupScope?: boolean | undefined; groupLag?: number | undefined; groupReadLag?: number | undefined; membersPageSize?: number | undefined; holdNew?: string | undefined } = {}) {
  const domains = o.domains ?? ["example.com"];
  const admin = o.admin ?? "admin@example.com";
  const keys = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8)).replace(/.{64}/g, "$&\n")}\n-----END PRIVATE KEY-----\n`;
  const clientEmail = "provisioner@project.iam.gserviceaccount.com";
  const url = "https://admin.google.test/admin/directory/v1";
  const tokenUrl = "https://oauth2.google.test/token";
  const users = new Map<string, GoogleStoredUser>();
  const groups = new Map<string, GoogleStoredGroup>();
  const tokenScopes = new Map<string, string[]>();
  const groupSettling = new Map<string, number>();
  const groupHidden = new Map<string, number>();
  const USER_SCOPE = "https://www.googleapis.com/auth/admin.directory.user";
  const GROUP_SCOPE = "https://www.googleapis.com/auth/admin.directory.group";
  const tokens = new Set<string>();
  const settling = new Map<string, number>();
  const renaming = new Map<string, number>();
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const tokenRequests: { claims: Record<string, unknown> }[] = [];
  let next = 1;

  const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const gerror = (code: number, message: string) => json(code, { error: { code, message, errors: [{ message, reason: code === 404 ? "notFound" : code === 409 ? "duplicate" : "invalid" }] } });
  const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const find = (key: string) => {
    const k = key.toLowerCase();
    return [...users.values()].find((u) => u.id === key || u.primaryEmail.toLowerCase() === k || (u.aliases ?? []).some((a) => a.toLowerCase() === k));
  };
  const taken = (email: string, except?: string) => [...users.values()].some((u) => u.id !== except && (u.primaryEmail.toLowerCase() === email.toLowerCase() || (u.aliases ?? []).some((a) => a.toLowerCase() === email.toLowerCase())));

  async function token(body: URLSearchParams) {
    if (body.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return json(400, { error: "unsupported_grant_type" });
    const [h, c, sig] = (body.get("assertion") ?? "").split(".");
    if (!h || !c || !sig) return json(400, { error: "invalid_grant" });
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, b64(sig), new TextEncoder().encode(`${h}.${c}`));
    const claims = JSON.parse(new TextDecoder().decode(b64(c))) as Record<string, unknown>;
    tokenRequests.push({ claims });
    const now = Math.floor(Date.now() / 1000);
    if (!valid || claims.iss !== clientEmail || claims.aud !== tokenUrl || typeof claims.exp !== "number" || claims.exp < now) return json(400, { error: "invalid_grant" });
    // As Google does: a scope that domain-wide delegation doesn't allow fails the whole token request.
    const scopes = String(claims.scope ?? "").split(" ");
    const allowed = [USER_SCOPE, ...(o.groupScope === false ? [] : [GROUP_SCOPE])];
    if (claims.sub !== admin || !scopes.includes(USER_SCOPE) || scopes.some((sc) => !allowed.includes(sc))) return json(401, { error: "unauthorized_client" });
    const t = `ya29.mock-${next++}`;
    tokens.add(t);
    tokenScopes.set(t, scopes);
    return json(200, { access_token: t, token_type: "Bearer", expires_in: 3600 });
  }

  const findGroup = (key: string) => [...groups.values()].find((x) => x.id === key || x.email.toLowerCase() === key.toLowerCase());
  const groupView = (x: GoogleStoredGroup) => ({ kind: "admin#directory#group", id: x.id, email: x.email, name: x.name, description: x.description ?? "", directMembersCount: String(x.members.size) });

  /** Groups and their members, as the Directory API has them. */
  function groupsApi(method: string, key: string | undefined, members: boolean, memberKey: string | undefined, body: Record<string, unknown> | undefined, u: URL): Response {
    if (method === "POST" && !key) {
      const email = String(body?.email ?? "");
      if (!email || !body?.name) return gerror(400, "Invalid Input: missing required field");
      if (!domains.includes(email.split("@")[1] ?? "")) return gerror(400, "Domain not found.");
      if (findGroup(email) || taken(email)) return gerror(409, "Entity already exists.");
      const stored: GoogleStoredGroup = { id: `grp${next++}`, email, name: String(body.name), members: new Set(), ...(typeof body.description === "string" ? { description: body.description } : {}) };
      groups.set(stored.id, stored);
      if (o.groupLag) groupSettling.set(stored.id, o.groupLag);
      if (o.groupReadLag) groupHidden.set(stored.id, o.groupReadLag);
      return json(200, groupView(stored));
    }
    const group = key ? findGroup(key) : undefined;
    if (!group) return gerror(404, "Resource Not Found: groupKey");
    // As found live: reading a group made moments ago can still say it doesn't exist.
    const hidden = groupHidden.get(group.id) ?? 0;
    if (hidden > 0 && method === "GET" && !members) {
      groupHidden.set(group.id, hidden - 1);
      return gerror(404, "Resource Not Found: groupKey");
    }
    if (members) {
      const left = groupSettling.get(group.id) ?? 0;
      if (left > 0) {
        groupSettling.set(group.id, left - 1);
        return gerror(404, "Resource Not Found: groupKey");
      }
      if (method === "GET" && !memberKey) {
        const ids = [...group.members];
        const size = Math.min(Number(u.searchParams.get("maxResults") ?? 200), o.membersPageSize ?? 200);
        const start = Number(u.searchParams.get("pageToken") ?? 0);
        const page = ids.slice(start, start + size).map((id) => ({ kind: "admin#directory#member", id, email: users.get(id)?.primaryEmail, role: "MEMBER", type: "USER" }));
        return json(200, { kind: "admin#directory#members", ...(page.length ? { members: page } : {}), ...(start + size < ids.length ? { nextPageToken: String(start + size) } : {}) });
      }
      if (method === "POST" && !memberKey) {
        const who = (body?.id ? users.get(String(body.id)) : undefined) ?? (body?.email ? find(String(body.email)) : undefined);
        if (!who) return gerror(404, "Resource Not Found: memberKey");
        if (group.members.has(who.id)) return gerror(409, "Member already exists.");
        group.members.add(who.id);
        return json(200, { kind: "admin#directory#member", id: who.id, email: who.primaryEmail, role: "MEMBER", type: "USER" });
      }
      if (method === "DELETE" && memberKey) {
        const who = users.get(memberKey) ?? find(memberKey);
        if (!who || !group.members.has(who.id)) return gerror(404, "Resource Not Found: memberKey");
        group.members.delete(who.id);
        return new Response(null, { status: 204 });
      }
      return gerror(405, "method not allowed");
    }
    if (method === "GET") return json(200, groupView(group));
    if (method === "PATCH") {
      if (typeof body?.name === "string") group.name = body.name;
      if (typeof body?.description === "string") group.description = body.description;
      return json(200, groupView(group));
    }
    if (method === "DELETE") {
      groups.delete(group.id);
      return new Response(null, { status: 204 });
    }
    return gerror(405, "method not allowed");
  }

  const handler: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    if (u.href === tokenUrl) return token(new URLSearchParams(String(init?.body ?? "")));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const path = u.pathname.replace(/^\/admin\/directory\/v1/, "");
    requests.push({ method, path, ...(body ? { body } : {}) });
    const bearer = ((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace(/^Bearer /, "");
    const g = u.href.startsWith(url) ? /^\/groups(?:\/([^/]+)(?:\/members(?:\/([^/]+))?)?)?$/.exec(path) : null;
    if (g) {
      if (!tokens.has(bearer)) return gerror(401, "Invalid Credentials");
      if (!tokenScopes.get(bearer)?.includes(GROUP_SCOPE)) return gerror(403, "Request had insufficient authentication scopes.");
      return groupsApi(method, g[1] ? decodeURIComponent(g[1]) : undefined, path.includes("/members"), g[2] ? decodeURIComponent(g[2]) : undefined, body, u);
    }
    const m = u.href.startsWith(url) ? /^\/users(?:\/([^/]+))?$/.exec(path) : null;
    if (!m) return new Response("<html>Not Found</html>", { status: 404, headers: { "content-type": "text/html" } });
    if (!tokens.has(bearer)) return gerror(401, "Invalid Credentials");
    const key = m[1] ? decodeURIComponent(m[1]) : undefined;

    if (method === "POST" && !key) {
      const email = String(body?.primaryEmail ?? "");
      const name = (body?.name ?? {}) as { givenName?: string; familyName?: string };
      if (!email || !name.givenName || !name.familyName || !body?.password) return gerror(400, "Invalid Input: missing required field");
      if (!domains.includes(email.split("@")[1] ?? "")) return gerror(400, "Domain not found.");
      if (taken(email) || findGroup(email)) return gerror(409, "Entity already exists.");
      const stored: GoogleStoredUser = { id: `g${next++}`, primaryEmail: email, name, suspended: body.suspended === true, password: String(body.password), ...(body.externalIds ? { externalIds: body.externalIds as GoogleStoredUser["externalIds"] } : {}), ...(body.orgUnitPath ? { orgUnitPath: String(body.orgUnitPath) } : {}), ...(body.organizations ? { organizations: body.organizations } : {}), ...(body.relations ? { relations: body.relations } : {}) };
      users.set(stored.id, stored);
      if (o.lag) settling.set(stored.id, o.lag);
      // Google's own hold on new accounts (WEB_LOGIN_REQUIRED, found live).
      if (o.holdNew) Object.assign(stored, { suspended: true, suspensionReason: o.holdNew });
      const { password: _, ...view } = stored;
      return json(200, view);
    }
    const existing = key ? find(key) : undefined;
    if (!existing) return gerror(404, "Resource Not Found: userKey");
    const left = key === existing.id ? (settling.get(existing.id) ?? 0) : 0;
    if (left > 0) {
      settling.set(existing.id, left - 1);
      if (method === "GET" || method === "PATCH") return gerror(404, "Resource Not Found: userKey");
      if (method === "DELETE") return gerror(412, "User creation is not complete.");
    }
    if (method === "GET") {
      const { password: _, ...view } = existing;
      return json(200, view);
    }
    const renameLeft = renaming.get(existing.id) ?? 0;
    if (renameLeft > 0 && (method === "PATCH" || method === "DELETE")) {
      renaming.set(existing.id, renameLeft - 1);
      return gerror(409, "Entity already exists.");
    }
    if (method === "PATCH") {
      if (typeof body?.primaryEmail === "string" && body.primaryEmail.toLowerCase() !== existing.primaryEmail.toLowerCase()) {
        if (!domains.includes(body.primaryEmail.split("@")[1] ?? "")) return gerror(400, "Domain not found.");
        if (taken(body.primaryEmail, existing.id)) return gerror(409, "Entity already exists.");
      }
      if (body?.name) existing.name = { ...existing.name, ...(body.name as object) };
      if (o.renameLag && typeof body?.primaryEmail === "string" && body.primaryEmail.toLowerCase() !== existing.primaryEmail.toLowerCase()) renaming.set(existing.id, o.renameLag);
      const held = (existing as { suspensionReason?: string }).suspensionReason;
      if (body?.suspended === false && existing.suspended && held && held !== "ADMIN") return gerror(412, "Cannot restore a user suspended for abuse.");
      for (const k of ["primaryEmail", "suspended", "externalIds", "orgUnitPath", "organizations", "relations"] as const) if (body && k in body) (existing as unknown as Record<string, unknown>)[k] = body[k];
      if (body?.suspended === true) (existing as { suspensionReason?: string }).suspensionReason = "ADMIN";
      const { password: _, ...view } = existing;
      return json(200, view);
    }
    if (method === "DELETE") {
      users.delete(existing.id);
      return new Response(null, { status: 204 });
    }
    return gerror(405, "method not allowed");
  };

  return { fetch: handler, users, groups, settling, requests, tokenRequests, url, tokenUrl, clientEmail, privateKey, admin };
}
