// The target registry: SCIM apps, Google Workspace domains and webhooks that organizations connect
// at runtime, stored in the database with their credentials sealed (encrypted with Better Auth's
// secret). Only data is stored, never code: a profile is chosen by name, and every stored target
// is tied to one organization, whose members and groups are the only ones it ever receives.
import { parseEnvelope, symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import * as z from "zod";
import { type Adapter, IN_BATCH, markPaused, type TargetSource } from "./outbox";
import { DEFAULT_STORED_ENTERPRISE_FIELDS, enterpriseFieldProblems, enterpriseOption, missingEnterpriseFields } from "./mapping";
import { profiles } from "./profiles";
import type { ScimTarget, Target, TargetRegistryOptions } from "./types";

export const TARGET_MODEL = "scimProvisioningTarget";
const PURPOSE = "scim-provisioning-target-credentials";

/** The key that seals credentials: Better Auth's secret configuration (rotation included), or an override. */
export type SealKey = Parameters<typeof symmetricEncrypt>[0]["key"];

/** A stored target's row. `config` holds its settings as JSON; `sealed` its credentials, encrypted. */
export interface TargetRow {
  id: string;
  targetId: string;
  organizationId: string;
  type: string;
  config: string;
  sealed: string;
  enabled: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/** A secret or header value: no control characters (a line break would break the request, and errors could repeat it). */
const hasControl = (text: string) => [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
export const secretText = (min = 1, max = 65536) =>
  z
    .string()
    .min(min, min > 1 ? `must be at least ${min} characters` : undefined)
    .max(max)
    .refine((text) => !hasControl(text), "must not contain control characters (a line break or tab, say)");

/** What a stored target may say about itself: data only (no functions), and no organization (it's the owner's). */
export const storedSettingsSchema = z.strictObject({
  /** A label for people: the target's id is generated. */
  name: z.string().min(1).max(100).refine((t) => !hasControl(t), "must not contain control characters").optional(),
  type: z.enum(["scim", "google-workspace", "webhook"]).optional(),
  url: z.string().max(2048).optional(),
  profile: z.enum(Object.keys(profiles) as [keyof typeof profiles, ...(keyof typeof profiles)[]]).optional(),
  update: z.enum(["put", "patch"]).optional(),
  compat: z
    .strictObject({
      groupUpdate: z.enum(["put", "patch"]).optional(),
      groupMembers: z.enum(["group", "users-filter"]).optional(),
      maxGroupMembersPerRequest: z.number().int().min(1).max(100_000).optional(),
      groupRename: z.enum(["rename", "recreate"]).optional(),
    })
    .optional(),
  groups: z.boolean().optional(),
  teamGroups: z.boolean().optional(),
  roleGroups: z.union([z.boolean(), z.array(z.string().min(1))]).optional(),
  adopt: z.boolean().optional(),
  deprovision: z.enum(["deactivate", "delete"]).optional(),
  requireVerifiedEmail: z.boolean().optional(),
  enterprise: enterpriseOption.optional(),
  // At most 30 s: the deliveries share the scheduled run with every other organization's.
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
  google: z.strictObject({ clientEmail: z.string().min(1), adminEmail: z.string().min(1), orgUnitPath: z.string().startsWith("/").optional(), groupDomain: z.string().regex(/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/).optional() }).optional(),
});
export type StoredSettings = z.infer<typeof storedSettingsSchema>;

/** A stored target's credentials: one kind, by its type. */
export const storedCredentialsSchema = z.union([
  z.strictObject({ token: secretText(1, 8192) }),
  z.strictObject({ auth: z.strictObject({ type: z.literal("basic"), username: secretText(1, 1024), password: secretText(1, 4096) }) }),
  z.strictObject({ auth: z.strictObject({ type: z.literal("header"), name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), value: secretText(1, 8192) }) }),
  z.strictObject({
    auth: z.strictObject({ type: z.literal("oauth2"), tokenUrl: z.string().max(2048), clientId: secretText(1, 1024), clientSecret: secretText(1, 4096), scope: z.string().max(1024).optional(), clientAuth: z.enum(["body", "basic"]).optional() }),
  }),
  z.strictObject({ secret: secretText(32, 1024) }),
  // A PEM is printable ASCII: also keeps the sealed form inside MySQL's TEXT (characters aren't bytes).
  z.strictObject({ privateKey: z.string().max(16384).regex(/^[\x20-\x7e\r\n]+$/).includes("PRIVATE KEY") }),
]);
export type StoredCredentials = z.infer<typeof storedCredentialsSchema>;

/** Which kind of credentials a stored target has, for display: never the values. */
export const credentialsKind = (c: StoredCredentials) => ("token" in c ? "bearer" : "auth" in c ? c.auth.type : "secret" in c ? "webhook-secret" : "google-service-account");

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Where a target sends, and as whom: its type, URL, and Google's service account and admin. Credentials are sealed for one destination. */
export const destination = (s: StoredSettings) => JSON.stringify([s.type ?? "scim", s.url ?? null, s.google?.clientEmail ?? null, s.google?.adminEmail ?? null]);

/** Credentials sealed for one target, of one organization, sending to one destination. */
export async function seal(key: SealKey, targetId: string, organizationId: string, credentials: StoredCredentials, settings: StoredSettings): Promise<string> {
  return symmetricEncrypt({ key, data: JSON.stringify({ purpose: PURPOSE, v: 1, targetId, organizationId, to: destination(settings), credentials }) });
}

/**
 * A row's credentials, refused unless the ciphertext says they're this row's (no swapping rows)
 * and for where its settings send: a URL changed in the database, not through the API (which
 * asks for the credentials again), doesn't get them.
 */
export async function unseal(key: SealKey, row: Pick<TargetRow, "targetId" | "organizationId" | "sealed" | "config">): Promise<StoredCredentials> {
  let plain: { purpose?: unknown; v?: unknown; targetId?: unknown; organizationId?: unknown; to?: unknown; credentials?: unknown };
  try {
    plain = JSON.parse(await symmetricDecrypt({ key, data: row.sealed }));
  } catch {
    throw new Error(`[scim] target ${row.targetId}: its credentials can't be decrypted (was the secret changed?)`);
  }
  if (plain.purpose !== PURPOSE || plain.v !== 1 || plain.targetId !== row.targetId || plain.organizationId !== row.organizationId)
    throw new Error(`[scim] target ${row.targetId}: the stored credentials belong to another target`);
  const settings = storedSettingsSchema.safeParse(parseJson(row.config));
  if (!settings.success || plain.to !== destination(settings.data))
    throw new Error(`[scim] target ${row.targetId}: its settings send somewhere its credentials weren't given for (changed outside the API?): give the credentials again`);
  return storedCredentialsSchema.parse(plain.credentials);
}

/**
 * A stored target's URL: https on port 443, and never an address inside your network
 * (localhost, names without a dot, .local, .internal, .lan, .home.arpa, and private, loopback,
 * link-local, shared, benchmark, documentation and reserved addresses, IPv4 inside IPv6
 * included), since your server is the one calling it. `allowHosts` names exceptions. A public
 * name that resolves to a private address is refused when the request is made (resolvesPrivate).
 */
export function publicUrl(value: string, allowHosts: readonly string[] = [], o: { query?: boolean } = {}): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return "isn't a URL";
  }
  if (u.protocol !== "https:") return "must be https";
  if (u.username || u.password || u.hash || value.includes("#")) return "must have no credentials or fragment";
  if (!o.query && (u.search || value.includes("?"))) return "must have no query";
  const host = hostOf(u);
  if (allowHosts.map((h) => h.toLowerCase()).includes(host)) return null;
  // URL drops the default port: any port left isn't 443.
  if (u.port) return "must use the standard https port (443)";
  if (internalName(host)) return "must be a public host";
  if (privateAddress(host)) return "must not be a private, loopback, link-local or reserved address";
  return null;
}

/** The host as compared: lower case, no brackets, no trailing dot ("localhost." is localhost). URL has already turned other spellings of IPv4 (2130706433, 0x7f.1, 127.1) into dotted form. */
const hostOf = (u: URL) => u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");

const internalName = (host: string) =>
  host === "localhost" || [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp", ".svc", ".cluster.local"].some((s) => host.endsWith(s)) || (!host.includes(".") && !host.includes(":"));

function privateV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // shared (carrier-grade NAT)
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) // special and documentation
  );
}

/** An IPv6 address as its eight 16-bit words (a dotted IPv4 tail included), or null. */
function v6words(host: string): number[] | null {
  let h = host.split("%")[0] as string;
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (dotted) {
    const [p, q, r, t] = dotted.slice(2).map(Number) as [number, number, number, number];
    h = `${dotted[1]}${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? (halves[0] as string).split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? (halves[1] as string).split(":") : []) : null;
  const words = tail === null ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  if (words.length !== 8 || words.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return null;
  return words.map((w) => Number.parseInt(w, 16));
}

/** Is this IP address (v4 dotted, or v6) one inside a network rather than on the internet? */
export function privateAddress(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return privateV4(Number(v4[1]), Number(v4[2]), Number(v4[3]));
  if (!host.includes(":")) return false;
  const w = v6words(host.toLowerCase());
  if (!w) return true; // not an address we can read: refused
  const [w0, w1, w2, w3, w4, w5, w6, w7] = w as [number, number, number, number, number, number, number, number];
  const embedded = () => privateV4(w6 >> 8, w6 & 255, w7 >> 8);
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0) {
    if (w4 === 0 && (w5 === 0xffff || w5 === 0)) return w5 === 0 && w6 === 0 ? true : embedded(); // ::, ::1, mapped ::ffff:a.b.c.d, compatible ::a.b.c.d
    if (w4 === 0xffff && w5 === 0) return embedded(); // SIIT ::ffff:0:a.b.c.d
    return true;
  }
  return (
    (w0 === 0x64 && w1 === 0xff9b) || // NAT64, well-known and local: reaches IPv4 inside
    w0 === 0x2002 || // 6to4
    (w0 === 0x2001 && (w1 === 0 || w1 === 0xdb8)) || // Teredo, documentation
    (w0 === 0x100 && w1 === 0 && w2 === 0 && w3 === 0) || // discard
    (w0 & 0xfe00) === 0xfc00 || // unique local
    (w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0 || // link-local, site-local
    (w0 & 0xff00) === 0xff00 // multicast
  );
}

/**
 * Wraps a fetch so every request of a stored target is checked as it's made: the URL by the same
 * rules as when it was stored (so a row allowed once, or written outside the API, can't reach an
 * address inside your network), then its host looked up, and refused if any address it resolves
 * to is private (a public name pointing inside: 127.0.0.1.nip.io, split-horizon DNS) or if it
 * can't be resolved. Where the runtime can't resolve names (Workers, whose fetch can't reach
 * private networks anyway), it's the URL check alone. A name that resolves differently a moment
 * later (DNS rebinding) can't be ruled out this way: an egress proxy can.
 */
export function guardedFetch(allowHosts: readonly string[] = [], base?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const problem = publicUrl(url, allowHosts, { query: true });
    if (problem) throw new Error(`refused to send to ${new URL(url).host}: the URL ${problem}`);
    const host = hostOf(new URL(url));
    if (!allowHosts.map((h) => h.toLowerCase()).includes(host) && !host.includes(":") && !/^[\d.]+$/.test(host)) {
      const addresses = await resolve(host);
      if (addresses?.some(privateAddress)) throw new Error(`${host} resolves to a private address`);
    }
    return (base ?? fetch)(input, init);
  };
}

let warnedNoResolver = false;

/** The addresses a name resolves to, where the runtime can tell (Node.js, Bun, Deno); null where it can't. Throws if the name doesn't resolve: refused, not let through. */
async function resolve(host: string): Promise<string[] | null> {
  // Workers: node:dns would ask a DNS-over-HTTPS service, a request before every request, and its
  // fetch can't reach private networks anyway.
  if ((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers") return null;
  const get = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
  const dns = typeof get === "function" ? (get("node:dns") as { promises?: { lookup(h: string, o: { all: true; verbatim: true }): Promise<{ address: string }[]> } } | undefined) : undefined;
  if (!dns?.promises?.lookup) {
    if (!warnedNoResolver) {
      warnedNoResolver = true;
      console.warn("[scim] stored targets: this runtime can't look names up (Node.js before 22.3?), so names resolving to private addresses aren't refused: use registry.fetch with an egress proxy, or a newer runtime");
    }
    return null;
  }
  try {
    return (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address.toLowerCase());
  } catch (e) {
    // A lookup that fails here and succeeds for the request a moment later could point anywhere.
    throw new Error(`${host} could not be resolved (${(e as { code?: string }).code ?? "lookup failed"})`);
  }
}

/** A stored row as a target: its settings, its credentials, its profile, tied to its organization. */
export async function targetOf(key: SealKey, row: TargetRow, fetch?: typeof globalThis.fetch): Promise<Target> {
  return assemble(row, storedSettingsSchema.parse(JSON.parse(row.config)), await unseal(key, row), fetch);
}

/** A target from its parts: settings and credentials already checked. */
export function assemble(row: Pick<TargetRow, "targetId" | "organizationId">, settings: StoredSettings, credentials: StoredCredentials, fetch?: typeof globalThis.fetch): Target {
  const { profile, google, name: _, ...rest } = settings;
  const base = { ...rest, id: row.targetId, organizationId: row.organizationId, ...(fetch ? { fetch } : {}) };
  if (settings.type === "webhook") return { ...base, type: "webhook", url: settings.url as string, secret: (credentials as { secret: string }).secret } as Target;
  if (settings.type === "google-workspace") return { ...base, type: "google-workspace", google: { ...(google as object), privateKey: (credentials as { privateKey: string }).privateKey } } as Target;
  const scim = { ...base, type: "scim", url: settings.url as string, ...("token" in credentials ? { token: credentials.token } : "auth" in credentials ? { auth: credentials.auth } : {}) } as ScimTarget;
  return profile ? profiles[profile](scim) : scim;
}

/**
 * What's wrong with a stored target's settings and credentials, beyond their shapes: the
 * credentials its type takes, and URLs that are https and public (`allowHosts` aside).
 */
export function storedProblems(settings: StoredSettings, credentials: StoredCredentials, allowHosts: readonly string[] = [], enterpriseAllowed: readonly string[] = DEFAULT_STORED_ENTERPRISE_FIELDS): string[] {
  const issues: string[] = [...enterpriseFieldProblems(settings.enterprise, enterpriseAllowed)];
  const type = settings.type ?? "scim";
  const kind = credentialsKind(credentials);
  const takes = { scim: ["bearer", "basic", "header", "oauth2"], webhook: ["webhook-secret"], "google-workspace": ["google-service-account"] }[type];
  if (!takes.includes(kind)) issues.push(`credentials: a ${type} target takes ${type === "scim" ? "token or auth" : type === "webhook" ? "secret" : "privateKey"}`);
  if (type === "google-workspace") {
    if (!settings.google) issues.push("settings.google: required for a google-workspace target");
    if (settings.url !== undefined) issues.push("settings.url: not for a google-workspace target");
  } else {
    if (settings.google) issues.push(`settings.google: not for a ${type} target`);
    if (settings.url === undefined) issues.push("settings.url: required");
    else {
      const problem = publicUrl(settings.url, allowHosts, { query: type === "webhook" });
      if (problem) issues.push(`settings.url: ${problem}`);
    }
  }
  if (type !== "scim") for (const k of ["profile", "update", "compat"] as const) if (settings[k] !== undefined) issues.push(`settings.${k}: for scim targets only`);
  if ("auth" in credentials && credentials.auth.type === "oauth2") {
    const problem = publicUrl(credentials.auth.tokenUrl, allowHosts);
    if (problem) issues.push(`credentials.auth.tokenUrl: ${problem}`);
  }
  return issues;
}

/** Stand-in credentials for a paused target whose own can't be read: never sent (delivery holds a paused target's jobs). */
const UNREADABLE: Record<string, StoredCredentials> = {
  scim: { token: "unreadable" },
  webhook: { secret: "unreadable-unreadable-unreadable-" },
  "google-workspace": { privateKey: "-----BEGIN PRIVATE KEY----- unreadable" },
};

const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";

/** Was this sealed with an older secret (Better Auth's `secrets` rotation)? Then it's sealed again with the current one. */
const sealedWithOldSecret = (key: SealKey, sealed: string) => typeof key !== "string" && parseEnvelope(sealed)?.version !== key.currentVersion;

/**
 * Code targets, and stored ones read from the database when they're needed: by id for a delivery,
 * by organization for a change. Nothing is listed in memory, so the cost of a change doesn't grow
 * with the number of organizations, and every server sees a target the moment it's stored,
 * disabled or removed. Decrypted targets are kept while their row is unchanged.
 */
export function registrySource(code: Target[], adapter: Adapter, key: SealKey, options: TargetRegistryOptions, log: { error(m: string): void }, userFields?: ReadonlySet<string>): TargetSource {
  const byId = new Map(code.map((t) => [t.id, t]));
  // Your own fetch replaces the resolving check (a proxy's, say); otherwise names are checked before each request.
  const fetchFor = options.fetch ?? guardedFetch(options.allowHosts);
  const built = new Map<string, { stamp: string; target: Target }>();
  const build = async (row: TargetRow): Promise<Target> => {
    const stamp = `${truthy(row.enabled)}|${row.config}|${row.sealed}`;
    const hit = built.get(row.targetId);
    if (hit?.stamp === stamp) return hit.target;
    let target: Target;
    let settings: StoredSettings | undefined;
    try {
      settings = storedSettingsSchema.parse(JSON.parse(row.config));
      // Checked again when used: a row written outside the API, or a host that narrowed the list since.
      const fieldProblems = [
        ...enterpriseFieldProblems(settings.enterprise, options.enterpriseFields ?? DEFAULT_STORED_ENTERPRISE_FIELDS),
        ...(userFields ? missingEnterpriseFields(settings.enterprise, userFields).map((f) => `settings.enterprise: the users have no field ${f}`) : []),
      ];
      if (fieldProblems.length) throw new Error(fieldProblems.join("; "));
      const credentials = await unseal(key, row);
      target = assemble(row, settings, credentials, fetchFor);
      if (!truthy(row.enabled)) markPaused(target);
      if (sealedWithOldSecret(key, row.sealed)) {
        try {
          // Only over the credentials read: ones saved meanwhile (an administrator replacing a leaked token) stay.
          await adapter.updateMany({ model: TARGET_MODEL, where: [{ field: "id", value: row.id }, { field: "sealed", value: row.sealed }], update: { sealed: await seal(key, row.targetId, row.organizationId, credentials, settings) } });
        } catch (e) {
          log.error(`[scim] stored target ${row.targetId}: could not seal its credentials with the current secret: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      // Paused, never dropped: its jobs are tried again every few minutes (no attempt counted), so
      // they go once it's given new credentials or the right secret is back.
      log.error(`[scim] stored target ${row.targetId}: ${(e as Error).message}; paused until it's fixed`);
      const type = settings?.type ?? "scim";
      target = markPaused(assemble(row, settings ?? { url: "https://unreadable.invalid" }, UNREADABLE[type] as StoredCredentials), "unreadable");
    }
    built.set(row.targetId, { stamp, target });
    if (built.size > 1000) built.delete(built.keys().next().value as string);
    return target;
  };
  /** Every row matching, a page at a time, exact matches only (a collation mustn't widen it). */
  const rows = async (where: { field: string; value: unknown; operator?: "in" }[], keep: (r: TargetRow) => boolean) => {
    const out: TargetRow[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = (await adapter.findMany({ model: TARGET_MODEL, where, limit: 500, offset, sortBy: { field: "targetId", direction: "asc" } })) as TargetRow[];
      out.push(...page.filter((r) => keep(r) && !byId.has(r.targetId)));
      if (page.length < 500) return out;
    }
  };
  return {
    scoped: true,
    async get(id) {
      const inCode = byId.get(id);
      if (inCode) return inCode;
      const [row] = await rows([{ field: "targetId", value: id }], (r) => r.targetId === id);
      return row ? build(row) : null;
    },
    async forOrganizations(organizationIds) {
      const ids = [...new Set(organizationIds)];
      const stored: Target[] = [];
      // D1 allows 100 bound parameters per query.
      for (let i = 0; i < ids.length; i += IN_BATCH) {
        const batch = ids.slice(i, i + IN_BATCH);
        for (const row of await rows([{ field: "organizationId", value: batch, operator: "in" }], (r) => batch.includes(r.organizationId))) stored.push(await build(row));
      }
      return [...code.filter((t) => !t.organizationId || ids.includes(t.organizationId)), ...stored];
    },
    async every() {
      const stored: Target[] = [];
      for (const row of await rows([], () => true)) stored.push(await build(row));
      return [...code, ...stored];
    },
  };
}
