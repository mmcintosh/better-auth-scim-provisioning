// The target registry: SCIM apps, Google Workspace domains and webhooks that organizations connect
// at runtime, stored in the database with their credentials sealed (encrypted with Better Auth's
// secret). Only data is stored, never code: a profile is chosen by name, and every stored target
// is tied to one organization, whose members and groups are the only ones it ever receives.
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import * as z from "zod";
import type { Adapter, TargetSource } from "./outbox";
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
export const secretText = (min = 1) =>
  z
    .string()
    .min(min, min > 1 ? `must be at least ${min} characters` : undefined)
    .refine((text) => !hasControl(text), "must not contain control characters (a line break or tab, say)");

/** What a stored target may say about itself: data only (no functions), and no organization (it's the owner's). */
export const storedSettingsSchema = z.strictObject({
  type: z.enum(["scim", "google-workspace", "webhook"]).optional(),
  url: z.string().optional(),
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
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  google: z.strictObject({ clientEmail: z.string().min(1), adminEmail: z.string().min(1), orgUnitPath: z.string().startsWith("/").optional(), groupDomain: z.string().regex(/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/).optional() }).optional(),
});
export type StoredSettings = z.infer<typeof storedSettingsSchema>;

/** A stored target's credentials: one kind, by its type. */
export const storedCredentialsSchema = z.union([
  z.strictObject({ token: secretText() }),
  z.strictObject({ auth: z.strictObject({ type: z.literal("basic"), username: secretText(), password: secretText() }) }),
  z.strictObject({ auth: z.strictObject({ type: z.literal("header"), name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), value: secretText() }) }),
  z.strictObject({
    auth: z.strictObject({ type: z.literal("oauth2"), tokenUrl: z.string(), clientId: secretText(), clientSecret: secretText(), scope: z.string().optional(), clientAuth: z.enum(["body", "basic"]).optional() }),
  }),
  z.strictObject({ secret: secretText(32) }),
  z.strictObject({ privateKey: z.string().includes("PRIVATE KEY") }),
]);
export type StoredCredentials = z.infer<typeof storedCredentialsSchema>;

/** Which kind of credentials a stored target has, for display: never the values. */
export const credentialsKind = (c: StoredCredentials) => ("token" in c ? "bearer" : "auth" in c ? c.auth.type : "secret" in c ? "webhook-secret" : "google-service-account");

export async function seal(key: SealKey, targetId: string, organizationId: string, credentials: StoredCredentials): Promise<string> {
  return symmetricEncrypt({ key, data: JSON.stringify({ purpose: PURPOSE, v: 1, targetId, organizationId, credentials }) });
}

/** A row's credentials, refused unless the ciphertext says they're this row's (no swapping rows). */
export async function unseal(key: SealKey, row: Pick<TargetRow, "targetId" | "organizationId" | "sealed">): Promise<StoredCredentials> {
  let plain: { purpose?: unknown; v?: unknown; targetId?: unknown; organizationId?: unknown; credentials?: unknown };
  try {
    plain = JSON.parse(await symmetricDecrypt({ key, data: row.sealed }));
  } catch {
    throw new Error(`[scim] target ${row.targetId}: its credentials can't be decrypted (was the secret changed?)`);
  }
  if (plain.purpose !== PURPOSE || plain.v !== 1 || plain.targetId !== row.targetId || plain.organizationId !== row.organizationId)
    throw new Error(`[scim] target ${row.targetId}: the stored credentials belong to another target`);
  return storedCredentialsSchema.parse(plain.credentials);
}

/**
 * A stored target's URL: https only, and never an address inside your network (localhost, private,
 * link-local or shared ranges, .local and .internal names), since your server is the one calling
 * it. `allowHosts` names exceptions. A name that resolves to a private address can't be caught
 * here (Workers can't resolve names): put the server where that can't reach anything it shouldn't.
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
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (allowHosts.map((h) => h.toLowerCase()).includes(host)) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") && !host.includes(":")) return "must be a public host";
  if (privateAddress(host)) return "must not be a private, loopback or link-local address";
  return null;
}

function privateAddress(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (!host.includes(":")) return false;
  const h = host.toLowerCase();
  // An IPv4 address inside IPv6 (::ffff:a.b.c.d, which URL writes as ::ffff:XXXX:XXXX): judged as IPv4.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) {
    const [hi, lo] = [Number.parseInt(mapped[1] as string, 16), Number.parseInt(mapped[2] as string, 16)];
    return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb") || h.startsWith("ff");
}

/** A stored row as a target: its settings, its credentials, its profile, tied to its organization. */
export async function targetOf(key: SealKey, row: TargetRow, fetch?: typeof globalThis.fetch): Promise<Target> {
  const settings = storedSettingsSchema.parse(JSON.parse(row.config));
  const credentials = await unseal(key, row);
  const { profile, google, ...rest } = settings;
  const base = { ...rest, id: row.targetId, organizationId: row.organizationId, ...(fetch ? { fetch } : {}) };
  if (settings.type === "webhook") return { ...base, type: "webhook", url: settings.url as string, secret: (credentials as { secret: string }).secret } as Target;
  if (settings.type === "google-workspace") return { ...base, type: "google-workspace", google: { ...(google as object), privateKey: (credentials as { privateKey: string }).privateKey } } as Target;
  const scim = { ...base, type: "scim", url: settings.url as string, ...("token" in credentials ? { token: credentials.token } : "auth" in credentials ? { auth: credentials.auth } : {}) } as ScimTarget;
  return profile ? profiles[profile](scim) : scim;
}

/** Code targets first, then stored ones: listed from a short cache, but looked up in the database on a miss. */
export function registrySource(code: Target[], adapter: Adapter, key: SealKey, options: TargetRegistryOptions, log: { error(m: string): void }): TargetSource & { forget(): void } {
  const cacheMs = (options.cacheSeconds ?? 60) * 1000;
  const byId = new Map(code.map((t) => [t.id, t]));
  let cache: { at: number; targets: Map<string, Target | "paused"> } | null = null;
  const build = async (row: TargetRow): Promise<Target | "paused"> => {
    try {
      const target = await targetOf(key, row, options.fetch);
      return row.enabled ? target : "paused";
    } catch (e) {
      // A row that no longer builds (the secret changed, say) is logged and treated as paused:
      // its jobs wait, never dropped.
      log.error(`[scim] stored target ${row.targetId}: ${(e as Error).message}`);
      return "paused";
    }
  };
  const load = async () => {
    if (cache && Date.now() - cache.at < cacheMs) return cache.targets;
    const rows = (await adapter.findMany({ model: TARGET_MODEL, limit: 10_000 })) as TargetRow[];
    const targets = new Map<string, Target | "paused">();
    for (const row of rows) if (!byId.has(row.targetId)) targets.set(row.targetId, await build(row));
    cache = { at: Date.now(), targets };
    return targets;
  };
  return {
    async all() {
      const stored = await load();
      return [...code, ...[...stored.values()].filter((t): t is Target => t !== "paused")];
    },
    async get(id) {
      const inCode = byId.get(id);
      if (inCode) return inCode;
      const cached = (await load()).get(id);
      if (cached !== undefined) return cached;
      // Not in the cache: maybe created since (by another isolate). The database decides.
      const row = ((await adapter.findMany({ model: TARGET_MODEL, where: [{ field: "targetId", value: id }], limit: 2 })) as TargetRow[]).find((r) => r.targetId === id);
      return row ? build(row) : null;
    },
    forget() {
      cache = null;
    },
  };
}
