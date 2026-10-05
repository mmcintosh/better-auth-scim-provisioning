# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Project

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
