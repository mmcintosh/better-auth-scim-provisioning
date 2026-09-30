// A host app compiled with exactOptionalPropertyTypes against the built declarations (dist/):
// `pnpm pack:check` runs it under TypeScript 7 and 5.9. The plugin must fit BetterAuthPlugin, and
// optional options must accept `undefined` from a host's own optional values.
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { type ScimTarget, scimProvisioning } from "better-auth-scim-provisioning";

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
export const assignable: BetterAuthPlugin = scimProvisioning({ targets: [target], retry: { maxAttempts: 8, baseDelayMs: undefined } });
// …and, passed inline as apps do, its endpoints are typed on auth.api.
const auth = betterAuth({ plugins: [organization(), scimProvisioning({ targets: [target] })] });

// The server-only endpoints are typed on auth.api.
export const run = () => auth.api.scimProvisioningRun({ body: { limit: 50 } });
export const reconcile = () => auth.api.scimProvisioningReconcile({ body: {} });
