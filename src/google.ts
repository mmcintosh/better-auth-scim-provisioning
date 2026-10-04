// Google Workspace through its Directory API, for targets with `type: "google-workspace"`: the
// same operations as the SCIM client (find by userName, create, replace, patch, set active,
// remove), so the outbox treats both alike. Google doesn't speak SCIM: users are `primaryEmail`,
// `name`, `suspended`, and our id is a custom entry in `externalIds`. Users only, for now.
import { credentials } from "./credentials";
import { retryAfterMs, ScimError, type ScimUser, type scimClient, trimSlashes } from "./scim-client";
import type { Target } from "./types";

export const GOOGLE_DIRECTORY_URL = "https://admin.googleapis.com/admin/directory/v1";
const SCOPE = "https://www.googleapis.com/auth/admin.directory.user";
/** The `externalIds` entry that marks a Workspace user as ours. */
const OURS = { type: "custom", customType: "better-auth" } as const;

interface GoogleUser {
  suspended?: boolean;
  id?: string;
  primaryEmail?: string;
  externalIds?: { value?: string; type?: string; customType?: string }[];
}

export function googleWorkspaceClient(target: Target): ReturnType<typeof scimClient> {
  const google = target.google;
  if (!google) throw new Error(`[scim] target ${target.id}: type "google-workspace" needs google`);
  const base = trimSlashes(target.url ?? GOOGLE_DIRECTORY_URL);
  const doFetch = target.fetch ?? fetch;
  const timeoutMs = target.timeoutMs ?? 10_000;
  const creds = credentials(
    { type: "google", clientEmail: google.clientEmail, privateKey: google.privateKey, subject: google.adminEmail, scopes: [SCOPE], tokenUrl: google.tokenUrl },
    { fetch: doFetch, timeoutMs },
  );

  /** One Directory API call. A 404 comes back as null only when Google itself says the user doesn't exist. */
  async function request(method: string, path: string, body?: unknown, retried = false): Promise<GoogleUser | null> {
    let res: Response;
    const authorization = await creds.headers();
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { ...authorization, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
      throw new ScimError(`${method} ${path}: ${timedOut ? `no response within ${timeoutMs} ms` : (e as Error).message}`, null, true);
    }
    const text = await res.text();
    let json: { error?: { code?: unknown; message?: unknown } } & GoogleUser = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {}
    if (res.ok) return json;
    if (res.status === 401 && !retried && creds.rejected()) return request(method, path, body, true);
    // Retried: a passing redirect (maintenance) clears by itself, and a wrong URL is the host's to fix.
    if (res.status >= 300 && res.status < 400) throw new ScimError(`${method} ${path}: redirected (${res.status}); check the target's url`, res.status, true, retryAfterMs(res.headers.get("retry-after")));
    const google404 = res.status === 404 && typeof json.error?.code === "number";
    // Not Google's own "not found" (a wrong URL answers 404 for everything): the host's to fix.
    const misplaced = res.status === 404 && !google404;
    const auth = res.status === 401 || res.status === 403;
    // 412 "User creation is not complete": Google is still making a user created seconds ago.
    const creating = res.status === 412;
    const retryable = res.status === 408 || res.status === 412 || res.status === 429 || res.status >= 500 || auth || misplaced;
    const message = typeof json.error?.message === "string" ? ` ${json.error.message.slice(0, 300)}` : "";
    throw new ScimError(
      `${method} ${path}: ${res.status}${auth ? " (check the service account, its domain-wide delegation and the admin)" : misplaced ? " (check the target's url)" : creating ? " (Google is still creating the user; retrying)" : ""}${message}`,
      res.status,
      retryable,
      retryable ? retryAfterMs(res.headers.get("retry-after")) : undefined,
    );
  }

  const path = (key: string) => `/users/${encodeURIComponent(key)}`;
  const oursIn = (u: GoogleUser) => u.externalIds?.find((x) => x.type === OURS.type && x.customType === OURS.customType)?.value || null;

  /** The Directory API user for a SCIM user: everything but the password. */
  function toGoogle(user: ScimUser) {
    const [first, ...rest] = (user.displayName ?? user.userName).split(" ");
    return {
      primaryEmail: user.userName,
      // Google requires both names.
      name: { givenName: user.name?.givenName || first || user.userName, familyName: user.name?.familyName || rest.join(" ") || first || user.userName },
      suspended: !user.active,
    };
  }

  /**
   * The user as Google has them now. For a few seconds after a create, Google answers 404 by id
   * (found live) though the user is there by email, and updates by id already work: so a 404 by id
   * is asked again by email, and taken only if it's the same user.
   */
  async function current(id: string, userName: string): Promise<GoogleUser | null> {
    try {
      return await request("GET", path(id));
    } catch (e) {
      if (!(e instanceof ScimError && e.status === 404 && !e.retryable)) throw e;
      const byEmail = await request("GET", path(userName)).catch(() => null);
      if (byEmail?.id === id) return byEmail;
      throw e;
    }
  }

  /** Our entry in externalIds, keeping any others (an admin's employee id, say). */
  async function externalIds(id: string, userName: string, externalId: string | undefined) {
    const others = ((await current(id, userName))?.externalIds ?? []).filter((x) => !(x.type === OURS.type && x.customType === OURS.customType));
    return externalId ? [...others, { ...OURS, value: externalId }] : others;
  }

  /**
   * A change to an existing user. While Google applies an email change (a rename, for a minute or
   * more), it answers further changes with 409 "Entity already exists" (found live): retried, or a
   * ban right after an email change would fail for good. Only a new address that another account
   * holds is a real conflict.
   */
  async function change(id: string, body: Record<string, unknown>, newEmail?: string) {
    try {
      await request("PATCH", path(id), body);
    } catch (e) {
      if (!(e instanceof ScimError && e.status === 409)) throw e;
      if (newEmail) {
        const holder = await request("GET", path(newEmail)).catch(() => null);
        if (holder?.id && holder.id !== id) throw new ScimError(`PATCH ${path(id)}: ${newEmail} belongs to another Workspace account`, 409, false);
      }
      throw new ScimError(`PATCH ${path(id)}: 409 (Google is still applying an earlier change, such as a new email; retrying)`, 409, true);
    }
  }

  async function update(id: string, user: ScimUser) {
    await change(id, { ...toGoogle(user), externalIds: await externalIds(id, user.userName, user.externalId) }, user.userName);
  }

  const noGroups = async (): Promise<never> => {
    throw new ScimError(`${target.id}: Google Workspace targets don't provision groups yet`, null, false);
  };

  return {
    async findByUserName(userName: string) {
      try {
        const u = await request("GET", path(userName));
        // Google also answers for an alias, which is someone else's account: only an exact primary email is a match.
        if (!u?.id || u.primaryEmail?.toLowerCase() !== userName.toLowerCase()) return null;
        return { id: u.id, externalId: oursIn(u), active: u.suspended !== true };
      } catch (e) {
        if (e instanceof ScimError && e.status === 404 && e.retryable === false) return null;
        throw e;
      }
    },
    async create(user: ScimUser) {
      // Required by Google; users sign in through your identity provider, so it's never used.
      const password = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
      // orgUnitPath only here: where new users go, never moving a user an admin placed elsewhere.
      let created: GoogleUser | null;
      try {
        created = await request("POST", "/users", { ...toGoogle(user), password, ...(google?.orgUnitPath ? { orgUnitPath: google.orgUnitPath } : {}), ...(user.externalId ? { externalIds: [{ ...OURS, value: user.externalId }] } : {}) });
      } catch (e) {
        // Taken as another account's alias: that account is someone else's, and no retry changes it.
        // Not reported as a 409, which would send the outbox looking for an account to adopt.
        if (e instanceof ScimError && e.status === 409) {
          const holder = await request("GET", path(user.userName)).catch(() => null);
          if (holder?.primaryEmail && holder.primaryEmail.toLowerCase() !== user.userName.toLowerCase())
            throw new ScimError(`POST /users: ${user.userName} is an alias of another Workspace account`, null, false);
        }
        throw e;
      }
      if (!created?.id) throw new ScimError("POST /users: the response has no id", null, false);
      return created.id;
    },
    replace: update,
    patch: update,
    async setActive(id: string, active: boolean) {
      await change(id, { suspended: !active });
    },
    async remove(id: string) {
      try {
        await request("DELETE", path(id));
      } catch (e) {
        if (e instanceof ScimError && e.status === 409) throw new ScimError(`DELETE ${path(id)}: 409 (Google is still applying an earlier change; retrying)`, 409, true);
        throw e;
      }
    },
    findGroupByName: noGroups,
    createGroup: noGroups,
    replaceGroup: noGroups,
    removeGroup: noGroups,
    patchGroup: noGroups,
    createGroupInBatches: noGroups,
  };
}
