import type { ScimAuth } from "./credentials";
import type { ScimUser } from "./scim-client";

/** The Better Auth user as the provisioning sees it (admin plugin fields when present). */
export interface ProvisionedUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  banned?: boolean | null | undefined;
  banExpires?: Date | string | number | null | undefined;
  [field: string]: unknown;
}

/** What every target has, whatever kind of app it is. */
export interface TargetOptions {
  /** Stable id: jobs, links and logs use it. Letters, digits, - and _. */
  id: string;
  /**
   * Who is provisioned to this target, beyond the defaults (a verified email unless
   * `requireVerifiedEmail: false`, and not banned). Only `true` includes. Anything else, and a
   * provisioned user is deprovisioned at their next delivery. Runs at delivery time, on the user
   * as stored; after changing it, run a reconcile.
   */
  include?: ((user: ProvisionedUser) => boolean | Promise<boolean>) | undefined;
  /**
   * Only users with a verified email (the default). Set false where the sign-in provider leaves
   * `emailVerified` false but the address is trusted, e.g. some SSO and OAuth setups. An
   * account that already exists at the app is still adopted only for a verified email.
   */
  requireVerifiedEmail?: boolean | undefined;
  /** Only members of this organization (Better Auth's organization plugin). */
  organizationId?: string | undefined;
  /** The SCIM user sent; default: userName = email, names split from `name`, one primary email. */
  mapUser?: ((user: ProvisionedUser) => ScimUser) | undefined;
  /**
   * How a change is sent: `put` (the default) replaces the whole user at the app, including
   * attributes set there by hand; `patch` replaces only the attributes we send. Check what the
   * app accepts with `npx better-auth-scim-provisioning check`.
   */
  update?: "put" | "patch" | undefined;
  /**
   * Organizations (Better Auth's organization plugin) as groups at the app, their provisioned
   * members as the group's members. Every organization (or only `organizationId`'s), or those a
   * filter accepts. Better Auth lets any user create organizations by default: restrict that, or
   * filter here, so a user can't put themselves in a group named as they like.
   */
  groups?: boolean | ((organization: { id: string; name: string; slug: string | null }) => boolean | Promise<boolean>) | undefined;
  /** The group's displayName; default the organization's name. */
  groupName?: ((organization: { id: string; name: string; slug: string | null }) => string) | undefined;
  /**
   * Teams (the organization plugin's `teams`) as groups, their provisioned members as the group's
   * members: every team of an organization in scope, or those a filter accepts.
   */
  teamGroups?: boolean | ((team: { id: string; name: string; organizationId: string }, organization: { id: string; name: string; slug: string | null }) => boolean | Promise<boolean>) | undefined;
  /** A team group's displayName; default "<organization> / <team>". */
  teamGroupName?: ((team: { id: string; name: string; organizationId: string }, organization: { id: string; name: string; slug: string | null }) => string) | undefined;
  /**
   * Roles in an organization as groups: every role its members hold (`true`), or these roles
   * (`["admin"]`). A member with several roles is in each role's group.
   */
  roleGroups?: boolean | string[] | undefined;
  /** A role group's displayName; default "<organization> / <role>". */
  roleGroupName?: ((role: string, organization: { id: string; name: string; slug: string | null }) => string) | undefined;
  /**
   * How this app differs from the SCIM standard, for apps that need it (the profiles set these):
   * `groupUpdate: "patch"` updates groups by a diff of members, for apps without PUT on groups;
   * `groupMembers: "users-filter"` reads a group's members with `Users?filter=groups.value eq`,
   * for apps whose groups don't list them; `maxGroupMembersPerRequest` batches member changes;
   * `groupRename: "recreate"` replaces a renamed group with a new one, for apps that can't rename.
   */
  compat?:
    | {
        groupUpdate?: "put" | "patch" | undefined;
        groupMembers?: "group" | "users-filter" | undefined;
        maxGroupMembersPerRequest?: number | undefined;
        groupRename?: "rename" | "recreate" | undefined;
      }
    | undefined;
  /** What leaving means at the app: `deactivate` (active=false, the default) or `delete`. */
  deprovision?: "deactivate" | "delete" | undefined;
  /** Per request; default 10 seconds. */
  timeoutMs?: number | undefined;
  /** For tests. */
  fetch?: typeof fetch | undefined;
}

/** An app that speaks SCIM 2.0 (the default). */
export interface ScimTarget extends TargetOptions {
  type?: "scim" | undefined;
  /** The app's SCIM base URL, without /Users. */
  url: string;
  /** Its bearer token. Or `auth`, for anything else. */
  token?: string | undefined;
  /**
   * How requests are authorised, when it isn't a bearer token: `basic`, a `header` of the app's
   * own (an API key), or `oauth2` client credentials (tokens fetched, cached and renewed).
   */
  auth?: ScimAuth | undefined;
  google?: undefined;
}

/** Google Workspace, through its Directory API (users only, for now). */
export interface GoogleWorkspaceTarget extends TargetOptions {
  type: "google-workspace";
  /** For tests; default the Directory API. */
  url?: string | undefined;
  /** Google Workspace: a service account with domain-wide delegation, acting as a Workspace admin. */
  google: {
    /** The service account's email (`client_email` in its JSON key file). */
    clientEmail: string;
    /** Its private key (`private_key`), PEM. */
    privateKey: string;
    /** The Workspace admin it acts as. */
    adminEmail: string;
    /** Where new users go, e.g. "/Provisioned"; default the root. */
    orgUnitPath?: string | undefined;
    /** For tests: the token endpoint. */
    tokenUrl?: string | undefined;
  };
  token?: undefined;
  auth?: undefined;
}

/** A target: an app that speaks SCIM, or Google Workspace. */
export type Target = ScimTarget | GoogleWorkspaceTarget;

export interface ScimProvisioningOptions {
  targets: Target[];
  /**
   * Deliveries at once in the scheduled run (`scimProvisioningRun`); default 4, 1 for one at a
   * time. Higher is faster, but every target sees that many requests at once.
   */
  concurrency?: number | undefined;
  retry?: {
    /**
     * Attempts at the normal backoff; default 8. After that, a failure that can fix itself (429,
     * 5xx, timeouts, 401/403) is retried every 6 hours. Other errors fail the job at once, until
     * the user changes again or a reconcile.
     */
    maxAttempts?: number | undefined;
    /** First retry after this; doubles each attempt, capped at 6 hours. Default 30 seconds. */
    baseDelayMs?: number | undefined;
  } | undefined;
}
