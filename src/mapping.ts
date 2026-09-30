import { SCIM_USER_SCHEMA, type ScimUser } from "./scim-client";
import type { ProvisionedUser } from "./types";

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
