# better-auth-scim-provisioning

Keep your users' accounts in step at the apps they use, straight from your [Better Auth](https://www.better-auth.com) server: **created before their first sign-in, updated when they change, switched off the moment they leave.** Over **SCIM 2.0**, **Google Workspace**'s Directory API, or **signed webhooks**. Runs on **Cloudflare Workers** and **Node.js**.

[![CI](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/ci.yml/badge.svg)](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/better-auth-scim-provisioning)](https://www.npmjs.com/package/better-auth-scim-provisioning)
[![Better Auth](https://img.shields.io/badge/better--auth-%E2%89%A51.7.5%20%3C1.8-black)](https://www.better-auth.com)
[![Runs on](https://img.shields.io/badge/runs%20on-Workers%20%7C%20Node%2022%2B-f38020)](#databases-and-runtimes)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/mmcintosh/better-auth-scim-provisioning/badge)](https://scorecard.dev/viewer/?uri=github.com/mmcintosh/better-auth-scim-provisioning)
[![CodeQL](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/codeql.yml/badge.svg)](https://github.com/mmcintosh/better-auth-scim-provisioning/actions/workflows/codeql.yml)

It's the **outbound** direction. Better Auth's own [`@better-auth/scim`](https://www.better-auth.com/docs/plugins/scim) is the inbound one, where directories push users *into* your app; this package pushes them *out*. It works however your users sign in, and pairs with [better-auth-saml-idp](https://www.npmjs.com/package/better-auth-saml-idp) when your app is also their identity provider: see [sign-in and provisioning together](https://github.com/mmcintosh/better-auth-saml-idp/blob/main/docs/guide/provisioning.md).

> **Unofficial community plugin.** This project isn't affiliated with or endorsed by Better Auth. Status: **0.3 on npm**, verified live against Cloudflare Access, Google Workspace and AWS IAM Identity Center, and field-tested in a real app on Workers. While it's 0.x, a minor release may change the API; every change is in the [CHANGELOG](CHANGELOG.md), and upgrades so far have needed no database migration.

If it's useful to you, a ⭐ on [GitHub](https://github.com/mmcintosh/better-auth-scim-provisioning) helps others find it.

## ✨ Features

- 🎯 **Three kinds of target**: any **SCIM 2.0** app (Cloudflare Access, AWS IAM Identity Center, Slack, Atlassian, GitHub Enterprise, Zoom…), **Google Workspace** through its Directory API, and **signed webhooks** for your own apps or automation tools (Zapier, Make, n8n).
- 👥 **Groups**: organizations, teams and roles in your app become groups at the app (SCIM groups or Google Groups), with the provisioned members, kept in sync as people join, leave and change roles.
- 🚪 **Real offboarding**: a ban or a delete deactivates (or deletes) the account at every app at once, not when a session expires; a timed ban is lifted on time by the scheduled run. Cloudflare Access revoked a live session within 35 seconds in the field test.
- 📬 **Delivery that holds up**: a database outbox with leases, retries with backoff (honouring `Retry-After`), concurrency, and a scheduled run. Changes are never lost to an outage, a timeout or a reply that never arrived, and a 404 counts as "gone" only when the app's list agrees.
- 🤝 **Careful adoption**: an account that already exists at the app is taken over only if it's provably this user's (ours by id, or nobody's, with the user's verified email as its userName), never handed to someone who reused a deleted user's email.
- 🧩 **Profiles for real apps**: `awsIamIdentityCenter`, `slack`, `atlassian`, `githubEnterprise`, `cloudflareAccess`, each built from the app's documented quirks (no PUT on groups, batches of 100, groups that can't be renamed…).
- 🔑 **Every sign-in method apps use**: bearer tokens, Basic, an API-key header, OAuth 2.0 client credentials, and Google service accounts with domain-wide delegation.
- 🔁 **Reconcile**: queue everyone again after adding or fixing a target, a page at a time, within a Workers invocation's limits.
- 🩺 **Check an app first**: `npx better-auth-scim-provisioning check` tries an app's SCIM with a throwaway user and reports what it supports.
- 📈 **You can see it**: every job's last error and status is in the database; failures are logged with the app's own message.
- ☁️ **Runs where your app runs**: only `fetch` and Web APIs; tested on Workers with D1, `waitUntil` and a Cron Trigger, and on Node.js 22 and 24, with SQLite, PostgreSQL, MySQL and MongoDB.
- 📦 **Supply chain**: SHA-pinned actions, CodeQL, dependency review, OpenSSF Scorecard, and a release workflow that publishes with npm provenance and an SBOM.

## ✅ Verified live

| App | Users | Groups | How |
|---|---|---|---|
| Cloudflare Access | ✓ | ✓ | the field test (a real app on Workers), the `check` CLI, and the live test |
| Google Workspace | ✓ | ✓ (Google Groups) | live tests in a real Workspace, which found and fixed how Google settles after creates and email changes |
| AWS IAM Identity Center | ✓ | ✓ (including a group of over 100) | live tests with the `awsIamIdentityCenter` profile |
| Webhooks | ✓ | ✓ | over real HTTP, with the receiver written exactly as shown below |

Slack, Atlassian and GitHub Enterprise are built from each app's documentation and tested against a model of it. The code was reviewed before 0.1.0 and before 0.2.0, each time by an outside reviewer as well as a fresh internal one.

## Contents

[Install](#install) · [Set up](#set-up) · [Targets](#targets) · [Who is provisioned, and what's sent](#who-is-provisioned-and-whats-sent) · [Groups](#groups) · [How it holds up](#how-it-holds-up) · [Apps](#apps) · [Google Workspace](#google-workspace) · [Webhooks](#webhooks) · [Check an app first](#check-an-app-first) · [Databases and runtimes](#databases-and-runtimes) · [Not yet](#not-yet) · [Development](#development)

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
   With many users, or on Workers (which limits the work per invocation), go a page at a time (groups included):
   ```ts
   let next: string | null = null;
   do {
     ({ next } = await auth.api.scimProvisioningReconcile({ body: { limit: 200, after: next ?? undefined } }));
   } while (next);
   ```

**A complete app to copy:** [examples/workers](examples/workers) runs this package on Workers and D1, with `waitUntil`, a Cron Trigger for retries, organizations as groups, and admin routes; CI runs it inside workerd. better-auth-saml-idp's [Workers example](https://github.com/mmcintosh/better-auth-saml-idp/tree/main/examples/workers-hono#provisioning-optional) adds sign-in and an admin page showing each user's account at each app, the queue and the groups.

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
| `url` | required | The app's SCIM base URL, without `/Users`. `https://` (`http://` only for localhost), with no query or credentials. |
| `token` | | Its bearer token. Or `auth`, for anything else: one of the two is required. |
| `auth` | | `{ type: "basic", username, password }`, `{ type: "header", name, value }` (an API key), or `{ type: "oauth2", tokenUrl, clientId, clientSecret, scope?, clientAuth?, params? }` (client credentials; tokens cached and renewed before they expire). |
| `update` | `"put"` | `"put"` replaces the whole user at the app; `"patch"` changes only the attributes we send, keeping what an admin set there. |
| `organizationId` | | Only members of this organization (Better Auth's organization plugin). |
| `include` | | `(user) => boolean`: who else to leave out. Only `true` includes; anything else deprovisions a provisioned user at their next delivery. |
| `requireVerifiedEmail` | `true` | Only users with a verified email. Set false if your sign-in leaves `emailVerified` false for addresses you trust. An account that already exists at the app is still only taken over for a verified email. |
| `mapUser` | see below | `(user) => ScimUser`: what's sent. |
| `groups` | `false` | Organizations as groups at the app: `true`, or `(organization) => boolean` to choose which (see [Groups](#groups)). |
| `groupName` | the organization's name | `(organization) => string`: the group's name. |
| `teamGroups` | `false` | Teams as groups: `true`, or `(team, organization) => boolean`. |
| `teamGroupName` | "Org / Team" | `(team, organization) => string`. |
| `roleGroups` | `false` | Roles as groups: `true` (every role held) or a list, `["admin"]`. |
| `roleGroupName` | "Org / role" | `(role, organization) => string`. |
| `compat` | | How the app differs from the standard, usually set by a profile (see [Apps](#apps)). |
| `deprovision` | `"deactivate"` | `"deactivate"` (`active: false`, the account is kept) or `"delete"`. |
| `timeoutMs` | `10000` | Per request. |

The scheduled run delivers 4 jobs at once by default: `concurrency: 4` (1 to 32), shared by all targets. Retries are shared too: `retry: { maxAttempts: 8, baseDelayMs: 30000 }`. The delay doubles each attempt, or is longer if the app's `Retry-After` asks for it (up to a day). After `maxAttempts`, failures that can fix themselves are retried every 6 hours.

A change to a target (`include`, `organizationId`, `deprovision`) applies to each user at their next change: run a reconcile to apply it to everyone, once the new version is fully deployed (on Workers, old and new run side by side for a few seconds). Do the same after an app's outage or a token fix, to deliver what's waiting now rather than at its next retry.

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
- **Never taken over:** a group of the same name that isn't the organization's (another `externalId`, or one made by hand) is refused, because replacing it would rewrite its members. The name is looked up before the first create, so a hand-made group is refused even when that create times out. Rename one of them, or set `groupName`.
- **Verified live** against Cloudflare Access.

Most apps grant access by group: assign the group to the app or role there (AWS permission sets, Atlassian products, Cloudflare Access policies).

## How it holds up

- **An outbox in your database.** A change queues one job per user and target. The job carries no user data: delivery reads the user as they are then, so quick changes collapse into one request with the latest state.
- **Never in the way.** Provisioning never fails the user's own write. A failure to queue is logged, and the next reconcile catches up.
- **Leases.** A job is claimed before delivery, so two workers never deliver it at once. A change that arrives during a delivery goes out straight after it.
- **Retries.** 429 (honouring `Retry-After`, at every kind of target), 408, 5xx, timeouts, network errors, 401/403 (an expired token is the host's problem, not the user's), and a wrong target URL (a 404 for everything, or a redirect) are retried with backoff, for as long as it takes. The job's last error says which: "check the target's token", "check the target's url". Other errors fail the job until the user changes again or a reconcile runs, and are logged with the app's message.
- **Lost replies.** The account is recorded as pending before it's created, so if the app's reply is lost and the user then leaves, the account is still found and switched off. At apps that don't keep `externalId`, we can't tell that account from one made by hand in the meantime, so the job fails with a message instead of guessing.
- **Careful adoption.** A user who already exists at the app is found by userName and taken over only if that account is ours (our `externalId`), or nobody's: no `externalId`, not linked to another user here, the user's email verified, and the account's userName that same email. With a custom `mapUser` userName (an employee id, a handle), accounts made by hand at the app are therefore never taken over: give them our `externalId` at the app, or remove them, first. A new user signing up with a deleted user's old email is refused, not handed the old account, even at apps that don't keep `externalId`.
- **A 404 is checked, not believed.** A user is taken as gone at the app only when the app's own list agrees. A wrong URL answers 404 for everything, and believing it would mark people deactivated here while they stay active there.
- **Reconcile** covers every user, and every user still linked at a target, so deleted users whose deprovisioning was lost are cleaned up too.
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

Every event also carries `id`, `target` and `occurredAt`. Check the signature on the receiving side with the raw body:

```ts
import { verifyWebhookSignature } from "better-auth-scim-provisioning";

export async function POST(request: Request) {
  const body = await request.text();
  const event = await verifyWebhookSignature({ body, signature: request.headers.get("x-scim-provisioning-signature"), secret: process.env.PROVISIONING_WEBHOOK_SECRET! });
  // event.type, event.user / event.group …
  return new Response(null, { status: 204 });
}
```

It throws on a wrong signature, or one more than 5 minutes old, which stops a captured request being replayed later. Within those 5 minutes the same request can arrive again (a retry, or a replay), so make applying an event idempotent: remember the event `id`s you've applied for a few minutes, and drop an event whose `occurredAt` is older than the last one you applied for that user or group.

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

## Databases and runtimes

Tested on SQLite (`node:sqlite`), PostgreSQL 17, MySQL 8.4 and MongoDB 8.2 (Better Auth's Kysely and MongoDB adapters), with Better Auth 1.7.5 and the latest 1.7.x, on Node.js 22 and 24.

It uses only `fetch` and Web APIs, and runs on Cloudflare Workers. It was tested there in a real app, with D1, `waitUntil` and a Cron Trigger, against Cloudflare Access: 200 users were reconciled and delivered at about 6 users a second with the default concurrency.

## Not yet

- **Microsoft 365 / Entra ID** as a target (through Microsoft Graph), the other big suite after Google Workspace.
- **Live verification of the Slack, Atlassian and GitHub Enterprise profiles.** They're built from each app's documentation and tested against a model.
- **A 1.0**, once the API has settled with real users.

## Development

```sh
pnpm install
pnpm test        # SQLite and a mock SCIM app
pnpm typecheck && pnpm lint && pnpm pack:check
ADAPTER_DB=postgres ADAPTER_URL=postgres://postgres:test@localhost:5432/postgres npx vitest run test/adapters
```

The live tests (`test/live/`) run against real services when the git-ignored `.env.live` holds their settings (`SCIM_URL` and `SCIM_TOKEN`, `AWS_SCIM_URL` and `AWS_SCIM_TOKEN`, the `GOOGLE_*` ones): `npx vitest run -c vitest.live.config.ts`. Each file runs only with its settings.

**Releasing** (maintainers): keep CHANGELOG.md's `[Unreleased]` section current; then, on an up-to-date main, `pnpm release patch|minor|major ["summary"]` opens the **Release X.Y.Z** pull request (version bumped, section dated). Merging it is the go-ahead: [tag-release.yml](.github/workflows/tag-release.yml) tags `vX.Y.Z` and starts [release.yml](.github/workflows/release.yml), which tests, packs and, after the `npm` environment's approval, stages the tarball with provenance and an SBOM; approve the staged version on npmjs.com to publish it.

## License

[MIT](LICENSE) © Mark McIntosh
