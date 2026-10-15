import * as z from "zod";
import { SCIM_USER_SCHEMA, type ScimEnterpriseUser, type ScimUser } from "./scim-client";
import type { AttributeFields, EnterpriseFields, ProvisionedUser } from "./types";

/**
 * Given and family names from Better Auth's single `name`: the last word is the family name.
 * Some apps (AWS IAM Identity Center) refuse users without both, so a one-word name, or an empty
 * one, is used for both rather than left out.
 */
export function splitName(name: string, fallback: string): { givenName: string; familyName: string } {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { givenName: fallback, familyName: fallback };
  if (words.length === 1) return { givenName: words[0] as string, familyName: words[0] as string };
  return { givenName: words.slice(0, -1).join(" "), familyName: words.at(-1) as string };
}

/** The default SCIM user: userName and the one email are the user's email; externalId is its id. */
export function defaultScimUser(user: ProvisionedUser): ScimUser {
  const local = user.email.split("@")[0] || user.email;
  const { givenName, familyName } = splitName(user.name, local);
  const displayName = user.name.trim() || user.email;
  return {
    schemas: [SCIM_USER_SCHEMA],
    externalId: user.id,
    userName: user.email,
    name: { givenName, familyName, formatted: displayName },
    displayName,
    emails: [{ value: user.email, type: "work", primary: true }],
    active: true,
  };
}

/** Banned now: the admin plugin's ban, unless it has expired. */
export function isBanned(user: ProvisionedUser, now = Date.now()): boolean {
  if (!user.banned) return false;
  if (user.banExpires == null) return true;
  return new Date(user.banExpires).getTime() > now;
}

/** The Enterprise User attributes besides `manager`, which is a reference rather than a value. */
export const ENTERPRISE_VALUES = ["employeeNumber", "costCenter", "organization", "division", "department"] as const;
export type EnterpriseValue = (typeof ENTERPRISE_VALUES)[number];

const fieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "must be the name of a user field");
/** `enterprise`: true, or which user field holds each attribute. Data only, so stored targets can have it too. */
export const enterpriseOption = z.union([
  z.boolean(),
  z
    .strictObject({ ...Object.fromEntries(ENTERPRISE_VALUES.map((a) => [a, fieldName.optional()])), manager: fieldName.optional() } as Record<EnterpriseValue | "manager", z.ZodOptional<typeof fieldName>>)
    .refine((o) => Object.values(o).some((v) => v !== undefined), "name at least one field, or use true"),
]);

/** The user fields organizations' stored targets may read for `enterprise`, unless the host lists others (`registry.enterpriseFields`). */
export const DEFAULT_STORED_ENTERPRISE_FIELDS: readonly string[] = [...ENTERPRISE_VALUES, "managerId"];

/** Fields an `enterprise` option reads that aren't allowed: a stored target may read only the host's allowlist, never a hidden or sensitive column. */
export function enterpriseFieldProblems(option: boolean | EnterpriseFields | undefined, allowed: readonly string[]): string[] {
  const fields = enterpriseFields(option);
  if (!fields) return [];
  const bad = [...new Set(Object.values(fields).filter((f): f is string => !!f && !allowed.includes(f)))];
  return bad.length ? [`settings.enterprise: reads ${bad.join(", ")}, which the host doesn't allow organizations' targets to read (registry.enterpriseFields: ${allowed.join(", ") || "none"})`] : [];
}

/**
 * The fields a target's `enterprise` option reads, or null without it. `true` is each attribute
 * under its own name (the manager: `managerId`), for the fields the user model has (`known`): an
 * attribute without a field isn't the target's to manage, so it's neither sent nor cleared.
 */
export function enterpriseFields(option: boolean | EnterpriseFields | undefined, known?: ReadonlySet<string>): EnterpriseFields | null {
  if (!option) return null;
  if (option !== true) return option;
  const all: Record<string, string> = { ...Object.fromEntries(ENTERPRISE_VALUES.map((a) => [a, a])), manager: "managerId" };
  const fields = Object.fromEntries(Object.entries(all).filter(([, f]) => !known || known.has(f))) as EnterpriseFields;
  return Object.keys(fields).length ? fields : null;
}

/** Fields an explicit `enterprise` map names that the user model doesn't have. */
export function missingEnterpriseFields(option: boolean | EnterpriseFields | undefined, known: ReadonlySet<string>): string[] {
  if (!option || option === true) return [];
  return Object.values(option).filter((f): f is string => !!f && !known.has(f));
}

/** A field's value as an attribute: text, or a number written out; anything else (empty, null, an object) is no value. */
const textOf = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

/** The attributes `attributes` can send, each read from a user field of that name by default. */
export const ATTRIBUTE_NAMES = ["title", "phone", "mobile", "streetAddress", "locality", "region", "postalCode", "country"] as const;
export type AttributeName = (typeof ATTRIBUTE_NAMES)[number];
/** The parts of the work address, as SCIM names them. */
export const ADDRESS_PARTS = ["streetAddress", "locality", "region", "postalCode", "country"] as const;

/** `attributes`: true, or which user field holds each attribute. Data only, so stored targets can have it too. */
export const attributesOption = z.union([
  z.boolean(),
  z
    .strictObject(Object.fromEntries(ATTRIBUTE_NAMES.map((a) => [a, fieldName.optional()])) as Record<AttributeName, z.ZodOptional<typeof fieldName>>)
    .refine((o) => Object.values(o).some((v) => v !== undefined), "name at least one field, or use true"),
]);

/** The user fields organizations' stored targets may read for `attributes`, unless the host lists others (`registry.attributeFields`). */
export const DEFAULT_STORED_ATTRIBUTE_FIELDS: readonly string[] = [...ATTRIBUTE_NAMES];

/** Fields an `attributes` option reads that aren't allowed: a stored target may read only the host's allowlist. */
export function attributeFieldProblems(option: boolean | AttributeFields | undefined, allowed: readonly string[]): string[] {
  const fields = attributeFields(option);
  if (!fields) return [];
  const bad = [...new Set(Object.values(fields).filter((f): f is string => !!f && !allowed.includes(f)))];
  return bad.length ? [`settings.attributes: reads ${bad.join(", ")}, which the host doesn't allow organizations' targets to read (registry.attributeFields: ${allowed.join(", ") || "none"})`] : [];
}

/**
 * The fields a target's `attributes` option reads, or null without it. `true` is each attribute
 * under its own name, for the fields the user model has (`known`): an attribute without a field
 * isn't the target's to manage, so it's neither sent nor cleared.
 */
export function attributeFields(option: boolean | AttributeFields | undefined, known?: ReadonlySet<string>): AttributeFields | null {
  if (!option) return null;
  if (option !== true) return option;
  const fields = Object.fromEntries(ATTRIBUTE_NAMES.filter((a) => !known || known.has(a)).map((a) => [a, a])) as AttributeFields;
  return Object.keys(fields).length ? fields : null;
}

/** Fields an explicit `attributes` map names that the user model doesn't have. */
export function missingAttributeFields(option: boolean | AttributeFields | undefined, known: ReadonlySet<string>): string[] {
  if (!option || option === true) return [];
  return Object.values(option).filter((f): f is string => !!f && !known.has(f));
}

/**
 * The attributes a target reads, put on the user about to be sent: `title`, `phoneNumbers` (the
 * work number, then the mobile; the first is primary) and one work entry in `addresses`, from
 * the user's fields. An attribute `mapUser` set itself is left as it is. An attribute the target
 * names that has no value is a key holding undefined, which JSON leaves out (so a PUT clears it)
 * and Google Workspace and Entra ID read as "ours, and empty"; `clears` lists them, for a PATCH
 * to remove by path.
 */
export function withAttributes(user: ProvisionedUser, fields: AttributeFields | null, scim: ScimUser): { scim: ScimUser; clears: string[] } {
  if (!fields) return { scim, clears: [] };
  const out: ScimUser = { ...scim };
  const clears: string[] = [];
  const value = (name: AttributeName) => (fields[name] ? textOf(user[fields[name] as string]) : undefined);
  if (fields.title && scim.title === undefined) {
    out.title = value("title");
    if (out.title === undefined) clears.push("title");
  }
  if ((fields.phone || fields.mobile) && scim.phoneNumbers === undefined) {
    const phones: NonNullable<ScimUser["phoneNumbers"]> = [];
    const work = value("phone");
    const mobile = value("mobile");
    if (work) phones.push({ value: work, type: "work" });
    if (mobile) phones.push({ value: mobile, type: "mobile" });
    if (phones[0]) phones[0].primary = true;
    out.phoneNumbers = phones.length ? phones : undefined;
    if (!phones.length) clears.push("phoneNumbers");
  }
  if (ADDRESS_PARTS.some((a) => fields[a]) && scim.addresses === undefined) {
    const parts = Object.fromEntries(ADDRESS_PARTS.map((a) => [a, value(a)]).filter(([, v]) => v !== undefined));
    out.addresses = Object.keys(parts).length ? [{ type: "work", primary: true, ...parts }] : undefined;
    if (!out.addresses) clears.push("addresses");
  }
  return { scim: out, clears };
}

/** The user's Enterprise User values (manager aside), and their manager's Better Auth user id. */
export function enterpriseValues(user: ProvisionedUser, fields: EnterpriseFields): { values: ScimEnterpriseUser; managerId: string | null } {
  const values: ScimEnterpriseUser = {};
  for (const a of ENTERPRISE_VALUES) {
    const field = fields[a];
    const value = field ? textOf(user[field]) : undefined;
    if (value !== undefined) values[a] = value;
  }
  const managerId = fields.manager ? (textOf(user[fields.manager]) ?? null) : null;
  // Nobody is their own manager.
  return { values, managerId: managerId === user.id ? null : managerId };
}
