// Better Auth with scimProvisioning, configured from the Worker's environment. Kept free of
// `cloudflare:workers` so Node can load it too (the test compiles the migration from it).
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, organization } from "better-auth/plugins";
import { scimProvisioning, type Target } from "better-auth-scim-provisioning";

export interface Env {
  DB: D1Database;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  /** A SCIM app (base URL ending in /scim/v2, or wherever its /Users lives) and its bearer token. */
  SCIM_URL?: string;
  SCIM_TOKEN?: string;
  /** A webhook receiver, and the secret its events are signed with (at least 32 characters). */
  WEBHOOK_URL?: string;
  WEBHOOK_SECRET?: string;
  /** Comma-separated emails that may use /admin/* and create organizations. */
  ADMIN_EMAILS?: string;
  /** "true" in development: verification links are kept for /dev/mailbox instead of emailed. */
  DEV_MAILBOX?: string;
}

export const admins = (env: Env) => (env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
/**
 * Whether this user is one of ADMIN_EMAILS: by a verified address only, so the rule still holds
 * if sign-in providers that don't verify addresses are added, or verification is turned off.
 */
export const isAdmin = (env: Env, user: { email: string; emailVerified?: boolean | null }) => user.emailVerified === true && admins(env).includes(user.email.toLowerCase());

/** The provisioning targets this deployment has settings for: a SCIM app, a webhook, or both. Each
 * organization is a group at each of them (`groups`). */
export function targetsFrom(env: Env): Target[] {
  const targets: Target[] = [];
  if (env.SCIM_URL && env.SCIM_TOKEN) targets.push({ id: "app", type: "scim", url: env.SCIM_URL, token: env.SCIM_TOKEN, groups: true });
  if (env.WEBHOOK_URL && env.WEBHOOK_SECRET) targets.push({ id: "hook", type: "webhook", url: env.WEBHOOK_URL, secret: env.WEBHOOK_SECRET, groups: true });
  if (!targets.length) throw new Error("Set SCIM_URL and SCIM_TOKEN, or WEBHOOK_URL and WEBHOOK_SECRET (see the README)");
  return targets;
}

export function createAuth(env: Env, o: { database?: unknown; waitUntil?: (promise: Promise<unknown>) => void; mailbox?: Map<string, string> } = {}) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: (o.database ?? env.DB) as never,
    telemetry: { enabled: false },
    // Only verified addresses are provisioned (the package's default), so sign-up verifies email.
    emailAndPassword: { enabled: true, requireEmailVerification: true },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        if (env.DEV_MAILBOX === "true") o.mailbox?.set(user.email.toLowerCase(), url);
        // Production: send `url` to `user.email` with your email provider here.
        else console.error("[example] email sending is not configured; set up sendVerificationEmail");
      },
    },
    user: { deleteUser: { enabled: true } },
    // Deliveries run after the response; on Workers they must be kept alive with waitUntil.
    ...(o.waitUntil ? { advanced: { backgroundTasks: { handler: o.waitUntil } } } : {}),
    plugins: [
      admin(),
      // Each organization becomes a group at the app, named after it. Any signed-in user could
      // otherwise create one with any name (say "Administrators"), and an organization's own
      // admins could rename it to one, so only ADMIN_EMAILS may create or rename them here.
      organization({
        allowUserToCreateOrganization: async (user) => isAdmin(env, user),
        organizationHooks: {
          beforeUpdateOrganization: async ({ organization: changes, user }) => {
            if (changes.name !== undefined && !isAdmin(env, user)) throw new APIError("FORBIDDEN", { message: "only admins may rename organizations (the name is the group's name at the apps)" });
          },
        },
      }),
      // Each organization's owners and admins may also connect their own apps (/api/auth/scim-provisioning/targets);
      // ADMIN_EMAILS manage every organization's.
      scimProvisioning({ targets: targetsFrom(env), registry: { canManage: ({ user }) => isAdmin(env, user as { email: string; emailVerified?: boolean | null }) } }),
    ],
  });
}
