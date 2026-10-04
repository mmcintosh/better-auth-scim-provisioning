# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
