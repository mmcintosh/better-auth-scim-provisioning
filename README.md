# better-auth-scim-provisioning

Keep your users' accounts in step at the apps they use, straight from your [Better Auth](https://www.better-auth.com) server: **created before their first sign-in, updated when they change, switched off when they leave.** Over **SCIM 2.0**, **Google Workspace**'s Directory API, or **signed webhooks**. Runs on **Cloudflare Workers** and **Node.js**.

[![CI](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/ci.yml/badge.svg)](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/better-auth-scim-provisioning)](https://www.npmjs.com/package/better-auth-scim-provisioning)
[![Better Auth](https://img.shields.io/badge/better--auth-%E2%89%A51.7.5%20%3C1.8-black)](https://www.better-auth.com)
[![Runs on](https://img.shields.io/badge/runs%20on-Workers%20%7C%20Node%2022%2B-f38020)](#databases-and-runtimes)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/mmcintosh/better-auth-scim-provisioning/badge)](https://scorecard.dev/viewer/?uri=github.com/mmcintosh/better-auth-scim-provisioning)
[![Socket](https://socket.dev/api/badge/npm/package/better-auth-scim-provisioning)](https://socket.dev/npm/package/better-auth-scim-provisioning)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15270/badge)](https://www.bestpractices.dev/projects/15270)
[![CodeQL](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/codeql.yml/badge.svg)](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/codeql.yml)

It's the **outbound** direction. Better Auth's own [`@better-auth/scim`](https://www.better-auth.com/docs/plugins/scim) is the inbound one, where directories push users *into* your app; this package pushes them *out*. It works however your users sign in, and pairs with [better-auth-saml-idp](https://www.npmjs.com/package/better-auth-saml-idp) when your app is also their identity provider: see [sign-in and provisioning together](https://github.com/mmcintosh/better-auth-saml-idp/blob/main/docs/guide/provisioning.md).

> **Unofficial community plugin.** This project isn't affiliated with or endorsed by Better Auth. Status: **1.0 on npm**, verified live against Cloudflare Access, Google Workspace and AWS IAM Identity Center (see [what exactly](#-verified-live)), and field-tested in a real app on Workers. From 1.0, a change that could break your app comes only in a major release ([versioning](docs/versioning.md)); every change is in the [CHANGELOG](CHANGELOG.md). **Upgrading from 0.3 needs a database migration**: see [upgrading from 0.3](docs/upgrading.md).

If it's useful to you, a ⭐ on [GitHub](https://github.com/mmcintosh/better-auth-scim-provisioning) helps others find it.

## ✨ Features

- 🎯 **Three kinds of target**: any **SCIM 2.0** app (Cloudflare Access, AWS IAM Identity Center, Slack, Atlassian, GitHub Enterprise, Zoom…), **Google Workspace** through its Directory API, and **signed webhooks** for your own apps or automation tools (Zapier, Make, n8n).
- 👥 **Groups**: organizations, teams and roles in your app become groups at the app (SCIM groups or Google Groups), with the provisioned members, kept in sync as people join, leave and change roles.
- 🚪 **Real offboarding**: a ban or a delete deactivates (or deletes) the account at every app at once, not when a session expires; a timed ban is lifted on time by the scheduled run. In the field test, Cloudflare Access revoked a live session within 35 seconds.
- 📬 **Delivery that holds up**: a database outbox with leases, retries with backoff (honouring `Retry-After`), concurrency, and a scheduled run. Once queued, a change isn't lost to an outage, a timeout or a reply that never arrived, and a 404 counts as "gone" only when the app's list agrees.
- 🤝 **Careful adoption**: an account that already exists at the app is taken over only where you allow it (`adopt`, off by default for Google Workspace), only if it's nobody's and its userName is the user's verified email, and it's then only ever deactivated, never deleted. Never handed to someone who reused a deleted user's email.
- 🧩 **Profiles for real apps**: `awsIamIdentityCenter`, `slack`, `atlassian`, `githubEnterprise`, `cloudflareAccess`, each built from the app's documented quirks (no PUT on groups, batches of 100, groups that can't be renamed…).
- 🔑 **Every sign-in method apps use**: bearer tokens, Basic, an API-key header, OAuth 2.0 client credentials, and Google service accounts with domain-wide delegation.
- 🏢 **Organizations' own targets**: with `registry`, each organization connects its own SCIM app, Google Workspace or webhook at runtime, through an API its owners and admins use, with credentials encrypted and never shown again, and only its own members sent there.
- 🔁 **Reconcile**: queue everyone again after adding or fixing a target, a page at a time (with `limit`), within a Workers invocation's limits.
- 🩺 **Check an app first**: `npx better-auth-scim-provisioning check` tries an app's SCIM with a throwaway user and reports what it supports.
- 📈 **You can see it**: `scimProvisioningStatus` counts what's queued, stuck and failed at each target (or shows one user's state), `onFailure` tells you when a delivery gives up or keeps failing, and failures are logged with the app's own message.
- ☁️ **Runs where your app runs**: only `fetch` and Web APIs; tested on Workers with D1, `waitUntil` and a Cron Trigger; the whole suite on Node.js 22 and 24, and the database suite on SQLite, D1, PostgreSQL, MySQL and MongoDB, with Drizzle and Prisma too ([which combinations](#databases-and-runtimes)).
- 📦 **Supply chain**: SHA-pinned actions, CodeQL, dependency review, OpenSSF Scorecard, and a release workflow that publishes with npm provenance and an SBOM.

## ✅ Verified live

| App | Users | Groups | How |
|---|---|---|---|
| Cloudflare Access | ✓ | ✓ | users: the automated live test (`test/live/lifecycle.test.ts`), the `check` CLI and the field test; groups: the field test, by hand |
| Google Workspace | ✓ | ✓ (Google Groups) | live tests in a real Workspace, which found and fixed how Google settles after creates and email changes |
| AWS IAM Identity Center | ✓ | ✓ (including a group of over 100) | live tests with the `awsIamIdentityCenter` profile |

The live tests run by hand with real credentials, not in CI. Webhooks have no third party to verify against: CI sends them over HTTP to a receiver written as shown below ([Webhooks](#webhooks)). Better Auth apps are tested against the real `@better-auth/scim` in CI ([Better Auth apps](#better-auth-apps-and-id-jag)). Slack, Atlassian and GitHub Enterprise are built from each app's documentation and tested against a model of it. The code was reviewed independently before 0.1.0 and 0.2.0, and three more times before 1.0, each review's findings fixed with a test.

## Contents

[Install](#install) · [Set up](#set-up) · [Targets](#targets) · [Watching it](#watching-it) · [Who is provisioned, and what's sent](#who-is-provisioned-and-whats-sent) · [Groups](#groups) · [How it holds up](#how-it-holds-up) · [Apps](#apps) · [Better Auth apps, and ID-JAG](#better-auth-apps-and-id-jag) · [Google Workspace](#google-workspace) · [Webhooks](#webhooks) · [Check an app first](#check-an-app-first) · [Organizations' own targets](#organizations-own-targets) · [Databases and runtimes](#databases-and-runtimes) · [Not yet](#not-yet) · [Development](#development)

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

## Targets

| Option | Default | |
|---|---|---|
| `id` | required | Stable id: letters, digits, `-`, `_`. Jobs, links and logs use it. |
| `type` | `"scim"` | `"google-workspace"` for Google Workspace's Directory API (see [Google Workspace](#google-workspace)), or `"webhook"` for signed webhooks (see [Webhooks](#webhooks)). |
| `url` | required (not for Google Workspace) | The app's SCIM base URL, without `/Users`. `https://` (`http://` only for localhost), with no query or credentials. |
| `token` | | Its bearer token. Or `auth`, for anything else: one of the two is required. |
| `auth` | | `{ type: "bearer", token }` (the same as `token`; give one or the other), `{ type: "basic", username, password }`, `{ type: "header", name, value }` (an API key), or `{ type: "oauth2", tokenUrl, clientId, clientSecret, scope?, clientAuth?, params? }` (client credentials; tokens cached and renewed before they expire). |
| `update` | `"put"` | SCIM targets: `"put"` replaces the whole user at the app; `"patch"` changes only the attributes we send, keeping what an admin set there. |
| `organizationId` | | Only members of this organization (Better Auth's organization plugin). |
| `include` | | `(user) => boolean`: who else to leave out. Only `true` includes; anything else deprovisions a provisioned user at their next delivery. |
| `requireVerifiedEmail` | `true` | Only users with a verified email. Set false if your sign-in leaves `emailVerified` false for addresses you trust. An account that already exists at the app is still only taken over for a verified email. |
| `adopt` | `true` (`false` for Google Workspace) | Take over an account made elsewhere when it's nobody's, active, and its userName is the user's verified email. It's then never deleted, only deactivated. |
| `mapUser` | see below | `(user) => ScimUser`: what's sent. |
| `groups` | `false` | Organizations as groups at the app: `true`, or `(organization) => boolean` to choose which (see [Groups](#groups)). |
| `groupName` | the organization's name | `(organization) => string`: the group's name. |
| `teamGroups` | `false` | Teams as groups: `true`, or `(team, organization) => boolean`. |
| `teamGroupName` | "Org / Team" | `(team, organization) => string`. |
| `roleGroups` | `false` | Roles as groups: `true` (every role held) or a list, `["admin"]`. |
| `roleGroupName` | "Org / role" | `(role, organization) => string`. |
| `compat` | | SCIM targets: how the app differs from the standard, usually set by a profile (see [Apps](#apps)). |
| `deprovision` | `"deactivate"` | `"deactivate"` (`active: false`, the account is kept) or `"delete"`. |
| `timeoutMs` | `10000` | Per request. |
| `fetch` | the global `fetch` | The fetch requests go through: a proxy's, or a Workers service binding's. |

Options are checked when the plugin starts: an unknown or misspelled option, or one in the wrong place, stops it with a message naming it. The scheduled run delivers 4 jobs at once by default: `concurrency: 4` (1 to 32), shared by all targets. Retries are shared too: `retry: { maxAttempts: 8, baseDelayMs: 30000 }`. The delay doubles each attempt, or is longer if the app's `Retry-After` asks for it (up to a day). After `maxAttempts`, failures that can fix themselves are retried every 6 hours.

A change to a target (`include`, `organizationId`, `deprovision`) applies to each user at their next change: run a reconcile to apply it to everyone, once the new version is fully deployed (on Workers, old and new run side by side for a few seconds). Do the same after an app's outage or a token fix, to deliver what's waiting now rather than at its next retry.

## Watching it

```ts
// Per target: jobs queued (due now), waiting (a backoff, a Retry-After, or a ban running out), stuck
// (an app error still retried past retry.maxAttempts, every 6 hours), failed (until the user changes
// again or a reconcile), and the accounts and groups the app confirmed.
const { targets } = await auth.api.scimProvisioningStatus({ body: {} });
// One user's account and pending job at each target.
const { user } = await auth.api.scimProvisioningStatus({ body: { userId } });
// One target, or a page of them ({ limit, after: next }; with a registry, 25 by default).
const { targets: [app] } = await auth.api.scimProvisioningStatus({ body: { targetId: "app" } });
// Which jobs failed or are stuck, with the app's last error; then { after: next } for more.
const { items, next } = await auth.api.scimProvisioningFailures({ body: { limit: 100 } });
```

In `scimProvisioningFailures` items and `onFailure`, `kind` is what was being delivered: `user`, or a group: `group` (an organization's own group), `team` or `role` (and, in failures only, `resync`: queueing an organization for its own target, page by page). `subjectId` is the user's, organization's or team's id, and for a role group `"<organization id>:<role>"`.

`onFailure` is called when a delivery gives up (an error that won't fix itself) or reaches `retry.maxAttempts`: alert on it, so a deprovisioning that isn't getting through doesn't go unnoticed.

```ts
scimProvisioning({
  targets: [/* … */],
  onFailure: ({ targetId, kind, subjectId, error, status, attempts, failed }) => alert(`provisioning ${kind} ${subjectId} at ${targetId}: ${error}`),
});
```

When something changes memberships outside Better Auth's organization endpoints (an SSO sync, inbound SCIM, your own database writes), queue what changed, and it's delivered in the background:

```ts
// Someone added to, or removed from, an organization (or given another role, or another team):
await auth.api.scimProvisioningQueue({ body: { userId, organizationId } });
// Only the user (their account, and the groups they're in now): { userId }
// Only an organization's groups: { organizationId }; at one target: add targetId.
```

For a removal, pass the organization as well: the user isn't in its groups any more, so queueing only the user can't find the group they left.

## Who is provisioned, and what's sent

A user is at a target when their email is verified (unless `requireVerifiedEmail: false`), they aren't banned (the admin plugin), they're a member of `organizationId` if one is set, and `include` returns true (if set). Otherwise they're deprovisioned there, if they had been provisioned. A timed ban is lifted at the app when it runs out.

Membership changes are seen through the organization plugin's endpoints (add, remove, update role, accept an invitation, leave, delete the organization) and server-side `addMember`. Changes made any other way (the creator of a new organization, SSO or inbound SCIM provisioning, your own database writes) are applied at the user's next change or the next reconcile. **That includes removals:** someone removed from an `organizationId` organization by those means keeps their account at the app until then, so call `scimProvisioningQueue` for them (see [Watching it](#watching-it)), or run a reconcile.

By default the app gets:
- **`userName`** and the one primary **`emails`** value: the user's email;
- **`name`**: `givenName` and `familyName` split from Better Auth's `name`. The last word is the family name; a one-word name fills both, since apps such as AWS IAM Identity Center require both;
- **`displayName`**: the name;
- **`externalId`**: the Better Auth user id;
- **`active`**.

Override it per target with `mapUser`, for example to take `userName` from an employee id. `defaultScimUser(user)` is exported to build on.

## Groups

With `groups: true`, each organization (Better Auth's organization plugin) is a group at the app, or only `organizationId`'s when that's set. With a function, only the organizations it returns true for: `groups: (org) => org.slug.startsWith("team-")`.

> **Who can name a group?** Better Auth lets any signed-in user create organizations by default, and each organization becomes a group at the app. A user could then create one called "Administrators", with themselves in it. Some apps match access rules by group name. Restrict who creates and renames organizations (the organization plugin's `allowUserToCreateOrganization` and roles), or choose groups with a function.

The group's members are the organization's members who are provisioned and active at that target, so a banned or unverified member isn't in it.

**Teams and roles** can be groups too, the same way:
- `teamGroups: true`: each team (the organization plugin's `teams`) is a group of its provisioned members, named "Acme / Red". A function chooses which: `teamGroups: (team, org) => team.name.startsWith("eng-")`. `teamGroupName: (team, org) => string` names them.
- `roleGroups: ["admin"]`: the members holding that role in each organization are a group, named "Acme / admin"; `roleGroups: true` makes one for every role held. A member with several roles is in each role's group. `roleGroupName: (role, org) => string` names them.

All three kinds can be used together. Any change in an organization (members, roles, teams, the organization itself) updates its groups; a removed team, or (with `roleGroups: true`) a role no one holds any more, has its group removed at the app. A role named in a `roleGroups` list keeps its group even while no one holds it.

- **When it changes:**
  - members join or leave (add, remove, accepting an invitation, leaving), change role, or join or leave a team;
  - a member is provisioned, deprovisioned or deleted;
  - the organization or team is renamed (the group is renamed) or deleted (the group is removed at the app);
  - a reconcile runs.
- **Rebuilt each time:** the group is recomputed from the database on every delivery, so it converges whatever order changes arrive in. A change made in the app is delivered at once; a reconcile updates each group a few times, not once per member.
- **Never taken over:** a group of the same name that isn't the organization's (another `externalId`, or one made by hand) is refused, because replacing it would rewrite its members. The name is looked up before the first create. If that create fails or its reply is lost, a group found later without our `externalId` is taken as ours only when everyone in it is someone we'd put there; otherwise it's refused. Rename one of them, or set `groupName`.
- **Verified** at Cloudflare Access (in the field test, by hand), Google Workspace and AWS IAM Identity Center (live tests).

Most apps grant access by group: assign the group to the app or role there (AWS permission sets, Atlassian products, Cloudflare Access policies).

## How it holds up

- **An outbox in your database.** A change queues one job per user and target. The job carries no user data: delivery reads the user as they are then, so quick changes collapse into one request with the latest state.
- **Never in the way.** Provisioning never fails the user's own write. A failure to queue is logged, and the next reconcile catches up: until then that change isn't queued.
- **Leases.** A job is claimed before delivery, so two workers don't deliver it at once; a group delivery renews its claim while it runs. A change that arrives during a delivery goes out straight after it.
- **Retries.** 429 (honouring `Retry-After`, at every kind of target), 408, 5xx, timeouts, network errors, 401/403 (an expired token is the host's problem, not the user's), and a wrong target URL (a 404 for everything, or a redirect) are retried with backoff, for as long as it takes. The job's last error says which: "check the target's token", "check the target's url". Other errors fail the job until the user changes again or a reconcile runs, and are logged with the app's message.
- **Lost replies.** The account is recorded as pending before it's created, so if the app's reply is lost and the user then leaves, the account is still found and switched off. At apps that don't keep `externalId`, we can't always tell that account from one made by hand in the meantime: then the job fails with a message instead of guessing, and the pending record is kept, so a later leave fails loudly too rather than passing for done.
- **Careful adoption.** A user who already exists at the app is found by userName and taken over only if that account is ours (our `externalId`), or nobody's: no `externalId`, not linked to another user here, active, the user's email verified, the account's userName that same email, and the target allowing it (`adopt`, off by default for Google Workspace). An account taken over is marked so, and is only ever deactivated, never deleted, even with `deprovision: "delete"`. With a custom `mapUser` userName (an employee id, a handle), accounts made by hand at the app are therefore never taken over: give them our `externalId` at the app, or remove them, first. A new user signing up with a deleted user's old email is refused, not handed the old account, even at apps that don't keep `externalId`.
- **A 404 is checked, not believed.** A user is taken as gone at the app only when the app's own list agrees. A wrong URL answers 404 for everything, and believing it would mark people deactivated here while they stay active there.
- **Reconcile** covers every user, and every user still linked at a target, so deleted users whose deprovisioning was lost are cleaned up too.
- **Deleted users' links are kept** (with `deprovision: "deactivate"`): the account stays at the app, deactivated, and its link (with the userName, usually the email) stays here, so switching to `delete` later can still remove it. Every reconcile looks at them again. If you need that data gone, delete those rows from `scimProvisioningLink`.
- **No redirects.** The token only goes to the target's URL: a redirect is never followed. It's retried (a maintenance page passes), with the new location in the error, so a target moved for good shows up as "check the target's url".

## Apps

Some apps differ from the SCIM standard. A **profile** sets a target up for one: it fills in what that app's documentation requires, and anything you set on the target yourself still wins.

```ts
import { awsIamIdentityCenter, scimProvisioning } from "better-auth-scim-provisioning";

scimProvisioning({
  targets: [awsIamIdentityCenter({ id: "aws", url: process.env.AWS_SCIM_URL!, token: process.env.AWS_SCIM_TOKEN!, groups: true })],
});
```

| App | Profile | Status | What it handles |
|---|---|---|---|
| Cloudflare Access | `cloudflareAccess` | verified live | Nothing differs. Turn on **seat deprovisioning** in the identity provider's SCIM settings, or deactivated users keep their seats. |
| AWS IAM Identity Center | `awsIamIdentityCenter` | verified live | Groups have no PUT and list no members, so they're updated by a diff of members, at most 100 per request, read through AWS's users filter page by page (cursor). Verified with users, organization, team and role groups, and a 105-member group. |
| Slack | `slack` | documented | userNames must be lowercase, at most 21 characters, with only `.` `_` `-`: taken from the email's local part (`slackUserName`). Deleting only deactivates. Since the userName isn't the email, Slack accounts made by hand are never adopted: give them our `externalId`, or remove them, first. |
| Atlassian | `atlassian` | documented | Groups can't be renamed, so a renamed group is created anew with its members, then the old one deleted (retried until it is). If a group with the new name exists and isn't ours, the job fails. |
| GitHub Enterprise Managed Users | `githubEnterprise` | documented | GitHub's DELETE permanently suspends an account, so this only deactivates, and refuses `deprovision: "delete"`. |
| Better Auth apps (`@better-auth/scim`) | | tested against the real package | Nothing differs. See [Better Auth apps](#better-auth-apps-and-id-jag), which also covers ID-JAG. |
| Google Workspace | `type: "google-workspace"` | verified live | Not SCIM: see [Google Workspace](#google-workspace). |
| Anything else | `type: "webhook"` | | Signed webhooks to your own code or an automation platform: see [Webhooks](#webhooks). |

"Verified live" means tested against the app itself. "Documented" means built from the app's documentation and tested against a model of it. Run `check` against it first (below), and tell us what you find.

- **Cloudflare Access.** Zero Trust → Integrations → Identity providers → your identity provider → turn on **Enable SCIM** and **Enable user deprovisioning**, **save**, then copy the SCIM endpoint and secret.
  - The secret only works once the provider is saved: if you copied it before saving, regenerate it, copy it, and save.
  - With SCIM, a user exists at Cloudflare before their first sign-in, and that sign-in lands on the same account.
  - Verified live: a ban revoked the user's Access session within 35 seconds, and a timed ban was lifted by the scheduled run within a minute of ending.
  - Cloudflare's Users list shows the name from the last sign-in, not the latest SCIM update.
- **AWS IAM Identity Center.** IAM Identity Center → Settings → Identity source → **Automatic provisioning**.
  - Its tokens last a year.
  - Your identity provider's SAML NameID must be the same value as the SCIM `userName` (the email, by default).
  - Users need a given name, a family name, a display name and a single primary email, which the default mapping always sends.
- **GitHub Enterprise Managed Users.**
  - The token is a classic personal access token of the setup user, with `scim:enterprise`.
  - Only one system may provision the enterprise.
  - GitHub asks for at most 1,000 users an hour, so keep `concurrency` low for a first reconcile.
- **Anything else that speaks SCIM 2.0**, with a bearer token, Basic auth, an API-key header or OAuth 2.0 client credentials (Salesforce, Zoom, your own apps).
  - If an app differs in a way a profile would cover, `compat` sets the same behaviours by hand: `groupUpdate: "patch"`, `groupMembers: "users-filter"`, `maxGroupMembersPerRequest`, `groupRename: "recreate"`.

### Better Auth apps, and ID-JAG

An app built on Better Auth can take users in with Better Auth's own [`@better-auth/scim`](https://www.better-auth.com/docs/plugins/scim). Give it a connection for your identity provider, and point a target at its endpoint:

```ts
// The app: inbound SCIM, one connection for your identity provider.
scim({ connections: [{ id: "our-idp", credentials: [{ type: "bearer", id: "idp-token", token: process.env.SCIM_TOKEN! }] }] });

// Your identity provider: a target for that app.
scimProvisioning({ targets: [{ id: "app", url: "https://app.example.com/api/auth/scim/v2", token: process.env.APP_SCIM_TOKEN! }] });
```

The tests run this pair for real: [`@better-auth/scim`](https://www.npmjs.com/package/@better-auth/scim) at the same versions as Better Auth, in CI. They show:

- Users are created there, updated, deactivated when banned or deleted here, and reactivated when unbanned; `deprovision: "delete"` deletes them there.
- Organizations arrive as SCIM Groups with their provisioned members (`groups`).
- **Deactivation signs the user out there.** `@better-auth/scim` deletes a user's sessions once none of their SCIM connections has them active.
- **Only users with a verified email are sent**, by default (`requireVerifiedEmail`), so a new sign-up appears there once they've verified it.
- **Their email is unverified there.** `@better-auth/scim` creates users with `emailVerified: false`. If the app requires verified emails to sign in with a password, provisioned users sign in another way (SSO, an ID-JAG) or verify there.

**ID-JAG.** An app that accepts ID-JAGs (Identity Assertion JWT Authorization Grants, the grant behind Cross App Access and MCP's Enterprise-Managed Authorization) can find the user an ID-JAG names through this link: `acquireActiveSCIMUserLink({ connectionId, externalId: sub })` from `@better-auth/scim`. That works because an ID-JAG issued by a Better Auth identity provider carries the Better Auth user id as its `sub` (unless the provider gives clients pairwise subject identifiers), and that id is the `externalId` this package sends by default.

- **Keep the default `externalId`.** A `mapUser` that changes `externalId` breaks the link: the `sub` no longer finds anyone. The tests pin this.
- **Deprovisioning blocks it.** The link is found only while the user is active there, so a banned, deleted or deprovisioned user's ID-JAGs find no one, from the moment the deactivation is delivered (usually at once; after a retry if the app was down).

### Google Workspace

Google doesn't accept SCIM, so Workspace is its own kind of target, through the Directory API: users, and with `groups`, `teamGroups` or `roleGroups`, Google Groups. Verified live against a real Workspace: users (create, rename, email change, suspend, unsuspend, deprovision, and the refusals below) and groups (an organization, a team and a role, through a rename, a member leaving, and removal).

```ts
{
  id: "google",
  type: "google-workspace",
  google: {
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL!, // the service account (client_email)
    privateKey: process.env.GOOGLE_PRIVATE_KEY!,   // its key (private_key), PEM
    adminEmail: "provisioning-admin@your-domain.com", // the Workspace admin it acts as
    orgUnitPath: "/Provisioned",                   // optional: where new users go (existing users are never moved)
  },
  groups: true,                                    // optional: organizations as Google Groups (also teamGroups, roleGroups)
}
```

Setting it up:
1. In Google Cloud, create or choose a project (a plain one; no billing needed) and enable the **Admin SDK API**.
2. Create a **service account** (IAM & Admin → Service Accounts). It needs no role in the project: skip that step. Then add a JSON key (Keys → Add key → JSON). `client_email` and `private_key` go in the options.
3. In the Workspace Admin console, as a super admin, go to Security → Access and data control → API controls → **Domain-wide delegation** → Add new. The client ID is the service account's **Unique ID** (its Details tab), with the scope `https://www.googleapis.com/auth/admin.directory.user`, and for groups also `https://www.googleapis.com/auth/admin.directory.group` (comma-separated). It can take a few minutes to apply. A target with groups asks for both, and Google refuses its token if delegation allows only one, so set them together.
4. Choose an **admin** for it to act as, with permission to manage users.
5. Optionally, create an **organizational unit** for the users it creates (Directory → Organizational units) and set `orgUnitPath`: there you decide which Workspace services they get.

How it maps:
- the email (`userName`) becomes `primaryEmail`, which must be in one of the Workspace's domains;
- the names map to `name`, and Google requires both;
- deprovisioning suspends the user, or deletes them with `deprovision: "delete"`;
- our user id is a custom entry in `externalIds`, and any other external ids an admin set are kept;
- Google requires a password when a user is created, so a random one is set. Users sign in through your identity provider (with [better-auth-saml-idp](https://www.npmjs.com/package/better-auth-saml-idp) as Workspace's SAML identity provider), so it's never used.

Groups (`groups`, `teamGroups`, `roleGroups`, as for SCIM apps):
- each group is a Google Group at an address made from its externalId, such as `ba-team-<team id>@your-domain.com`, so renaming an organization renames the group without moving it. Set `google.groupDomain` for another domain, or `google.groupEmail: (externalId) => string` to name them yourself, and keep it stable: the address is how the group is found again;
- the description marks it ours. A group already at that address without our marker is someone else's, and is never taken over;
- members are the provisioned users, added and removed one request each; members that aren't users (a nested group an admin added) are left alone.

Adoption follows the same rules as SCIM, and an account that merely has the user's email as an *alias* is never taken over. Nor is a suspended account made by hand: taking it over would unsuspend it, so the job fails until an admin unsuspends it (or gives it our id). Right after a create, Google sometimes says an account exists before it can show it; that's retried.

Google takes a while to settle, and the plugin waits it out rather than failing:
- for a few seconds after a create, the new user answers 404 by id, and 412 "User creation is not complete" to a delete;
- for a minute or more after an email change, further changes to that user (a ban, say) are answered with 409;
- reads of a new user can trail its changes by a minute or more, so the Admin console may briefly show older details;
- a group made seconds ago can answer 404 to its first members, and say "already exists" while a read of it still finds nothing.

### Webhooks

For anything that doesn't speak SCIM (your own apps, or automation platforms such as Zapier, Make and n8n), a webhook target POSTs every change as a JSON event, signed with HMAC-SHA256:

```ts
{ id: "my-app", type: "webhook", url: "https://my-app.example.com/hooks/provisioning", secret: process.env.PROVISIONING_WEBHOOK_SECRET! }
```

Each event holds the full current state, so applying one twice is harmless, and `occurredAt` lets a receiver ignore an older one:

| `type` | Body |
|---|---|
| `user.upsert` | `user`: the SCIM user (as `mapUser` makes it), with `externalId` |
| `user.deactivate` | `user: { externalId }` |
| `user.delete` | `user: { externalId }` (with `deprovision: "delete"`) |
| `group.upsert` | `group`: `displayName`, `externalId`, `members` (the users' `externalId`s); with `groups`, `teamGroups` or `roleGroups` |
| `group.delete` | `group: { externalId }` |

Every event also carries `id`, `schemaVersion` (1; a change a receiver could trip over is a new version, in a major release), `target` and `occurredAt`: when this attempt was sent (not when the change was made). A user's or group's events are sent one at a time, so a later `occurredAt` is a later state. Check the signature on the receiving side with the raw body:

```ts
import { verifyWebhookSignature, WebhookSignatureError } from "better-auth-scim-provisioning";

export async function POST(request: Request) {
  const body = await request.text();
  let event;
  try {
    event = await verifyWebhookSignature({ body, signature: request.headers.get("x-scim-provisioning-signature"), secret: process.env.PROVISIONING_WEBHOOK_SECRET! });
  } catch (e) {
    // 401, not a 500: the sender's error then says "check the target's secret".
    if (e instanceof WebhookSignatureError) return new Response(e.reason, { status: 401 });
    throw e;
  }
  // event.type, event.user / event.group …
  return new Response(null, { status: 204 });
}
```

It throws on a wrong signature, or one more than 5 minutes old, which stops a captured request being replayed later. A retry of the same change carries the same `id` (with a new signature and `occurredAt`), and within those 5 minutes a captured request could be replayed, so make applying an event idempotent: remember the event `id`s you've applied for a while, and drop an event whose `occurredAt` is older than the last one you applied for that user or group.

**Rotating the secret:** let the receiver accept both (`secret: [newSecret, oldSecret]`), switch the target to the new one and deploy, then drop the old one from the receiver.

A user's `externalId` is their id at the receiver. If a `mapUser` changes it for users already sent, the receiver sees new users, and the old ones are never deactivated: keep it stable.
- **Retried:** 5xx, 429, 408, timeouts, and 401/403 ("check the target's secret").
- **Fails the job:** any other 4xx.
- **A 404 is a wrong URL:** it's retried, and never read as "already gone".

### Check an app first

`check` asks an app what its SCIM supports: its ServiceProviderConfig, then a throwaway user taken through create, find, replace, both PATCH forms, deactivate and delete (removed at the end):

```sh
SCIM_TOKEN=… npx better-auth-scim-provisioning check --url https://example.com/scim/v2 --user-name check@your-domain.com
```

```
✓ ServiceProviderConfig: patch true, filter true, bulk false, etag false, sort false; auth: oauthbearertoken
✓ create a user: 201, id 4bb3b660-…
✓ keeps externalId
✓ find by userName
✓ find by userName, any case
✓ duplicate userName refused (409)
✓ update with PUT
✓ update with PATCH (no path)
✓ update with PATCH (path)
✓ deactivate (PATCH active false)
✓ delete
```

Like the plugin, it sends the token only over https (http only to localhost).

For other auth methods, `--auth auth.json`, a file holding the `auth` object as in the table above (or `{ "auth": { … } }`):

```json
{ "type": "oauth2", "tokenUrl": "https://login.example.com/oauth2/token", "clientId": "…", "clientSecret": "…" }
```

 From code (an admin page's "test connection"), `checkScimTarget({ url, token | auth })` returns the same results.

## Organizations' own targets

With `registry`, each organization can connect its own apps at runtime (its SCIM app, its Google Workspace domain, a webhook), the way better-auth-saml-idp's registry does for service providers. A stored target belongs to one organization and only ever receives that organization's members and groups. Targets in code work as before, alongside.

```ts
scimProvisioning({
  targets: [], // or your own, as before
  registry: {
    // Your own administrators manage every organization's targets (optional).
    canManage: ({ user }) => user.role === "admin",
    // And each organization's owners and admins manage their own (the default; [] turns it off).
    organizationRoles: ["owner", "admin"],
  },
}),
```

It needs Better Auth's organization plugin, and adds a table, `scimProvisioningTarget`: run your migration (`npx auth migrate`, or generate your ORM's schema) after turning it on, before deploying: Better Auth refuses requests while a table it expects is missing. Without `registry` the table doesn't exist and the endpoints answer 404 (401 to someone signed out).

With the organization plugin's defaults, every signed-up user can create any number of organizations, and so becomes an owner who can connect targets, whose deliveries share your scheduled run with everyone else's. If that's not what you want, limit who creates organizations (`allowUserToCreateOrganization`, `organizationLimit`), or set `organizationRoles: []` so only `canManage` decides.

```ts
// Connect an app to an organization (as one of its owners or admins). The id is generated.
const { target } = await authClient.$fetch("/scim-provisioning/targets/create", {
  method: "POST",
  body: {
    organizationId,
    settings: { name: "Slack", url: "https://api.slack.com/scim/v2", profile: "slack", groups: true },
    credentials: { token: "xoxp-…" },
  },
});
// The organization's members and groups are queued, a page at a time; later changes follow as for any target.

GET  /scim-provisioning/targets?organizationId=…&limit=…&offset=…  // list (a host administrator may omit organizationId)
POST /scim-provisioning/targets/update  { id, settings?, credentials?, enabled? }
POST /scim-provisioning/targets/check   { id }   // try the URL and credentials, changing nothing
POST /scim-provisioning/targets/status  { id }   // queued, waiting, stuck, failed; the latest failures' status
POST /scim-provisioning/targets/delete  { id }
```

On the server they're `auth.api.scimProvisioningListTargets`, `…CreateTarget`, `…UpdateTarget`, `…CheckTarget`, `…TargetStatus` and `…DeleteTarget`, with the user's headers.

- **Settings** are the target options that are data: `type`, `url`, `profile` (by name: `awsIamIdentityCenter`, `slack`, `atlassian`, `githubEnterprise`, `cloudflareAccess`), `update`, `compat`, `groups`, `teamGroups`, `roleGroups`, `adopt`, `deprovision`, `requireVerifiedEmail`, `timeoutMs` (at most 30 s), and for Google Workspace `google: { clientEmail, adminEmail, orgUnitPath?, groupDomain? }`; plus a `name` for people. Functions (`mapUser`, `include`, the group name functions) and `organizationId` can't be stored: the organization is always the owner.
- **Credentials** are one of `{ token }`, `{ auth: { type: "basic" | "header" | "oauth2", … } }` (as in [Targets](#targets)), `{ secret }` for a webhook and `{ privateKey }` for Google Workspace. They're encrypted with Better Auth's secret, tied to the target, its organization and where it sends, and never shown: a target shows only their `kind`, and a webhook URL only its origin (Slack's and Azure's carry secrets in the path or query). They never go anywhere new either: changing a target's URL (or Google's `clientEmail` or `adminEmail`) needs the credentials given again, and a URL changed in the database rather than through the API doesn't get them (the target pauses). Two changes to one target at once can't mix: the second is refused (409) and is made again on what the first left. When you rotate Better Auth's secret (`secrets`), stored credentials are sealed again with the new one as they're used; keep the old secret until every target has been used once. If the secret changes without rotation, they can't be read: those targets pause (logged), and their deliveries are tried again every 15 minutes, so they go once the right secret is back or new credentials are given.
- **Who may**: a signed-in user, their session re-read from the database (a stateless deployment's signed cookie is its own record), as the database has them now (not banned, not impersonating): a host administrator (`canManage`) for every organization, or an owner or admin (`organizationRoles`) of the target's organization. Creating, changing and deleting also need a fresh session (signed in within Better Auth's `session.freshAge`, a day by default), as a password change does. Someone else's target is a 404. Changes are logged at `warn`, Better Auth's default level, with the acting user.
- **URLs** must be `https://` on the standard port and public, as your server calls them: no `localhost`, names without a dot, `.local`, `.internal`, `.lan`, `.home.arpa` and the like, and no private, loopback, link-local, shared, benchmarking, documentation or reserved address (IPv4 written as a number, or inside IPv6, included). Redirects are never followed. Each request is checked again by these rules as it's made (so a row allowed once, by an `allowHosts` entry since removed, say, reaches nothing inside), and the name is looked up (Node.js 22.3 and later, Bun, Deno) and refused if it resolves to a private address or doesn't resolve; on Workers, whose `fetch` can't reach private networks, the URL check is what applies. A name that changes what it resolves to between the check and the request can't be ruled out this way: if your server can reach internal services, route stored targets through an egress proxy with `registry.fetch` (which replaces the lookup). `allowHosts: ["scim.internal.example"]` makes exceptions, ports included. The check endpoint answers in broad terms ("the credentials were refused", "not found: check the URL"), never with the app's own words.
- **Changes** to a target's settings or credentials, or enabling it, queue its organization again (members, those with an account there, and its groups), and new credentials or enabling make what was waiting or failed go again, so a fixed token or a new setting applies to everyone. Renaming (`name`) changes nothing to send. The organization is queued as one job that the deliveries expand a page at a time (the first pages at once, in the background; the rest by the scheduled run), so creating a target for an organization of thousands stays a small request, on Workers too.
- **Sharing the queue**: a scheduled run gives no target more than half its batch while others' deliveries are due, so one slow or busy app doesn't hold everyone else's up.
- **Disabling** (`enabled: false`) pauses a target: changes are still queued for it, and wait, out of the scheduled run's way, until it's enabled again. **Deleting** removes the target, its queued jobs and its record of the accounts and groups it made; the accounts at the app stay as they are, and nothing tells the app any more. Deleting the organization deprovisions its members through its targets as usual (a disabled target's wait); its targets then belong to no one's organization, so only a host administrator (`canManage`) can enable or remove them.
- **Every server sees a change at once**: targets are read from the database when they're used (by organization for a change, by id for a delivery), nothing is kept as a list. `maxTargetsPerOrganization` (default 10) limits each organization.

## Databases and runtimes

Proven in CI. The whole suite runs on SQLite with Better Auth 1.7.5 and the latest 1.7.x, on Node.js 22 and 24; the database suite runs on Node.js 24 with the Better Auth version in the lockfile:

| Database | Through | |
| --- | --- | --- |
| SQLite (`node:sqlite`) | Kysely (Better Auth's built-in adapter) | every test |
| Cloudflare D1 (local, Miniflare) | Kysely | the outbox suite, D1's 100-parameter limit included |
| PostgreSQL 17 | Kysely, Drizzle, Prisma 7 | the outbox suite |
| MySQL 8.4 | Kysely, Drizzle | the outbox suite |
| MongoDB 8.2 | Better Auth's MongoDB adapter | the outbox suite |

The outbox suite is what differs between databases: leases, version checks, dates, booleans, `in` and `gt` queries, groups and reconcile. In the Drizzle and Prisma runs the tables come from Better Auth's migrator and the ORM schema from Better Auth's own table definitions, as `npx auth generate` builds it.

The built package also runs on **Bun** and **Deno**: CI runs the `check` CLI and a user's life, delivered to a SCIM app and a signed webhook, on both.

It uses only `fetch` and Web APIs, and runs on Cloudflare Workers. CI runs [the Workers example](examples/workers) inside workerd with D1, `waitUntil` and its Cron Trigger. It was also field-tested in a real app on Workers against Cloudflare Access, where 200 users were reconciled and delivered at about 6 users a second with the default concurrency.

## Not yet

- **Microsoft 365 / Entra ID** as a target (through Microsoft Graph), the other big suite after Google Workspace.
- **Live verification of the Slack, Atlassian and GitHub Enterprise profiles.** They're built from each app's documentation and tested against a model.

## Development

```sh
pnpm install
pnpm test        # SQLite and a mock SCIM app
pnpm typecheck && pnpm lint && pnpm pack:check
ADAPTER_DB=postgres ADAPTER_URL=postgres://postgres:test@localhost:5432/postgres npx vitest run test/adapters
ADAPTER_DB=d1 npx vitest run test/adapters    # also drizzle-postgres, drizzle-mysql, prisma-postgres, mysql, mongodb
```

The live tests (`test/live/`) run against real services when the git-ignored `.env.live` holds their settings (`SCIM_URL` and `SCIM_TOKEN`, `AWS_SCIM_URL` and `AWS_SCIM_TOKEN`, the `GOOGLE_*` ones): `npx vitest run -c vitest.live.config.ts`. Each file runs only with its settings.

**Releasing** (maintainers): keep CHANGELOG.md's `[Unreleased]` section current; then, on an up-to-date main, `pnpm release patch|minor|major ["summary"]` opens the **Release X.Y.Z** pull request (version bumped, section dated). Merging it is the go-ahead: [tag-release.yml](.github/workflows/tag-release.yml) tags `vX.Y.Z` and starts [release.yml](.github/workflows/release.yml), which tests, packs and, after the `npm` environment's approval, stages the tarball with provenance and an SBOM; approve the staged version on npmjs.com to publish it.

## License

[MIT](LICENSE) © Mark McIntosh
