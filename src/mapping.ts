import * as z from "zod";
import { SCIM_USER_SCHEMA, type ScimEnterpriseUser, type ScimUser } from "./scim-client";
import type { EnterpriseFields, ProvisionedUser } from "./types";

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

/** The fields a target's `enterprise` option reads, or null without it. `true` is every attribute, under its own name (the manager: `managerId`). */
export function enterpriseFields(option: boolean | EnterpriseFields | undefined): EnterpriseFields | null {
  if (!option) return null;
  if (option === true) return { ...Object.fromEntries(ENTERPRISE_VALUES.map((a) => [a, a])), manager: "managerId" };
  return option;
}

/** A field's value as an attribute: text, or a number written out; anything else (empty, null, an object) is no value. */
const textOf = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

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
