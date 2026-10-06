// What does this app's SCIM actually support? `checkScimTarget` asks it: its ServiceProviderConfig,
// then a throwaway test user taken through create, find, replace, both PATCH forms, deactivate and
// delete. The test user is always removed (or at least deactivated) at the end. Behind
// `npx better-auth-scim-provisioning check`, and usable from an admin page ("test connection").
import { credentials, type ScimAuth } from "./credentials";
import { fetchFailure, SCIM_USER_SCHEMA, scimString, targetUrl, trimSlashes } from "./scim-client";

/** Each check, by a stable id (the `name` is for people and may change). */
export type CheckId = "service-provider-config" | "create" | "keeps-external-id" | "find" | "find-any-case" | "duplicate-refused" | "update-put" | "update-patch" | "update-patch-path" | "deactivate" | "delete";

export interface CheckResult {
  id: CheckId;
  name: string;
  ok: boolean | null; // null: not applicable, or couldn't be checked
  detail: string;
}

export interface CheckOptions {
  url: string;
  token?: string | undefined;
  auth?: ScimAuth | undefined;
  /** The test user's userName; some apps only accept addresses at a verified domain. */
  userName?: string | undefined;
  timeoutMs?: number | undefined;
  /** The fetch requests go through (a proxy's); default the global `fetch`. */
  fetch?: typeof fetch | undefined;
}

const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/**
 * The `--auth` file for `check`: the auth object itself, or `{ "auth": { … } }`, checked so a
 * wrong file is a clear message rather than a crash.
 */
export function parseAuthFile(text: string): ScimAuth {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("--auth: the file isn't valid JSON");
  }
  const raw = (json && typeof json === "object" && "auth" in json ? (json as { auth: unknown }).auth : json) as Record<string, unknown> | null;
  const needs: Record<string, string[]> = { bearer: ["token"], basic: ["username", "password"], header: ["name", "value"], oauth2: ["tokenUrl", "clientId", "clientSecret"] };
  const type = raw && typeof raw.type === "string" ? raw.type : "";
  const fields = needs[type];
  if (!fields) throw new Error(`--auth: "type" must be one of ${Object.keys(needs).join(", ")}`);
  const missing = fields.filter((f) => typeof raw?.[f] !== "string" || !raw[f]);
  if (missing.length) throw new Error(`--auth: ${type} needs ${missing.join(", ")}`);
  return raw as unknown as ScimAuth;
}

export async function checkScimTarget(o: CheckOptions): Promise<CheckResult[]> {
  // The plugin's own rule: the token never goes over plain http, except to this machine.
  if (!targetUrl(o.url)) throw new Error("[scim] check: the url must be https (http only for localhost), without credentials, query or fragment");
  if (o.auth?.type === "oauth2" && !targetUrl(o.auth.tokenUrl)) throw new Error("[scim] check: the auth tokenUrl must be https (http only for localhost)");
  const base = trimSlashes(o.url);
  const doFetch = o.fetch ?? fetch;
  const creds = credentials(o.auth ?? { type: "bearer", token: o.token ?? "" }, { fetch: doFetch, timeoutMs: o.timeoutMs });
  const results: CheckResult[] = [];
  const note = (id: CheckId, name: string, ok: boolean | null, detail = "") => results.push({ id, name, ok, detail });

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null; error?: string }> {
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: { ...(await creds.headers()), accept: "application/scim+json, application/json", ...(body === undefined ? {} : { "content-type": "application/scim+json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
      });
      const text = await res.text();
      let json: Record<string, unknown> | null = null;
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {}
      return { status: res.status, json };
    } catch (e) {
      return { status: 0, json: null, error: fetchFailure(e, o.timeoutMs ?? 10_000) };
    }
  }
  const why = (r: { status: number; json: Record<string, unknown> | null; error?: string }) =>
    r.error ?? `${r.status}${typeof r.json?.detail === "string" ? ` ${r.json.detail.slice(0, 200)}` : ""}`;

  // 1. What the app says about itself.
  const spc = await call("GET", "/ServiceProviderConfig");
  if (spc.status === 200 && spc.json) {
    const flag = (k: string) => (spc.json?.[k] as { supported?: unknown } | undefined)?.supported === true;
    const schemes = Array.isArray(spc.json.authenticationSchemes) ? (spc.json.authenticationSchemes as { type?: unknown }[]).map((s) => String(s.type)).join(", ") : "";
    note("service-provider-config", "ServiceProviderConfig", true, `patch ${flag("patch")}, filter ${flag("filter")}, bulk ${flag("bulk")}, etag ${flag("etag")}, sort ${flag("sort")}${schemes ? `; auth: ${schemes}` : ""}`);
  } else note("service-provider-config", "ServiceProviderConfig", null, `not available (${why(spc)}); fine, it's optional in practice`);

  // 2. A throwaway user.
  const suffix = crypto.randomUUID().slice(0, 8);
  const userName = o.userName ?? `scim-check-${suffix}@example.com`;
  const externalId = `scim-check-${suffix}`;
  const user = (displayName: string, active = true) => ({
    schemas: [SCIM_USER_SCHEMA],
    userName,
    externalId,
    name: { givenName: "Scim", familyName: "Check" },
    displayName,
    emails: [{ value: userName, type: "work", primary: true }],
    active,
  });
  const created = await call("POST", "/Users", user("Scim Check"));
  const id = typeof created.json?.id === "string" ? created.json.id : null;
  if (!(created.status >= 200 && created.status < 300 && id)) {
    // The app may have made the user anyway (a 2xx without an id, a timeout after the write).
    note("create", "create a user", false, `${created.status >= 200 && created.status < 300 ? `${created.status} without an id` : why(created)}; if the app made it anyway, remove the test user ${userName} there by hand`);
    return results;
  }
  note("create", "create a user", true, `${created.status}, id ${id}`);
  const path = `/Users/${encodeURIComponent(id)}`;
  const read = async () => (await call("GET", path)).json;

  try {
    const fresh = await read();
    note("keeps-external-id", "keeps externalId", fresh?.externalId === externalId, fresh?.externalId === externalId ? "" : `got ${JSON.stringify(fresh?.externalId ?? null)}: adoption relies on our own links`);

    // 3. Finding by userName, exactly and in another case.
    const find = async (name: string) => {
      const r = await call("GET", `/Users?filter=${encodeURIComponent(`userName eq ${scimString(name)}`)}`);
      const list = Array.isArray(r.json?.Resources) ? (r.json.Resources as { id?: unknown }[]) : [];
      return { ok: list.some((x) => x.id === id), r };
    };
    const exact = await find(userName);
    note("find", "find by userName", exact.ok, exact.ok ? "" : why(exact.r));
    const other = await find(userName.toUpperCase());
    note("find-any-case", "find by userName, any case", other.ok, other.ok ? "" : "the filter is case-sensitive");

    // 4. A second create with the same userName: 409 is what adoption expects.
    const dup = await call("POST", "/Users", user("Scim Check Duplicate"));
    const dupId = typeof dup.json?.id === "string" && dup.json.id !== id ? dup.json.id : null;
    note("duplicate-refused", "duplicate userName refused (409)", dup.status === 409, dup.status === 409 ? "" : `got ${why(dup)}`);
    if (dupId) await call("DELETE", `/Users/${encodeURIComponent(dupId)}`);

    // 5. Updates: PUT, PATCH without a path, PATCH with paths.
    const shows = async (displayName: string) => (await read())?.displayName === displayName;
    const put = await call("PUT", path, { ...user("Scim Check Put"), id });
    note("update-put", "update with PUT", put.status < 300 && (await shows("Scim Check Put")), put.status < 300 ? "" : why(put));
    const bare = await call("PATCH", path, { schemas: [PATCH_OP], Operations: [{ op: "replace", value: { displayName: "Scim Check Patch" } }] });
    note("update-patch", "update with PATCH (no path)", bare.status < 300 && (await shows("Scim Check Patch")), bare.status < 300 ? "" : why(bare));
    const withPath = await call("PATCH", path, { schemas: [PATCH_OP], Operations: [{ op: "replace", path: "displayName", value: "Scim Check Path" }] });
    note("update-patch-path", "update with PATCH (path)", withPath.status < 300 && (await shows("Scim Check Path")), withPath.status < 300 ? "" : why(withPath));

    // 6. Deactivate, as deprovisioning does by default.
    const off = await call("PATCH", path, { schemas: [PATCH_OP], Operations: [{ op: "replace", value: { active: false } }] });
    note("deactivate", "deactivate (PATCH active false)", off.status < 300 && (await read())?.active === false, off.status < 300 ? "" : why(off));
  } finally {
    // 7. Delete, and make sure it's gone; otherwise leave it deactivated.
    const del = await call("DELETE", path);
    const after = await call("GET", path);
    note("delete", "delete", del.status < 300 && after.status === 404, del.status < 300 ? (after.status === 404 ? "" : `still there after delete (${after.status})`) : `${why(del)}; remove the test user ${userName} at the app by hand`);
  }
  return results;
}
