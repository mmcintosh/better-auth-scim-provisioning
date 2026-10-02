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

export interface ScimTarget {
  /** Stable id: jobs, links and logs use it. Letters, digits, - and _. */
  id: string;
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
   * Who is provisioned to this target, beyond the defaults (a verified email unless
   * `requireVerifiedEmail: false`, and not banned). Only `true` includes. Anything else, and a
   * provisioned user is deprovisioned at their next delivery. Runs at delivery time, on the user
   * as stored; after changing it, run a reconcile.
   */
  include?: ((user: ProvisionedUser) => boolean | Promise<boolean>) | undefined;
  /**
   * Only users with a verified email (the default). Set false where the sign-in provider leaves
   * `emailVerified` false but the address is trusted, e.g. some SSO and OAuth setups (S1-6). An
   * account that already exists at the app is still adopted only for a verified email (S2-5).
   */
  requireVerifiedEmail?: boolean | undefined;
  /** Only members of this organization (Better Auth's organization plugin). */
  organizationId?: string | undefined;
  /** The SCIM user sent; default: userName = email, names split from `name`, one primary email. */
  mapUser?: ((user: ProvisionedUser) => ScimUser) | undefined;
  /** What leaving means at the app: `deactivate` (active=false, the default) or `delete`. */
  deprovision?: "deactivate" | "delete" | undefined;
  /** Per request; default 10 seconds. */
  timeoutMs?: number | undefined;
  /** For tests. */
  fetch?: typeof fetch | undefined;
}

export interface ScimProvisioningOptions {
  targets: ScimTarget[];
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
