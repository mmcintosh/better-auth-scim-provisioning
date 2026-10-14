// Microsoft Entra ID through Microsoft Graph, for targets with `type: "entra-id"`: the same
// operations as the SCIM client, so the outbox treats both alike. Graph doesn't speak SCIM: users
// are `userPrincipalName`, `displayName`, `accountEnabled`, and our id (externalId) is the
// `onPremisesImmutableId`, which is also what Entra matches a federated sign-in's NameID against:
// a user provisioned here signs in through your SAML identity provider at once (tested live). Users
// only, for now: groups aren't supported yet.
import { credentials } from "./credentials";
import { fetchFailure, retryAfterMs, SCIM_ENTERPRISE_USER_SCHEMA, ScimError, type ScimUser, type scimClient, trimSlashes } from "./scim-client";
import type { Target } from "./types";

export const GRAPH_URL = "https://graph.microsoft.com/v1.0";
const SCOPE = "https://graph.microsoft.com/.default";
/** What a user is read with: enough to tell whose it is, and to merge the org data into. */
const SELECT = "id,userPrincipalName,onPremisesImmutableId,accountEnabled,employeeOrgData";

interface GraphUser {
  id?: string;
  userPrincipalName?: string;
  onPremisesImmutableId?: string | null;
  accountEnabled?: boolean;
  employeeOrgData?: { costCenter?: string | null; division?: string | null } | null;
  /** A list's page. */
  value?: GraphUser[];
}

/** Graph's error, with what it conflicted on (`ObjectConflict`) and the object holding it. */
export class GraphError extends ScimError {
  constructor(
    message: string,
    status: number | null,
    retryable: boolean,
    retryAfter: number | undefined,
    readonly code: string,
    /** The property another object already holds, for an ObjectConflict. */
    readonly conflict: string | null,
    /** That object's id (`ConflictingObjects`: `User_<id>`). */
    readonly holder: string | null,
  ) {
    super(message, status, retryable, retryAfter);
  }
}

/** The SCIM client's operations; `replace` also takes whether this is a reactivation (see update). */
export type EntraIdClient = Omit<ReturnType<typeof scimClient>, "replace"> & {
  replace(id: string, user: ScimUser, o?: { reactivate?: boolean }): Promise<void>;
  /** The user with this immutableId: shows at once after a write, while the userPrincipalName lags (found live). */
  findByExternalId(externalId: string): Promise<{ id: string; externalId: string | null; active?: boolean } | null>;
  /** Whether the account is enabled, or null if Graph says it doesn't exist. */
  enabled(id: string): Promise<boolean | null>;
};

/** An OData string literal: quotes doubled. */
const odata = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A mailNickname from the userName's local part: Graph requires one, in ASCII, without spaces or @()\[]";:<>, (at most 64). */
export function mailNickname(userName: string): string {
  const local = (userName.split("@")[0] ?? "")
    .replace(/[^A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 64)
    .replace(/\.+$/, "");
  return local || "user";
}

/** Entra wants 8 to 256 characters of three kinds; nobody ever uses it (they sign in through the IdP, or reset it). */
const throwaway = () => `${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))}Aa1!`;

export function entraIdClient(target: Target): EntraIdClient {
  const entra = target.entra;
  if (!entra) throw new Error(`[scim] target ${target.id}: type "entra-id" needs entra`);
  const base = trimSlashes(target.url ?? GRAPH_URL);
  const doFetch = target.fetch ?? fetch;
  const timeoutMs = target.timeoutMs ?? 10_000;
  // The token endpoint is the tenant's own, so a token is only ever for that tenant.
  const creds = credentials(
    { type: "oauth2", tokenUrl: entra.tokenUrl ?? `https://login.microsoftonline.com/${entra.tenantId}/oauth2/v2.0/token`, clientId: entra.clientId, clientSecret: entra.clientSecret, scope: SCOPE },
    { fetch: doFetch, timeoutMs },
  );

  /** One Graph call. A 404 is Graph's own "not found" (not retried) only when it says so in JSON. */
  async function request(method: string, path: string, body?: unknown, retried = false): Promise<GraphUser | null> {
    let res: Response;
    const authorization = await creds.headers();
    // Graph answers a POST without a length with 411 (found live), even one that takes no body (restore).
    const payload = body !== undefined ? JSON.stringify(body) : method === "POST" ? "{}" : undefined;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { ...authorization, accept: "application/json", ...(payload === undefined ? {} : { "content-type": "application/json" }) },
        ...(payload === undefined ? {} : { body: payload }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ScimError(`${method} ${path}: ${fetchFailure(e, timeoutMs)}`, null, true);
    }
    const text = await res.text();
    let json: { error?: { code?: unknown; message?: unknown; details?: { code?: unknown; target?: unknown }[] } } & GraphUser = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {}
    if (res.ok) return json;
    if (res.status === 401 && !retried && creds.rejected()) return request(method, path, body, true);
    if (res.status >= 300 && res.status < 400) throw new ScimError(`${method} ${path}: redirected (${res.status}); check the target's url`, res.status, true, retryAfterMs(res.headers.get("retry-after")));
    const code = typeof json.error?.code === "string" ? json.error.code : "";
    // Not Graph's own "not found" (a wrong URL answers 404 for everything): the host's to fix.
    const misplaced = res.status === 404 && !code;
    const auth = res.status === 401 || res.status === 403;
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500 || auth || misplaced;
    const details = Array.isArray(json.error?.details) ? json.error.details : [];
    const conflict = details.find((d) => d.code === "ObjectConflict" && typeof d.target === "string")?.target as string | undefined;
    const holder = details.find((d) => d.code === "ConflictingObjects" && typeof d.target === "string")?.target as string | undefined;
    const message = typeof json.error?.message === "string" ? ` ${json.error.message.slice(0, 300)}` : "";
    throw new GraphError(
      `${method} ${path}: ${res.status}${auth ? " (check the app registration's Graph permissions, admin consent and client secret)" : misplaced ? " (check the target's url)" : ""}${message}`,
      res.status,
      retryable,
      retryable ? retryAfterMs(res.headers.get("retry-after")) : undefined,
      code,
      conflict ?? null,
      holder ? holder.replace(/^[A-Za-z]+_/, "") : null,
    );
  }

  const path = (id: string) => `/users/${encodeURIComponent(id)}`;
  const notFoundAtGraph = (e: unknown) => e instanceof ScimError && e.status === 404 && !e.retryable;

  async function findBy(property: "userPrincipalName" | "onPremisesImmutableId", value: string): Promise<GraphUser | null> {
    const page = await request("GET", `/users?$filter=${encodeURIComponent(`${property} eq ${odata(value)}`)}&$select=${SELECT}`);
    if (!page || !Array.isArray(page.value)) throw new ScimError("GET /users: not a Graph list (check the target's url)", null, true);
    const hit = page.value.find((u) => (property === "userPrincipalName" ? u[property]?.toLowerCase() === value.toLowerCase() : u[property] === value));
    return hit?.id ? hit : null;
  }

  /**
   * The user as Graph has them now. For seconds after a write, Graph's replicas disagree (found
   * live): a user just created can 404 by id though the lookup by immutableId already finds it.
   * So a 404 by id is asked again that way, and taken only if it's the same user (`lagging`).
   */
  async function current(id: string, externalId: string | undefined): Promise<{ user: GraphUser; lagging: boolean }> {
    try {
      const user = await request("GET", `${path(id)}?$select=${SELECT}`);
      return { user: user ?? {}, lagging: false };
    } catch (e) {
      if (!notFoundAtGraph(e) || !externalId) throw e;
      const found = await findBy("onPremisesImmutableId", externalId).catch(() => null);
      if (found?.id === id) return { user: found, lagging: true };
      throw e;
    }
  }

  const names = (user: ScimUser) => ({
    displayName: user.displayName || user.name?.formatted || user.userName,
    givenName: user.name?.givenName || null,
    surname: user.name?.familyName || null,
  });

  /**
   * The Enterprise User attributes, where Graph keeps them: the employee number as `employeeId`,
   * the department, the organization as `companyName`, the cost center and division in
   * `employeeOrgData` (merged into what's there), and the manager as the `manager` reference. Only
   * the attributes the target names are touched (their keys are in the extension, undefined when
   * empty), and one without a value is cleared.
   */
  function enterprise(user: ScimUser, now: GraphUser | null): { body: Record<string, unknown>; manager?: string | null } {
    const e = user[SCIM_ENTERPRISE_USER_SCHEMA];
    if (!e) return { body: {} };
    const named = (a: keyof typeof e) => Object.hasOwn(e, a);
    const body: Record<string, unknown> = {};
    if (named("employeeNumber")) body.employeeId = e.employeeNumber ?? null;
    if (named("department")) body.department = e.department ?? null;
    if (named("organization")) body.companyName = e.organization ?? null;
    if (named("costCenter") || named("division")) {
      const org = { ...(now?.employeeOrgData ?? {}) };
      if (named("costCenter")) org.costCenter = e.costCenter ?? null;
      if (named("division")) org.division = e.division ?? null;
      body.employeeOrgData = org;
    }
    return named("manager") ? { body, manager: e.manager?.value ?? null } : { body };
  }

  async function setManager(id: string, manager: string | null | undefined) {
    if (manager === undefined) return;
    if (manager) {
      try {
        await request("PUT", `${path(id)}/manager/$ref`, { "@odata.id": `${base}/directoryObjects/${manager}` });
      } catch (e) {
        // The manager not there (yet: Graph's lag after their create), not this user: retried, and
        // never a 404, which would send the outbox looking for this user's account.
        if (notFoundAtGraph(e)) throw new ScimError(`the manager's Entra account (${manager}) can't be found yet; retrying`, null, true);
        throw e;
      }
      return;
    }
    try {
      await request("DELETE", `${path(id)}/manager/$ref`);
    } catch (e) {
      if (!notFoundAtGraph(e)) throw e; // no manager to remove
    }
  }

  /**
   * A change to an existing user. `accountEnabled` is only ever set to turn the account off (the
   * user left), or back on when the plugin itself turned it off (`reactivate`): an admin who
   * disabled an account, say during an incident, isn't overruled by a rename. The immutableId is
   * set only on an account that has none (one taken over): Entra refuses to change it on a
   * federated user, and anything else holding one isn't handed to us by the outbox.
   */
  async function update(id: string, user: ScimUser, o: { reactivate?: boolean } = {}) {
    const { user: now, lagging } = await current(id, user.externalId);
    const { body: extra, manager } = enterprise(user, now);
    const body: Record<string, unknown> = { ...names(user), userPrincipalName: user.userName, ...extra };
    if (!now.onPremisesImmutableId && user.externalId) body.onPremisesImmutableId = user.externalId;
    if (!user.active || o.reactivate) body.accountEnabled = user.active;
    try {
      await request("PATCH", path(id), body);
      await setManager(id, manager);
    } catch (e) {
      // No status: a 404 would send the outbox looking for the account (and creating it again).
      if (lagging && notFoundAtGraph(e)) throw new ScimError(`${user.userName}: Microsoft is still creating the account; retrying`, null, true);
      throw e;
    }
  }

  /**
   * Another object holds the immutableId: if it's this user's account (a create whose reply was
   * lost, or a user deleted into the recycle bin and now back), it's theirs again: restored from
   * the bin if need be (which keeps its userPrincipalName and immutableId; tested live), and updated.
   */
  async function reclaim(holder: string, user: ScimUser): Promise<string> {
    const live = await request("GET", `${path(holder)}?$select=${SELECT}`).catch((e) => {
      if (notFoundAtGraph(e)) return null;
      throw e;
    });
    if (live?.id) {
      if (live.onPremisesImmutableId !== user.externalId) throw new ScimError(`POST /users: the immutableId ${user.externalId} belongs to another Entra account (${holder})`, 409, false);
      try {
        await update(holder, user);
      } catch (e) {
        // For seconds after a delete, Graph still reads the user as live but answers changes with
        // 404 (found live): retried, and then found in the recycle bin and restored.
        if (notFoundAtGraph(e)) throw new ScimError(`${user.userName}: Microsoft still shows the account, but it's on its way to the recycle bin; retrying`, null, true);
        throw e;
      }
      return holder;
    }
    const binned = await request("GET", `/directory/deletedItems/${encodeURIComponent(holder)}?$select=${SELECT}`).catch((e) => {
      if (notFoundAtGraph(e)) return null;
      throw e;
    });
    // Neither yet: Graph names an object its replicas don't show yet (our own create, seconds ago).
    if (!binned?.id) throw new ScimError(`${user.userName}: Microsoft says the account exists but can't find it yet; retrying`, 409, true);
    if (binned.onPremisesImmutableId !== user.externalId) throw new ScimError(`POST /users: the immutableId ${user.externalId} belongs to a deleted Entra account (${holder}) that isn't this user's`, 409, false);
    await request("POST", `/directory/deletedItems/${encodeURIComponent(holder)}/restore`);
    try {
      await update(holder, user, { reactivate: true });
    } catch (e) {
      if (notFoundAtGraph(e)) throw new ScimError(`${user.userName}: restored from Entra's recycle bin, and Microsoft is still bringing it back; retrying`, null, true);
      throw e;
    }
    return holder;
  }

  const groupsUnsupported = async (): Promise<never> => {
    throw new ScimError("groups aren't supported for Entra ID targets yet", null, false);
  };

  const found = (u: GraphUser | null) => (u?.id ? { id: u.id, externalId: u.onPremisesImmutableId || null, active: u.accountEnabled !== false } : null);

  return {
    findByUserName: async (userName: string) => found(await findBy("userPrincipalName", userName)),
    findByExternalId: async (externalId: string) => found(await findBy("onPremisesImmutableId", externalId)),
    async enabled(id: string) {
      try {
        return (await request("GET", `${path(id)}?$select=accountEnabled`))?.accountEnabled !== false;
      } catch (e) {
        if (notFoundAtGraph(e)) return null;
        throw e;
      }
    },
    async create(user: ScimUser) {
      const { body: extra, manager } = enterprise(user, null);
      const set = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
      const body = {
        accountEnabled: user.active,
        ...set(names(user)),
        userPrincipalName: user.userName,
        mailNickname: mailNickname(user.userName),
        ...(user.externalId ? { onPremisesImmutableId: user.externalId } : {}),
        ...set(extra),
        ...(extra.employeeOrgData ? { employeeOrgData: set(extra.employeeOrgData as Record<string, unknown>) } : {}),
      };
      let created: GraphUser | null;
      try {
        try {
          // No password: on a federated domain the user signs in through the IdP (tested live).
          created = await request("POST", "/users", body);
        } catch (e) {
          // A managed (cloud) domain wants one: a random one nobody knows.
          if (!(e instanceof GraphError && e.status === 400 && !e.conflict && /password/i.test(e.message))) throw e;
          created = await request("POST", "/users", { ...body, passwordProfile: { password: throwaway(), forceChangePasswordNextSignIn: false } });
        }
      } catch (e) {
        if (!(e instanceof GraphError && e.conflict)) throw e;
        if (e.conflict === "onPremisesImmutableId" && e.holder && user.externalId) return reclaim(e.holder, user);
        // The userPrincipalName (or an address) is another account's: a 409, so the outbox looks it up and decides.
        throw new ScimError(`POST /users: ${user.userName}: another Entra account already has this ${e.conflict}`, 409, false);
      }
      if (!created?.id) throw new ScimError("POST /users: the response has no id", null, false);
      // If this fails, the retry finds the account by its immutableId (above) and sets it then.
      await setManager(created.id, manager);
      return created.id;
    },
    replace: update,
    patch: (id: string, user: ScimUser) => update(id, user),
    /** Off: the account is disabled, and its sessions revoked, so a signed-in user is out at once rather than at their token's expiry. */
    async setActive(id: string, active: boolean) {
      await request("PATCH", path(id), { accountEnabled: active });
      if (!active) await request("POST", `${path(id)}/revokeSignInSessions`);
    },
    /** Into Entra's recycle bin (30 days), never purged: a user back within that time is restored. */
    async remove(id: string) {
      await request("DELETE", path(id));
    },
    findGroupByName: groupsUnsupported,
    groupMembers: groupsUnsupported,
    createGroup: groupsUnsupported,
    createGroupInBatches: groupsUnsupported,
    replaceGroup: groupsUnsupported,
    patchGroup: groupsUnsupported,
    removeGroup: groupsUnsupported,
  };
}
