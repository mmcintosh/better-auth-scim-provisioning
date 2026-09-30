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
  /** Its bearer token. */
  token: string;
  /**
   * Who is provisioned to this target, beyond the defaults (verified email, not banned). Return
   * false and a provisioned user is deprovisioned. Runs at delivery time, on the user as stored.
   */
  include?: ((user: ProvisionedUser) => boolean | Promise<boolean>) | undefined;
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
    /** Attempts before a job is marked failed (until the user changes again); default 8. */
    maxAttempts?: number | undefined;
    /** First retry after this; doubles each attempt, capped at 6 hours. Default 30 seconds. */
    baseDelayMs?: number | undefined;
  } | undefined;
}
