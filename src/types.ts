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

/** Which user field holds each Enterprise User attribute; `manager` holds the manager's Better Auth user id. */
export interface EnterpriseFields {
  employeeNumber?: string | undefined;
  costCenter?: string | undefined;
  organization?: string | undefined;
  division?: string | undefined;
  department?: string | undefined;
  manager?: string | undefined;
}

/** Which user field holds each of the attributes `attributes` sends (see TargetOptions.attributes). */
export interface AttributeFields {
  /** The job title: SCIM `title`; at Google Workspace the primary organization's title; at Entra ID `jobTitle`. */
  title?: string | undefined;
  /** The work phone number: SCIM `phoneNumbers`, type work; at Entra ID `businessPhones`. */
  phone?: string | undefined;
  /** The mobile phone number: type mobile; at Entra ID `mobilePhone`. */
  mobile?: string | undefined;
  /** The work address's parts: SCIM `addresses`, type work; at Entra ID `streetAddress`, `city`, `state`, `postalCode`, `country`. */
  streetAddress?: string | undefined;
  locality?: string | undefined;
  region?: string | undefined;
  postalCode?: string | undefined;
  country?: string | undefined;
  /**
   * The user's preferred language, a language tag (`en`, `en-CA`): SCIM `preferredLanguage`; at
   * Entra ID `preferredLanguage`. Not sent to Google Workspace.
   */
  preferredLanguage?: string | undefined;
  /** Their locale, a language tag (`en-CA`): SCIM `locale`. Only to SCIM apps and webhooks. */
  locale?: string | undefined;
  /** Their time zone, an IANA name (`America/Toronto`): SCIM `timezone`. Only to SCIM apps and webhooks. */
  timezone?: string | undefined;
  /** What kind of user (`Employee`, `Contractor`: the app's words): SCIM `userType`. Only to SCIM apps and webhooks (Entra ID's means member or guest). */
  userType?: string | undefined;
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
  /**
   * Take over an account that already exists at the app, made by hand or by another tool, when
   * it's nobody's (no externalId, not linked here), active, and its userName is the user's
   * verified email. On by default, except for Google Workspace and Entra ID, where it could reach
   * someone's real mailbox (and at Entra, change how they sign in). An account taken over is never
   * deleted by this plugin, only deactivated, even with `deprovision: "delete"`.
   */
  adopt?: boolean | undefined;
  /** Only members of this organization (Better Auth's organization plugin). */
  organizationId?: string | undefined;
  /** The SCIM user sent; default: userName = email, names split from `name`, one primary email. */
  mapUser?: ((user: ProvisionedUser) => ScimUser) | undefined;
  /**
   * The Enterprise User extension (RFC 7643 §4.3): employee number, cost center, organization,
   * division, department and manager, read from fields of the user (Better Auth's
   * `user.additionalFields`). `true` reads fields of the same names, and the manager's user id
   * from `managerId`; or name the fields (`{ employeeNumber: "employeeId", manager: "reportsTo" }`),
   * listing only those to send. An empty field clears that attribute at the app. The manager is
   * sent as their id at the app, once they're provisioned there; their reports are updated when
   * that changes. At Google Workspace: the organization, cost center and department (one primary
   * organization), the employee number as an `organization` external id, and the manager relation.
   * A `mapUser` that sets the extension itself takes precedence.
   */
  enterprise?: boolean | EnterpriseFields | undefined;
  /**
   * More of the user's details, read from fields of the user (`user.additionalFields`): the job
   * title, the work and mobile phone numbers, and a work address (street, locality, region,
   * postal code, country), sent as SCIM's `title`, `phoneNumbers` and `addresses`. `true` reads
   * fields of the same names (`title`, `phone`, `mobile`, `streetAddress`, …) that the user model
   * has; or name the fields (`{ title: "jobTitle", phone: "workPhone" }`), listing only those to
   * send. An empty field clears that attribute at the app. At Entra ID they're `jobTitle`,
   * `businessPhones`, `mobilePhone` and the address fields; at Google Workspace the primary
   * organization's title, the phones and the work address, touching only what's named here. A
   * `mapUser` that sets one of these itself takes precedence for that attribute. Also the
   * preferred language, locale, time zone and user type (`preferredLanguage`, `locale`,
   * `timezone`, `userType`), checked before they're sent: a language that isn't a language tag,
   * or a time zone that isn't an IANA name, is left out (and logged), not sent to be refused.
   */
  attributes?: boolean | AttributeFields | undefined;
  /**
   * The user's roles in your organizations, as SCIM `roles` (`{ value, type }`): at an
   * organization's target, their roles there (`type: "organization"`); at another, their roles
   * in every organization they're in, each with the organization's slug as `type`. For apps
   * that grant access by role. SCIM apps and webhooks only.
   */
  roles?: boolean | undefined;
  /**
   * The user's entitlements, as SCIM `entitlements` (`{ value }`): what your code says they're
   * entitled to (a licence, a plan). Return [] for none, which clears them at the app. SCIM apps
   * and webhooks only; not for organizations' stored targets (a function can't be stored).
   */
  entitlements?: ((user: ProvisionedUser) => string[] | Promise<string[]>) | undefined;
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
   * What leaving means at the app: `deactivate` (active=false, the default) or `delete`. At Entra
   * ID, deactivating also revokes the user's sessions, and deleting puts them in the recycle bin
   * for 30 days, never purged: a user back within that time is restored.
   */
  deprovision?: "deactivate" | "delete" | undefined;
  /** Per request; default 10 seconds. */
  timeoutMs?: number | undefined;
  /**
   * At most this many requests a minute to the app, for an app with a rate limit (the
   * `githubEnterprise` profile sets 30). Requests wait their turn; one that would wait more than
   * 30 seconds goes back in the queue, and a scheduled run sends the target about a minute's worth.
   * Counted per server process: with several running deliveries at once, each keeps to it. Without
   * it, an app that answers 429 (or Google's rate limits) holds all of the target's jobs for its
   * Retry-After (a minute if it gives none), and rate limits never count toward `retry.maxAttempts`.
   */
  maxRequestsPerMinute?: number | undefined;
  /**
   * When the target's credentials expire (an ISO date, or a Date): an AWS IAM Identity Center
   * token lasts a year, a GitHub token or an Entra ID client secret as long as you chose. Shown
   * in `scimProvisioningStatus`, and warned about before it comes: daily at `warn` from 30 days
   * out, and from 7 days out (or once past) at `error` and through `onFailure` (`kind:
   * "credentials"`). Without it, a bearer token that's a JWT is read for its own expiry (`exp`).
   */
  credentialsExpireAt?: Date | string | undefined;
  /**
   * Marked for decommissioning (needs the plugin's `decommission` option). Alone, it freezes the
   * target: nothing is sent to it, and changes wait. `auth.api.scimProvisioningDecommission` then
   * starts deactivating every account and emptying every group we made there. Once started, removing
   * this doesn't cancel it (only that call does); while it's here, the target stays frozen.
   */
  decommission?: boolean | undefined;
  /**
   * The fetch this target's requests go through: a proxy's, or a Workers service binding's
   * (`env.MY_SERVICE.fetch.bind(env.MY_SERVICE)`). Default the global `fetch`. Redirects are
   * never followed either way.
   */
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
  /**
   * How a change is sent: `put` (the default) replaces the whole user at the app, including
   * attributes set there by hand; `patch` replaces only the attributes we send. Check what the
   * app accepts with `npx better-auth-scim-provisioning check`.
   */
  update?: "put" | "patch" | undefined;
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
  google?: undefined;
  entra?: undefined;
  secret?: undefined;
}

/** Google Workspace, through its Directory API: users, and organizations, teams and roles as Google Groups. */
export interface GoogleWorkspaceTarget extends TargetOptions {
  type: "google-workspace";
  /** The Directory API's base URL; default `https://admin.googleapis.com/admin/directory/v1`. Change it only for a proxy. */
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
    /** The domain of the groups' email addresses; default the admin's. */
    groupDomain?: string | undefined;
    /**
     * A group's email address, from its externalId (an organization's id, `team:<id>` or
     * `role:<organization id>:<role>`). Keep it stable: it's how the group is found again. Default
     * `ba-<externalId as a slug>@<groupDomain>`.
     */
    groupEmail?: ((externalId: string) => string) | undefined;
    /** Google's token endpoint; default `https://oauth2.googleapis.com/token`. Change it only for a proxy. */
    tokenUrl?: string | undefined;
  };
  token?: undefined;
  auth?: undefined;
  secret?: undefined;
  entra?: undefined;
  update?: undefined;
  compat?: undefined;
}

/**
 * Microsoft Entra ID (formerly Azure AD), through Microsoft Graph: users, with our id as their
 * `onPremisesImmutableId`, which Entra matches a federated sign-in's NameID against, so a user
 * provisioned here signs in through your SAML identity provider at once. Groups aren't supported yet.
 */
export interface EntraIdTarget extends TargetOptions {
  type: "entra-id";
  /** Microsoft Graph's base URL; default `https://graph.microsoft.com/v1.0`. Change it only for a national cloud (the token's scope follows it) or a proxy (then set `entra.scope`). */
  url?: string | undefined;
  /** An app registration in the tenant, with the Graph application permission User.ReadWrite.All (admin consented). */
  entra: {
    /** The tenant's id (a GUID; Entra admin center, Overview). */
    tenantId: string;
    /** The app registration's Application (client) ID. */
    clientId: string;
    /** One of its client secrets. */
    clientSecret: string;
    /** The token endpoint; default `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/token`. Change it only for a national cloud or a proxy. */
    tokenUrl?: string | undefined;
    /** The token's scope; default `<url's origin>/.default`. Set it behind a proxy: `https://graph.microsoft.com/.default`. */
    scope?: string | undefined;
  };
  token?: undefined;
  auth?: undefined;
  secret?: undefined;
  google?: undefined;
  update?: undefined;
  compat?: undefined;
  groups?: undefined;
  groupName?: undefined;
  teamGroups?: undefined;
  teamGroupName?: undefined;
  roleGroups?: undefined;
  roleGroupName?: undefined;
}

/**
 * Signed webhooks: every change POSTed to a URL as a JSON event with the full current state,
 * signed with HMAC-SHA256 (receivers check it with `verifyWebhookSignature`).
 */
export interface WebhookTarget extends TargetOptions {
  type: "webhook";
  /** Where events are POSTed (https; http only for localhost). */
  url: string;
  /** The key events are signed with, shared with the receiver; at least 32 characters. */
  secret: string;
  token?: undefined;
  auth?: undefined;
  google?: undefined;
  entra?: undefined;
  update?: undefined;
  compat?: undefined;
}

/** A target: an app that speaks SCIM, Google Workspace, Microsoft Entra ID, or a webhook. */
export type Target = ScimTarget | GoogleWorkspaceTarget | EntraIdTarget | WebhookTarget;

/** A delivery that gave up, or reached `retry.maxAttempts` (it's then retried every 6 hours). */
export interface DeliveryFailure {
  targetId: string;
  /**
   * What was being delivered: a user, or an organization's, team's or role's group; or
   * "credentials": the target's credentials expire within 7 days, or have (`subjectId` is the
   * target's id; `failed` once they have). The list can grow in a minor release.
   */
  kind: "user" | "group" | "team" | "role" | "credentials";
  /** The user's id, or the organization's, team's or role's (the target's, for "credentials"). */
  subjectId: string;
  /** The error, with the app's own message where it gave one. */
  error: string;
  /**
   * The app's HTTP status, or null: a timeout, a network error, the host's own code, or a
   * webhook receiver's 404 or redirect (a wrong URL, never "already gone": the error says so).
   */
  status: number | null;
  attempts: number;
  /** True: given up, until the subject changes again or a reconcile runs. False: still retried. */
  failed: boolean;
}

export interface ScimProvisioningOptions {
  targets: Target[];
  /**
   * Deliveries at once in the scheduled run (`scimProvisioningRun`); default 4, 1 for one at a
   * time. Higher is faster, but every target sees that many requests at once.
   */
  concurrency?: number | undefined;
  retry?: {
    /**
     * Attempts at the normal backoff; default 8. After that, a failure that can fix itself (5xx,
     * timeouts, 401/403) is retried every 6 hours. Other errors fail the job at once, until the
     * user changes again or a reconcile. A rate limit (429) isn't counted: the job waits as asked.
     */
    maxAttempts?: number | undefined;
    /** First retry after this; doubles each attempt, capped at 6 hours. Default 30 seconds. */
    baseDelayMs?: number | undefined;
  } | undefined;
  /**
   * Called when a delivery gives up (an error that won't fix itself) or reaches
   * `retry.maxAttempts`: to alert on, say, a deprovisioning that isn't getting through. An error
   * it throws is logged, never in the way of delivery.
   */
  onFailure?: ((failure: DeliveryFailure) => void | Promise<void>) | undefined;
  /**
   * Let organizations connect their own apps at runtime: SCIM apps, Google Workspace domains and
   * webhooks stored in the database (the `scimProvisioningTarget` table, which exists only with
   * this option), their credentials encrypted with Better Auth's secret. A stored target always
   * belongs to one organization and only ever receives its members and groups.
   */
  registry?: TargetRegistryOptions | undefined;
  /**
   * Retiring a target: deactivate every account and empty every group we made at an app, through
   * `scimProvisioningDecommission`, tracked in its own table (`scimProvisioningDecommission`, which
   * exists only with this option: migrate after turning it on).
   */
  decommission?: boolean | undefined;
  /**
   * An audit history: who connected, changed, removed or decommissioned which target, and when,
   * kept in its own table (`scimProvisioningAuditEvent`, which exists only with this option:
   * migrate after turning it on) and listed newest first (`scimProvisioningAuditEvents`; with the
   * registry, organizations' administrators get their own at `targets/events`). Never secrets.
   */
  audit?: boolean | AuditOptions | undefined;
}

export interface AuditOptions {
  /** Remove events older than this many days (the scheduled run does, hourly). Kept for good by default. */
  keepDays?: number | undefined;
  /**
   * Also hand each event to your own code as it's recorded: to forward it to a SIEM, say. It gets
   * a few seconds; an error it throws is logged, never in the way.
   */
  onEvent?: ((event: AuditEvent) => void | Promise<void>) | undefined;
}

/**
 * What an audit event records. The list can grow in a minor release (handle a value you don't
 * know). `target.*` events are organizations' stored targets'; the decommission ones are for every
 * target.
 */
export type AuditAction =
  | "target.created"
  | "target.updated"
  | "target.deleted"
  | "decommission.started"
  | "decommission.cancelled"
  | "decommission.completed"
  | "purge.started"
  | "purge.completed";

export interface AuditEvent {
  /** When, as an ISO date. */
  at: string;
  targetId: string;
  /** The target's organization; null for a target in code. */
  organizationId: string | null;
  /** Who: `user:<id>` (through the registry's routes), `server` (`auth.api`, from your code) or `system` (the plugin itself). */
  actor: string;
  action: AuditAction;
  /**
   * What, in a few fields: `hostAdministrator` (acting as one, `canManage`); for target.created,
   * `type`, `url` (as the API shows it) and `enabled`; for target.updated, `changed` (of
   * `settings`, `credentials`, `enabled`), `url` and `enabled`; for target.deleted, `abandoned`
   * (`accounts`, `groups`); for the decommission ones, `accounts` and `groups` (to go, or, after a
   * cancel, still active), or `total` and `groupsTotal` when complete.
   */
  detail: Record<string, unknown>;
}

export interface TargetRegistryOptions {
  /**
   * The host's administrators: may manage every organization's targets. Decided on the user as
   * the database has it now (never an impersonated or banned one). Without it, only organizations'
   * own administrators (`organizationRoles`) manage targets, each its own organization's.
   */
  canManage?: ((ctx: { user: { id: string; email: string; emailVerified: boolean } & Record<string, unknown>; session: Record<string, unknown> }) => boolean | Promise<boolean>) | undefined;
  /**
   * The organization roles whose holders manage their organization's targets; default
   * ["owner", "admin"]. [] leaves it to `canManage`.
   */
  organizationRoles?: string[] | undefined;
  /** At most this many stored targets per organization; default 10. */
  maxTargetsPerOrganization?: number | undefined;
  /**
   * Hosts a stored target may use although they look internal (a name without a dot, `.internal`,
   * a private address). Stored URLs are otherwise https and public only, since your server is
   * the one that calls them.
   */
  allowHosts?: string[] | undefined;
  /**
   * The user fields organizations' stored targets may read for `enterprise` (their administrators
   * choose the fields, and the values go to their app). Default: the attribute names
   * (`employeeNumber`, `costCenter`, `organization`, `division`, `department`) and `managerId`.
   * Never list a field you wouldn't show the organization's administrators. [] turns it off.
   */
  enterpriseFields?: string[] | undefined;
  /**
   * The user fields organizations' stored targets may read for `attributes`. Default: the
   * attribute names (`title`, `phone`, `mobile`, `streetAddress`, `locality`, `region`,
   * `postalCode`, `country`). Never list a field you wouldn't show the organization's
   * administrators. [] turns it off.
   */
  attributeFields?: string[] | undefined;
  /**
   * The fetch stored targets use, to send them through an egress proxy, say. By default, the
   * global fetch behind a guard that checks every request's URL as it's made and refuses names
   * resolving to private addresses: your own fetch replaces that guard, so it must do the same.
   */
  fetch?: typeof fetch | undefined;
  /**
   * The organization roles whose holders may decommission their organization's targets (with the
   * plugin's `decommission`); default ["owner"]. Only roles also in `organizationRoles` count: one
   * that may not manage targets may not decommission them. The host's administrators
   * (`canManage`) always may. While a decommission is running or complete, only they may also
   * remove or pause the target, which would undo or stop it.
   */
  decommissionRoles?: string[] | undefined;
  /** How recently they must have signed in to start, cancel or purge one (or remove or pause the target meanwhile), in seconds; at least 60; default 900 (15 minutes). */
  decommissionFreshAge?: number | undefined;
  /**
   * Refuse to delete a target while accounts we made there are still active, unless the delete
   * says `abandon: true` (for an app that's gone): decommission it first. Off by default.
   */
  deleteRequiresDecommission?: boolean | undefined;
}
