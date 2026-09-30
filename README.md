# better-auth-scim-provisioning

[![CI](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/ci.yml/badge.svg)](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/better-auth-scim-provisioning)](https://www.npmjs.com/package/better-auth-scim-provisioning)

**SCIM provisioning for [Better Auth](https://www.better-auth.com).** When a user is created, changed, banned or deleted in Better Auth, or joins or leaves an organization, their account in the apps they use is created, updated or deactivated over SCIM 2.0. Accounts exist before the first sign-in, and are switched off when someone leaves, not whenever their last session happens to expire.

It's the outbound direction. Better Auth's own [`@better-auth/scim`](https://www.better-auth.com/docs/plugins/scim) is the inbound one: directories push users *into* your app. This package pushes them *out*, to Cloudflare Access, AWS IAM Identity Center and any other app that accepts SCIM 2.0. It works however those users sign in, and pairs naturally with [better-auth-saml-idp](https://www.npmjs.com/package/better-auth-saml-idp) when your app is their identity provider.

> **0.x:** the API may still change before 1.0. See [what it doesn't do yet](#not-yet).

## Install

```sh
npm install better-auth-scim-provisioning
```

Requires Better Auth `>=1.7.5 <1.8.0` (a peer dependency), and Node.js 22 or later or Cloudflare Workers.

## Set up

```ts
import { betterAuth } from "better-auth";
import { scimProvisioning } from "better-auth-scim-provisioning";

export const auth = betterAuth({
  // …
  plugins: [
    scimProvisioning({
      targets: [
        {
          id: "cloudflare-access",
          url: process.env.CLOUDFLARE_SCIM_URL!, // the app's SCIM base URL, without /Users
          token: process.env.CLOUDFLARE_SCIM_TOKEN!, // its bearer token
        },
      ],
    }),
  ],
});
```

Then:

1. **Create its two tables** (`scimProvisioningJob`, `scimProvisioningLink`) with your usual migration: `npx auth migrate`, or `npx auth generate` for Drizzle and Prisma.
2. **Run the queue on a schedule**, every minute for example. Deliveries start right away in the background; the scheduled run is what retries the ones that failed.
   ```ts
   await auth.api.scimProvisioningRun({ body: {} }); // { done, retry, failed, busy }
   ```
   On Cloudflare Workers, from a [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/):
   ```ts
   export default {
     fetch: (request, env, ctx) => handle(request, env, ctx),
     scheduled: (event, env, ctx) => ctx.waitUntil(getAuth(env).api.scimProvisioningRun({ body: {} })),
   };
   ```
3. **Once, after adding or changing a target** (or to repair drift), queue everyone:
   ```ts
   await auth.api.scimProvisioningReconcile({ body: {} }); // { queued, next: null }
   ```
   With many users, or on Workers (which limits the work per invocation), go a page at a time:
   ```ts
   let next: string | null = null;
   do {
     ({ next } = await auth.api.scimProvisioningReconcile({ body: { limit: 200, after: next ?? undefined } }));
   } while (next);
   ```

**On Workers, give Better Auth `waitUntil`.** Deliveries run in the background, and the runtime cancels work still running after the response unless it runs under `waitUntil`:

```ts
import { waitUntil } from "cloudflare:workers";

betterAuth({ advanced: { backgroundTasks: { handler: waitUntil } } /* … */ });
```

Without it, a cancelled delivery waits for the scheduled run instead of happening right away.

## Targets

| Option | Default | |
|---|---|---|
| `id` | required | Stable id: letters, digits, `-`, `_`. Jobs, links and logs use it. |
| `url` | required | The app's SCIM base URL, without `/Users`. `https://` (`http://` only for localhost), with no query or credentials. |
| `token` | required | Its bearer token. |
| `organizationId` | | Only members of this organization (Better Auth's organization plugin). |
| `include` | | `(user) => boolean`: who else to leave out. Only `true` includes; anything else deprovisions a provisioned user at their next delivery. |
| `requireVerifiedEmail` | `true` | Only users with a verified email. Set false if your sign-in leaves `emailVerified` false for addresses you trust. An account that already exists at the app is still only taken over for a verified email. |
| `mapUser` | see below | `(user) => ScimUser`: what's sent. |
| `deprovision` | `"deactivate"` | `"deactivate"` (`active: false`, the account is kept) or `"delete"`. |
| `timeoutMs` | `10000` | Per request. |

Retries are shared by all targets: `retry: { maxAttempts: 8, baseDelayMs: 30000 }`. The delay doubles each attempt, or is longer if the app's `Retry-After` asks for it (up to a day). After `maxAttempts`, failures that can fix themselves are retried every 6 hours.

A change to a target (`include`, `organizationId`, `deprovision`) applies to each user at their next change: run a reconcile to apply it to everyone. Do the same after an app's outage or a token fix, to deliver what's waiting now rather than at its next retry.

## Who is provisioned, and what's sent

A user is at a target when their email is verified (unless `requireVerifiedEmail: false`), they aren't banned (the admin plugin), they're a member of `organizationId` if one is set, and `include` returns true (if set). Otherwise they're deprovisioned there, if they had been provisioned. A timed ban is lifted at the app when it runs out.

Membership changes are seen through the organization plugin's endpoints (add, remove, update role, accept an invitation, leave, delete the organization) and server-side `addMember`. Members added any other way (the creator of a new organization, SSO or inbound SCIM provisioning, your own database writes) are provisioned at their next change or reconcile.

By default the app gets:
- **`userName`** and the one primary **`emails`** value: the user's email;
- **`name`**: `givenName` and `familyName` split from Better Auth's `name`. The last word is the family name; a one-word name fills both, since apps such as AWS IAM Identity Center require both;
- **`displayName`**: the name;
- **`externalId`**: the Better Auth user id;
- **`active`**.

Override it per target with `mapUser`, for example to take `userName` from an employee id. `defaultScimUser(user)` is exported to build on.

## How it holds up

- **An outbox in your database.** A change queues one job per user and target. The job carries no user data: delivery reads the user as they are then, so quick changes collapse into one request with the latest state.
- **Never in the way.** Provisioning never fails the user's own write. A failure to queue is logged, and the next reconcile catches up.
- **Leases.** A job is claimed before delivery, so two workers never deliver it at once. A change that arrives during a delivery goes out straight after it.
- **Retries.** 429 (honouring `Retry-After`), 5xx, timeouts, network errors, and 401/403 (an expired token is the host's problem, not the user's) are retried with backoff, for as long as it takes. Other errors fail the job until the user changes again or a reconcile runs, and are logged with the app's message.
- **Lost replies.** The account is recorded as pending before it's created, so if the app's reply is lost and the user then leaves, the account is still found and switched off.
- **Careful adoption.** A user who already exists at the app is found by userName and taken over only if that account is ours (our `externalId`), or nobody's: no `externalId`, not linked to another user here, and the user's email is verified. A new user signing up with a deleted user's old email is refused, not handed the old account, even at apps that don't keep `externalId`.
- **Reconcile** covers every user, and every user still linked at a target, so deleted users whose deprovisioning was lost are cleaned up too.
- **No redirects.** The token only goes to the target's URL: a redirect fails the request, with the new location in the error.

## Apps

- **Cloudflare Access** (verified live). Zero Trust → Integrations → Identity providers → your identity provider → turn on **Enable SCIM** (and **Enable user deprovisioning**), **save**, then copy the SCIM endpoint and secret. The secret only works once the provider is saved: if you copied it before saving, regenerate it, copy it, and save. Cloudflare creates a user when they first sign in; SCIM keeps them up to date and switches them off.
- **AWS IAM Identity Center.** IAM Identity Center → Settings → Identity source → **Automatic provisioning**. Its tokens last a year. Users need a given name, a family name and a display name (the defaults always send them), and your identity provider's SAML NameID must be the same value as the SCIM `userName` (the email, by default).
- **Anything else that speaks SCIM 2.0 with a bearer token**, such as Auth0 (enterprise connections), Okta, or your own apps.

## Databases and runtimes

Tested on SQLite (`node:sqlite`), PostgreSQL 17, MySQL 8.4 and MongoDB 8.2 (Better Auth's Kysely and MongoDB adapters), with Better Auth 1.7.5 and the latest 1.7.x, on Node.js 22 and 24. It uses only `fetch` and Web APIs, so it also runs on Cloudflare Workers.

## Not yet

- **Groups** aren't provisioned, only users.
- **OAuth-authenticated apps**: Salesforce, for one, takes OAuth 2.0 client credentials rather than a bearer token.
- **PATCH updates.** Updates use `PUT`, which replaces the whole user at the app, including attributes an admin set there.

## Development

```sh
pnpm install
pnpm test        # SQLite and a mock SCIM app
pnpm typecheck && pnpm lint && pnpm pack:check
ADAPTER_DB=postgres ADAPTER_URL=postgres://postgres:test@localhost:5432/postgres npx vitest run test/adapters
```

The live test (`test/live/`) runs against a real SCIM service when the git-ignored `.env.live` holds `SCIM_URL` and `SCIM_TOKEN`: `npx vitest run -c vitest.live.config.ts`. Design decisions and reviews are in [DECISIONS.md](DECISIONS.md).

## License

[MIT](LICENSE) © Mark McIntosh
