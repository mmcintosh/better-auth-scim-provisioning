// Profiles: a SCIM target set up for a specific app, from what its documentation says about how it
// differs from the SCIM standard. Each takes a target and fills in the app's needs; anything set on
// the target itself wins. "Verified" means checked live against the app; "documented" means built
// from its documentation, and checked against a model of it.
import { defaultScimUser } from "./mapping";
import type { ScimTarget } from "./types";

/** Only the keys set to something: a host's `undefined` (an unset option of its own) never removes a profile's value. */
const defined = <T extends object>(o: T | undefined): Partial<T> => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * AWS IAM Identity Center (verified live). Groups have no PUT and their GET lists no members, so
 * groups are updated by a diff of members read with `Users?filter=groups.value eq`, at most 100
 * member changes per request. Users need given, family and display names and a single primary
 * email, which the default mapping sends; the SAML NameID must equal the SCIM userName.
 */
export function awsIamIdentityCenter(target: ScimTarget): ScimTarget {
  return { ...target, compat: { groupUpdate: "patch", groupMembers: "users-filter", maxGroupMembersPerRequest: 100, ...defined(target.compat) } };
}

/**
 * A Slack userName: lowercase letters, digits, ".", "_" and "-", at most 21 characters (Slack's
 * rules; other characters become "_"). Taken from the email's local part.
 */
export function slackUserName(email: string): string {
  return (email.split("@")[0] ?? email)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .slice(0, 21);
}

/**
 * Slack (documented): userNames from the email's local part, made to fit Slack's rules (see
 * `slackUserName`). Two users with the same local part collide; give `mapUser` a different
 * userName for them. Deleting a Slack user only deactivates them.
 */
export function slack(target: ScimTarget): ScimTarget {
  return { ...target, mapUser: target.mapUser ?? ((user) => ({ ...defaultScimUser(user), userName: slackUserName(user.email) })) };
}

/**
 * Atlassian Guard (documented). Groups can't be renamed once synced, so a renamed group is created
 * anew with its members and the old one deleted; members change by PATCH. Deleting a managed
 * user only deactivates them.
 */
export function atlassian(target: ScimTarget): ScimTarget {
  return { ...target, compat: { groupUpdate: "patch", groupRename: "recreate", ...defined(target.compat) } };
}

/**
 * GitHub Enterprise Managed Users (documented). DELETE is hard deprovisioning: it permanently
 * suspends the account, which can't be reactivated, so this profile only deactivates and refuses
 * `deprovision: "delete"`. GitHub asks for at most 1,000 users an hour; keep `concurrency` low for
 * a first reconcile. The token is a classic personal access token of the setup user with
 * `scim:enterprise`, and only one system may provision the enterprise.
 */
export function githubEnterprise(target: ScimTarget): ScimTarget {
  if (target.deprovision === "delete")
    throw new Error(`[scim] target ${target.id}: GitHub's DELETE permanently suspends the account; githubEnterprise only deactivates`);
  return { ...target, deprovision: "deactivate" };
}

/**
 * Cloudflare Access (verified live). Nothing differs from the standard. Turn on seat
 * deprovisioning in the identity provider's SCIM settings, or deactivated users keep their seats.
 */
export function cloudflareAccess(target: ScimTarget): ScimTarget {
  return { ...target };
}

export const profiles = { awsIamIdentityCenter, slack, atlassian, githubEnterprise, cloudflareAccess };
