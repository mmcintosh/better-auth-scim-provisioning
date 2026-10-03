// A host app compiled with exactOptionalPropertyTypes against the built declarations (dist/):
// `pnpm pack:check` runs it under TypeScript 7 and 5.9. The plugin must fit BetterAuthPlugin, and
// optional options must accept `undefined` from a host's own optional values.
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { awsIamIdentityCenter, checkScimTarget, githubEnterprise, type GoogleWorkspaceTarget, type ScimTarget, scimProvisioning, slack } from "better-auth-scim-provisioning";

declare const token: string;
declare const maybeOrg: string | undefined;
declare const maybeTimeout: number | undefined;

const target: ScimTarget = {
  id: "aws",
  url: "https://scim.us-east-2.amazonaws.com/example/scim/v2",
  token,
  organizationId: maybeOrg,
  timeoutMs: maybeTimeout,
  deprovision: "deactivate",
  requireVerifiedEmail: true,
  include: (user) => user.email.endsWith("@example.com"),
};

// It is a BetterAuthPlugin…
export const assignable: BetterAuthPlugin = scimProvisioning({ targets: [target], concurrency: 4, retry: { maxAttempts: 8, baseDelayMs: undefined } });
// …and, passed inline as apps do, its endpoints are typed on auth.api.
const auth = betterAuth({ plugins: [organization(), scimProvisioning({ targets: [target] })] });

// The server-only endpoints are typed on auth.api.
export const run = () => auth.api.scimProvisioningRun({ body: { limit: 50 } });
export const reconcile = () => auth.api.scimProvisioningReconcile({ body: {} });

// Reconcile a page at a time, as the README shows.
export async function reconcileInPages() {
  let next: string | null = null;
  do {
    ({ next } = await auth.api.scimProvisioningReconcile({ body: { limit: 200, after: next ?? undefined } }));
  } while (next);
}

// Other auth methods and PATCH updates, with a host's own optional values.
declare const maybeScope: string | undefined;
export const oauthTarget: ScimTarget = {
  id: "salesforce",
  url: "https://example.my.salesforce.com/services/scim/v2",
  auth: { type: "oauth2", tokenUrl: "https://example.my.salesforce.com/services/oauth2/token", clientId: "id", clientSecret: "secret", scope: maybeScope },
  update: "patch",
};
export const checked = () => checkScimTarget({ url: target.url, token, userName: undefined });

// Groups, with a host's own optional values.
declare const maybeGroups: boolean | undefined;
export const groupTarget: ScimTarget = { id: "aws-groups", url: target.url, token, groups: maybeGroups, groupName: (org) => `team-${org.slug ?? org.id}` };
export const filteredGroups: ScimTarget = { id: "teams", url: target.url, token, groups: async (org) => org.slug?.startsWith("team-") === true };
export const teamAndRoleGroups: ScimTarget = {
  id: "teams-and-roles",
  url: target.url,
  token,
  teamGroups: (team, org) => team.organizationId === org.id,
  teamGroupName: (team, org) => `${org.name}/${team.name}`,
  roleGroups: ["admin"],
  roleGroupName: (role, org) => `${org.slug ?? org.id}-${role}`,
};
declare const maybeOrgUnit: string | undefined;
export const googleTarget: GoogleWorkspaceTarget = {
  id: "google",
  type: "google-workspace",
  google: { clientEmail: "svc@project.iam.gserviceaccount.com", privateKey: token, adminEmail: "admin@example.com", orgUnitPath: maybeOrgUnit },
  deprovision: "delete",
};
// Both kinds in one targets list, as a host with a SCIM app and Google Workspace would write it.
export const both = scimProvisioning({ targets: [target, googleTarget] });
// Profiles take and return a ScimTarget, with a host's own optional values.
export const profiled = scimProvisioning({
  targets: [
    awsIamIdentityCenter({ ...target, groups: true, compat: { maxGroupMembersPerRequest: maybeTimeout } }),
    slack({ id: "slack", url: "https://api.slack.com/scim/v2", token }),
    githubEnterprise({ id: "gh", url: "https://api.github.com/scim/v2/enterprises/acme", token }),
  ],
});
