# better-auth-scim-provisioning

Keep your users' accounts in step at the apps they use, straight from your [Better Auth](https://www.better-auth.com) server: **created before their first sign-in, updated when they change, switched off when they leave.** Over **SCIM 2.0**, **Google Workspace**'s Directory API, **Microsoft Entra ID** through Microsoft Graph, or **signed webhooks**. Runs on **Cloudflare Workers** and **Node.js**.

[![CI](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/ci.yml/badge.svg)](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/better-auth-scim-provisioning)](https://www.npmjs.com/package/better-auth-scim-provisioning)
[![Better Auth](https://img.shields.io/badge/better--auth-%E2%89%A51.7.16%20%3C1.8-black)](https://www.better-auth.com)
[![Runs on](https://img.shields.io/badge/runs%20on-Workers%20%7C%20Node%2022%2B-f38020)](docs/databases-and-runtimes.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/mmcintosh/better-auth-scim-provisioning/badge)](https://scorecard.dev/viewer/?uri=github.com/mmcintosh/better-auth-scim-provisioning)
[![Socket](https://socket.dev/api/badge/npm/package/better-auth-scim-provisioning)](https://socket.dev/npm/package/better-auth-scim-provisioning)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15270/badge)](https://www.bestpractices.dev/projects/15270)
[![CodeQL](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/codeql.yml/badge.svg)](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/codeql.yml)

It's the **outbound** direction. Better Auth's own [`@better-auth/scim`](https://www.better-auth.com/docs/plugins/scim) is the inbound one, where directories push users *into* your app; this package pushes them *out*. It works however your users sign in, and pairs with [better-auth-saml-idp](https://www.npmjs.com/package/better-auth-saml-idp) when your app is also their identity provider: see [sign-in and provisioning together](https://github.com/mmcintosh/better-auth-saml-idp/blob/main/docs/guide/provisioning.md).

> **Unofficial community plugin.** This project isn't affiliated with or endorsed by Better Auth. Status: **stable (1.x) on npm**, verified live against Cloudflare Access, Google Workspace, AWS IAM Identity Center and Microsoft Entra ID (see [what exactly](#verified-live)), and field-tested in a real app on Workers. A change that could break your app comes only in a major release ([versioning](docs/versioning.md)); every change is in the [CHANGELOG](CHANGELOG.md). Coming from 0.3? See [upgrading](docs/upgrading.md).

## Features

- **Four kinds of target**: any **SCIM 2.0** app (Cloudflare Access, AWS IAM Identity Center, Slack, Atlassian, GitHub Enterprise, Zoom…), **Google Workspace** through its Directory API, **Microsoft Entra ID** (Microsoft 365) through Microsoft Graph, and **signed webhooks** for your own apps or automation tools (Zapier, Make, n8n).
- **Enterprise User attributes**: employee number, cost center, organization, division, department and manager, from your users' fields, as SCIM's Enterprise User extension (and Google Workspace's and Entra ID's own fields), the manager kept in step as people join and leave.
- **Groups**: organizations, teams and roles in your app become groups at the app (SCIM groups or Google Groups), with the provisioned members, kept in sync as people join, leave and change roles.
- **Offboarding**: a ban or a delete deactivates (or deletes) the account at every app at once, not when a session expires; a timed ban is lifted on time by the scheduled run. In the field test, Cloudflare Access revoked a live session within 35 seconds.
- **Reliable delivery**: a database outbox with leases, retries with backoff (honouring `Retry-After`), concurrency, and a scheduled run. Once queued, a change isn't lost to an outage, a timeout or a reply that never arrived, and a 404 counts as "gone" only when the app's list agrees.
- **Careful adoption**: an account that already exists at the app is taken over only where you allow it (`adopt`, off by default for Google Workspace and Entra ID), only if it's nobody's and its userName is the user's verified email, and it's then only ever deactivated, never deleted. Never handed to someone who reused a deleted user's email.
- **Profiles for real apps**: `awsIamIdentityCenter`, `slack`, `atlassian`, `githubEnterprise`, `cloudflareAccess`, each built from the app's documented quirks (no PUT on groups, batches of 100, groups that can't be renamed…).
- **Every sign-in method apps use**: bearer tokens, Basic, an API-key header, OAuth 2.0 client credentials, and Google service accounts with domain-wide delegation.
- **Organizations' own targets**: with `registry`, each organization connects its own SCIM app, Google Workspace or webhook at runtime, through an API its owners and admins use, with credentials encrypted and never shown again, and only its own members sent there.
- **Reconcile**: queue everyone again after adding or fixing a target, a page at a time (with `limit`), within a Workers invocation's limits.
- **Check an app first**: `npx better-auth-scim-provisioning check` tries an app's SCIM with a throwaway user and reports what it supports, the Enterprise User extension included.
- **Retiring an app**: decommission a target to deactivate every account and empty every group made there before removing it, with a preview, a confirmed count, cancel, an optional purge, and accounts another target still uses left alone (see [Retiring an app](docs/retiring-an-app.md)).
- **Rate limits**: an app's 429 holds the whole target for its `Retry-After` without counting a failed attempt, and `maxRequestsPerMinute` keeps under an app's published limit (the `githubEnterprise` profile sets 30).
- **Audit history**: with `audit`, who connected, changed, removed or decommissioned which target, and when, kept in the database, listed newest first, and handed to your own code (a SIEM) as it happens (see [Audit history](docs/monitoring.md#audit-history)).
- **Drift detection**: `scimProvisioningDrift` reads an app's own list of accounts and reports the ones nobody manages, ours without a link, and linked ones that differ, page by page, changing nothing.
- **Status and failures**: `scimProvisioningStatus` counts what's queued, stuck and failed at each target (or shows one user's state), `onFailure` tells you when a delivery gives up or keeps failing, and failures are logged with the app's own message.
- **Runtimes and databases**: only `fetch` and Web APIs; tested on Workers with D1, `waitUntil` and a Cron Trigger; the whole suite on Node.js 22 and 24, and the database suite on SQLite, D1, PostgreSQL, MySQL and MongoDB, with Drizzle and Prisma too ([which combinations](docs/databases-and-runtimes.md)).
- **Supply chain**: SHA-pinned actions, CodeQL, dependency review, OpenSSF Scorecard, and a release workflow that publishes with npm provenance and an SBOM.

## Verified live

| App | Users | Groups | How |
|---|---|---|---|
| Cloudflare Access | ✓ | ✓ | users: the automated live test (`test/live/lifecycle.test.ts`), the `check` CLI and the field test; groups: the field test, by hand |
| Google Workspace | ✓ | ✓ (Google Groups) | live tests in a real Workspace, which found and fixed how Google settles after creates and email changes |
| AWS IAM Identity Center | ✓ | ✓ (including a group of over 100) | live tests with the `awsIamIdentityCenter` profile |
| Microsoft Entra ID | ✓ | not yet supported | live tests in a test tenant (`test/live/entra-id.test.ts`), which found and fixed how Graph settles after writes; separately, by hand, a user created through Graph the same way signed in to Microsoft 365 through better-auth-saml-idp |

The live tests run by hand with real credentials, not in CI. Webhooks have no third party to verify against: CI sends them over HTTP to a receiver written as [Webhooks](docs/webhooks.md) shows. Better Auth apps are tested against the real `@better-auth/scim` in CI ([Better Auth apps](docs/better-auth-apps.md)). Slack, Atlassian and GitHub Enterprise are built from each app's documentation and tested against a model of it. The code was reviewed independently before 0.1.0 and 0.2.0, and three more times before 1.0, each review's findings fixed with a test.

## Documentation

| To… | Read |
|---|---|
| Set up targets, and every target option | [Targets](docs/targets.md) |
| Choose who is provisioned and what's sent: attributes, roles, Enterprise User | [Users and attributes](docs/users-and-attributes.md) |
| Send organizations, teams and roles as groups | [Groups](docs/groups.md) |
| See what's queued, stuck or failed, and keep an audit history | [Monitoring](docs/monitoring.md) |
| Understand retries, rate limits, adoption and lost replies | [How it holds up](docs/reliability.md) |
| Set up a particular app (Cloudflare Access, AWS, Slack, Atlassian, GitHub) | [Apps](docs/apps.md) |
| Provision a Better Auth app, and use ID-JAG with it | [Better Auth apps](docs/better-auth-apps.md) |
| Provision Google Workspace or Microsoft Entra ID | [Google Workspace](docs/google-workspace.md), [Microsoft Entra ID](docs/entra-id.md) |
| Send signed webhooks to your own code | [Webhooks](docs/webhooks.md) |
| Try an app's SCIM before you rely on it | [Check an app first](docs/check.md) |
| Let each organization connect its own apps | [Organizations' own targets](docs/registry.md) |
| Retire an app cleanly | [Retiring an app](docs/retiring-an-app.md) |
| Check databases and runtimes | [Databases and runtimes](docs/databases-and-runtimes.md) |
| Upgrade, or see what counts as breaking | [Upgrading](docs/upgrading.md), [versioning](docs/versioning.md) |

## Install

```sh
npm install better-auth-scim-provisioning
```

Requires Better Auth `>=1.7.16 <1.8.0` (a peer dependency), and Node.js 22 or later or Cloudflare Workers.

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

1. **Create its tables** (`scimProvisioningJob`, `scimProvisioningLink`, and `scimProvisioningGroupLink` for groups) with your usual migration: `npx auth migrate`, or `npx auth generate` for Drizzle and Prisma.
2. **Run the queue on a schedule**, every minute for example. Deliveries start right away in the background; the scheduled run is what retries the ones that failed.
   ```ts
   await auth.api.scimProvisioningRun({ body: {} }); // { done, retry, failed, busy }
   ```
   On Cloudflare Workers, from a [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/). If you keep one Better Auth instance per isolate, set it up within the request (or cron event) that creates it, as [the example's `authFor`](examples/workers/src/index.ts) does: workerd cancels what a request leaves unfinished, and a half-set-up instance would stall the requests after it.
   ```ts
   export default {
     fetch: async (request, env) => (await authFor(env)).handler(request),
     scheduled: (event, env, ctx) => ctx.waitUntil(authFor(env).then((auth) => auth.api.scimProvisioningRun({ body: {} }))),
   };
   ```
3. **Once, after adding or changing a target** (or to repair drift), queue everyone, a page at a time (500 by default, groups included):
   ```ts
   let next: string | null = null;
   do {
     ({ next } = await auth.api.scimProvisioningReconcile({ body: { limit: 200, after: next ?? undefined } }));
   } while (next);
   ```
   On Workers, which limit the work per invocation, call **one page per request** and pass `next` back in the next one, as the example's `/admin/reconcile?after=…` does; a loop like the one above, in one invocation, does all the pages at once again.

**A complete app to copy:** [examples/workers](examples/workers) runs this package on Workers and D1, with `waitUntil`, a Cron Trigger for retries, organizations as groups, and admin routes; CI runs it inside workerd (with this repository's source, the apps mocked). better-auth-saml-idp's [Workers example](https://github.com/mmcintosh/better-auth-saml-idp/tree/main/examples/workers-hono#provisioning-optional) adds sign-in and an admin page showing each user's account at each app, the queue and the groups.

**On Workers, give Better Auth `waitUntil`.** Deliveries run in the background, and the runtime cancels work still running after the response unless it runs under `waitUntil`:

```ts
import { waitUntil } from "cloudflare:workers";

betterAuth({ advanced: { backgroundTasks: { handler: waitUntil } } /* … */ });
```

Without it, a cancelled delivery waits for the scheduled run instead of happening right away.

## Not yet

- **Groups at Entra ID**, and Entra ID targets in organizations' own targets (`registry`). Entra ID targets are users only, and set in code, for now.
- **Live verification of the Slack, Atlassian and GitHub Enterprise profiles.** They're built from each app's documentation and tested against a model.

## Development

```sh
pnpm install
pnpm test        # SQLite and a mock SCIM app
pnpm typecheck && pnpm lint && pnpm pack:check
ADAPTER_DB=postgres ADAPTER_URL=postgres://postgres:test@localhost:5432/postgres npx vitest run test/adapters
ADAPTER_DB=d1 npx vitest run test/adapters    # also drizzle-postgres, drizzle-mysql, prisma-postgres, mysql, mongodb
```

The live tests (`test/live/`) run against real services when the git-ignored `.env.live` holds their settings (`SCIM_URL` and `SCIM_TOKEN`, `AWS_SCIM_URL` and `AWS_SCIM_TOKEN`, the `GOOGLE_*` and `ENTRA_*` ones): `npx vitest run -c vitest.live.config.ts`. Each file runs only with its settings.

**Releasing** (maintainers): keep CHANGELOG.md's `[Unreleased]` section current; then, on an up-to-date main, `pnpm release patch|minor|major ["summary"]` opens the **Release X.Y.Z** pull request (version bumped, section dated). Merging it is the go-ahead: [tag-release.yml](.github/workflows/tag-release.yml) tags `vX.Y.Z` and starts [release.yml](.github/workflows/release.yml), which tests, packs and, after the `npm` environment's approval, stages the tarball with provenance and an SBOM; approve the staged version on npmjs.com to publish it.

## License

[MIT](LICENSE) © Mark McIntosh

If the package is useful to you, a ⭐ on [GitHub](https://github.com/mmcintosh/better-auth-scim-provisioning) helps others find it.
