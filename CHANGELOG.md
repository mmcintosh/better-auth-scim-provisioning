# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **A group made by hand is no longer taken over after our first create failed.** At an app that drops externalId, a group created by hand after our create failed (a 503, a timeout) was found on the retry and its members rewritten. A group without our externalId is now taken as ours only if it has members and every one is someone we'd put there; our own create whose reply was lost still is.
- **Members who leave are removed at apps that list a group's members only when asked**, and at apps that page them by `startIndex`. With `groupUpdate: "patch"`, the members are read back to find who to remove: a group GET without them read as "no members", and index paging stopped at the first page, so leavers kept the group. Members are now asked for by name (`attributes=members`), and both cursor and index paging are followed.
- **Jobs held by a worker that stopped no longer block the scheduled run.** They stayed at the head of the queue and used up its limit, so jobs behind them (bans included) waited until their hold ran out.
- **A 429's `Retry-After` is kept when the user changed during that delivery**; the new change used to be sent again at once.
- **A long group delivery renews its hold on the job** while it runs (a large first sync, Google's one request per member), so a second worker can't pick the same group up halfway through.
- **Deleting an organization queues its members' deprovisioning before the response** (at targets scoped to it with `organizationId`). It was queued only in background work after the response, which Workers ends with `waitUntil`'s budget, so members not queued by then stayed active at the app until a reconcile. The deliveries still run in the background and on the scheduled run.
- **One `scimProvisioning()` used by several Better Auth instances** (per-tenant databases, for example) gives each its own queue. They all queued and delivered through the last instance's database.
- **A webhook event keeps its `id` when it's retried**, so a receiver can recognise a retry by it, as the README advises; the next change gets a new id, even one back to an earlier state. Every attempt used to get a new id.
- After an OAuth client secret (or a Google service account key) is rotated, a token fetched with the old one is no longer reused until it expires.
- `check` tells you to remove its test user by hand when the app's create answered without an id or failed after it may have made the user.

### Changed

- **Unknown, misspelled or misplaced options are refused at startup** instead of being dropped without a word. A target with `organisationId` (British spelling) used to provision every verified user instead of one organization's members. The error names the option and, where it's clear, what was meant (`did you mean organizationId?`, or that `groups` is an option of each target). `update` and `compat` are refused on webhook and Google Workspace targets, where they did nothing; the types say so too. **Check your options when upgrading:** anything the plugin ignored before now stops it from starting.

### Examples

- **A Workers example** ([examples/workers](examples/workers)): Better Auth on D1 provisioning to a SCIM app and/or a signed webhook, with `waitUntil`, a Cron Trigger for retries, organizations as groups (only admins create them), email verification, and admin routes to see the queue, run and reconcile. CI runs it inside workerd through Miniflare (sign-up to deletion, a retry delivered by the Cron Trigger, the committed migration checked against Better Auth's), and builds it as installed from npm.

### Tests

- **More databases in CI:** Cloudflare D1 (local, through Miniflare), Drizzle on PostgreSQL and MySQL, and Prisma 7 on PostgreSQL join SQLite, PostgreSQL, MySQL and MongoDB. A new test reconciles 150 linked users, more than D1 binds in one query; on D1 it fails without the batching that fixed this.
- **Bun and Deno in CI:** the built package runs the `check` CLI against a small SCIM app, then a user's life (create, rename, delete) delivered to it and to a signed webhook, on Node, Bun and Deno.

### Project

- The release job stages with npm 12.2.0 (was 11.20.0).

## [0.3.1] - 2026-10-05

No code changes: the npm page gets the rewritten README (what it does, what's verified live, what's next).

### Project

- A weekly canary tests against Better Auth's newest releases (`upstream-canary.yml`) and opens an issue when one breaks the plugin, and a weekly **Upstream watch** issue tracks Better Auth against the peer range and updates held back on purpose (`upstream-watch.yml`).
- Releases are one merge: `pnpm release patch|minor|major` opens the release PR, and merging it tags the version and starts the release run (`tag-release.yml`). Publishing still waits for the two approvals.

### Documentation

- The README opens like the companion's: what it does in a sentence, badges, an up-to-date status in place of the old 0.x note, a features list, what's verified live, and a table of contents. "Not yet" lists what's actually next (Microsoft 365, the remaining live checks, 1.0).

## [0.3.0] - 2026-10-05

Google Groups at Google Workspace targets, and AWS IAM Identity Center verified live. Upgrading from 0.2.x needs no database migration.

### Added

- **Google Groups at Google Workspace targets** (`groups`, `teamGroups`, `roleGroups`): organizations, teams and roles become Google Groups. Each is at an address made from its externalId, so a rename doesn't move it (`google.groupDomain`, `google.groupEmail`), and its description marks it ours, so a group someone else made is never taken over. Members are added and removed one at a time and read back a page at a time. Domain-wide delegation must also allow `https://www.googleapis.com/auth/admin.directory.group`. Verified live against a real Workspace. Google's lag right after a group is created (a 404 for its first members, then "already exists" while a read still finds nothing) is retried, not refused.

### Changed

- A refused Google token now says which scopes domain-wide delegation must allow.

### Documentation

- A link to the guide for using this package with better-auth-saml-idp (sign-in and provisioning together).
- AWS IAM Identity Center is verified live with the `awsIamIdentityCenter` profile: a user's whole life, organizations, teams and roles as groups, and a group of over 100 members. Nothing needed fixing. The test confirmed that AWS only pages a group's members when the first request carries a `cursor` parameter, which the plugin sends; the test model now requires it too.

## [0.2.1] - 2026-10-04

Google Workspace, verified live against a real Workspace, with fixes for what that found. Upgrade if you use a Google Workspace target: on 0.2.0, a ban right after an email change can fail and leave the user active in Workspace.

### Fixed

- Google Workspace, found by testing live against a real Workspace: Google takes a while to settle after a create or an email change, and its answers in that time failed jobs for good. Now they're retried:
  - a 404 for a user created seconds ago;
  - a 412 "User creation is not complete";
  - a 409 to any change made while an email change is applied. Before, a ban right after an email change failed and left the user active in Workspace.

  A new email that belongs to another Workspace account still fails, now with a clear message.
- Any target: if an app answers 404 for an account and then lists it under that same id, it's still being created. That's retried now; before, the second 404 failed the job.

### Documentation

- Google Workspace is marked verified live, and its setup steps are clearer: the service account needs no project role, its client ID is the Unique ID, and an organizational unit can hold the users it creates.

## [0.2.0] - 2026-10-03

More kinds of targets (Google Workspace, signed webhooks), teams and roles as groups, and profiles for specific apps. Upgrading from 0.1.0 needs no database migration.

### Added

- **Webhook targets** (`type: "webhook"`): every change POSTed as a JSON event with the full current state, signed with HMAC-SHA256; `verifyWebhookSignature` for receivers.
- **App profiles** (`awsIamIdentityCenter`, `slack`, `atlassian`, `githubEnterprise`, `cloudflareAccess`), and `compat` for the behaviours they set: group updates by a diff of members for apps without PUT on groups, members read through a users filter, batched member changes, and renamed groups recreated for apps that can't rename.
- **Google Workspace targets** (`type: "google-workspace"`): users created, updated, suspended and deleted through the Directory API, as a service account with domain-wide delegation. Users only for now.
- **Teams and roles as groups** (`teamGroups`, `roleGroups`, with `teamGroupName` and `roleGroupName`): each team, or each role in an organization, is a group of its provisioned members, kept in sync like organization groups.
- Upgrading from 0.1.0 needs no database migration: the schema is unchanged (a test keeps it so).

### Fixed

- A group job's lease now lasts long enough for a large group's batched requests, so a slow delivery isn't taken over and sent twice.
- A deleted user is removed from their groups at the app. SQL databases delete the user's memberships with them, so their groups weren't updated.
- A redirect or a 408 from a SCIM app (or Google) is retried instead of failing the job, so a ban answered by a maintenance page still reaches the app. Redirects are still never followed.
- A paged reconcile (`limit`) now pages the groups too. Before, it did all of them in its last call, which could run past the limits of a Workers invocation.
- A create whose reply was lost, followed by a rename before the retry, no longer leaves a second account (or group) at the app: the first is found under its old name and renamed.
- A worker with an old list of due jobs no longer sends a job another worker has just put off (a 429's `Retry-After`, a backoff).
- `checkScimTarget` and the `check` CLI refuse plain-http URLs, as the plugin does, instead of sending the token over them.
- `Retry-After` is honoured at every kind of target, not only SCIM.
- A warning is logged when an organization, user or team has more rows than are read at once (1,000), instead of skipping the rest's groups silently.
- Reviewed before release, including by an external reviewer; tested on SQLite, PostgreSQL, MySQL and MongoDB. Google Workspace, webhooks, teams and roles, and the AWS, Slack, Atlassian and GitHub profiles are tested against models of those apps, not live.

## [0.1.0] - 2026-10-02

The first release: outbound SCIM provisioning for Better Auth, with groups.

### Added

- **SCIM 2.0 provisioning for Better Auth** (`scimProvisioning`): users created, changed, banned or deleted, and organization members added or removed, are created, updated or deactivated at each target. An outbox in the database, delivered in the background and by a scheduled run (`scimProvisioningRun`), with leases, retries with backoff (Retry-After honoured), careful adoption of existing accounts, and `scimProvisioningReconcile`.
- Per target: `organizationId`, `include`, `requireVerifiedEmail`, `mapUser`, `deprovision` (`deactivate` or `delete`), `timeoutMs`.
- Auth methods per target (`auth`): Basic, an API-key header, and OAuth 2.0 client credentials, alongside bearer tokens.
- `update: "patch"` per target, which keeps attributes set at the app.
- `npx better-auth-scim-provisioning check` and `checkScimTarget()`: what an app's SCIM supports, tested on a throwaway user.
- Verified in a real app on Cloudflare Workers, D1 and Cron, live against Cloudflare Access.
- **Groups** (`groups: true` or a filter function, `groupName`): organizations as SCIM groups, with their provisioned members, kept in sync.
- `concurrency` (default 4): the scheduled run delivers several jobs at once; about four times faster than one at a time in the field test.
- `scimProvisioningReconcile` in pages (`limit`, `after` → `next`), for Workers and large user bases.
- Reviewed before release, including by an external reviewer, tested on SQLite, PostgreSQL, MySQL and MongoDB, and verified live against Cloudflare Access.
