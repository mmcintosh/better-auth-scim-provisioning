// Google Workspace through its Directory API, for targets with `type: "google-workspace"`: the
// same operations as the SCIM client (find by userName, create, replace, patch, set active,
// remove), so the outbox treats both alike. Google doesn't speak SCIM: users are `primaryEmail`,
// `name`, `suspended`, and our id is a custom entry in `externalIds`. Users only, for now.
import { credentials } from "./credentials";
import { ScimError, type ScimUser, type scimClient, trimSlashes } from "./scim-client";
import type { Target } from "./types";

export const GOOGLE_DIRECTORY_URL = "https://admin.googleapis.com/admin/directory/v1";
const SCOPE = "https://www.googleapis.com/auth/admin.directory.user";
/** The `externalIds` entry that marks a Workspace user as ours. */
const OURS = { type: "custom", customType: "better-auth" } as const;

interface GoogleUser {
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
    if (res.status >= 300 && res.status < 400) throw new ScimError(`${method} ${path}: redirected (${res.status}); check the target's url`, res.status, false);
    const google404 = res.status === 404 && typeof json.error?.code === "number";
    // Not Google's own "not found" (a wrong URL answers 404 for everything): the host's to fix.
    const misplaced = res.status === 404 && !google404;
    const auth = res.status === 401 || res.status === 403;
    const retryable = res.status === 429 || res.status >= 500 || auth || misplaced;
    const message = typeof json.error?.message === "string" ? ` ${json.error.message.slice(0, 300)}` : "";
    throw new ScimError(
      `${method} ${path}: ${res.status}${auth ? " (check the service account, its domain-wide delegation and the admin)" : misplaced ? " (check the target's url)" : ""}${message}`,
      res.status,
      retryable,
      undefined,
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
      ...(google?.orgUnitPath ? { orgUnitPath: google.orgUnitPath } : {}),
    };
  }

  /** Our entry in externalIds, keeping any others (an admin's employee id, say). */
  async function externalIds(id: string, externalId: string | undefined) {
    const current = (await request("GET", path(id)))?.externalIds ?? [];
    const others = current.filter((x) => !(x.type === OURS.type && x.customType === OURS.customType));
    return externalId ? [...others, { ...OURS, value: externalId }] : others;
  }

  async function update(id: string, user: ScimUser) {
    await request("PATCH", path(id), { ...toGoogle(user), externalIds: await externalIds(id, user.externalId) });
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
        return { id: u.id, externalId: oursIn(u) };
      } catch (e) {
        if (e instanceof ScimError && e.status === 404 && e.retryable === false) return null;
        throw e;
      }
    },
    async create(user: ScimUser) {
      // Required by Google; users sign in through your identity provider, so it's never used.
      const password = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
      const created = await request("POST", "/users", { ...toGoogle(user), password, ...(user.externalId ? { externalIds: [{ ...OURS, value: user.externalId }] } : {}) });
      if (!created?.id) throw new ScimError("POST /users: the response has no id", null, false);
      return created.id;
    },
    replace: update,
    patch: update,
    async setActive(id: string, active: boolean) {
      await request("PATCH", path(id), { suspended: !active });
    },
    async remove(id: string) {
      await request("DELETE", path(id));
    },
    findGroupByName: noGroups,
    createGroup: noGroups,
    replaceGroup: noGroups,
    removeGroup: noGroups,
    patchGroup: noGroups,
    createGroupInBatches: noGroups,
  };
}
