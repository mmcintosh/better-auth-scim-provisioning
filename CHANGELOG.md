# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Project

- Every dependency install in CI goes through Socket Firewall, which blocks confirmed malware before it downloads, the release job included. pnpm 10.34.6 won't resolve a version less than a day old (`minimumReleaseAge` in the new pnpm-workspace.yaml; Better Auth exempt for the canary and the latest-1.7 row), and Dependabot waits 3 days (`cooldown`). The README shows Socket's package badge.
- Interoperability tests against Better Auth's own inbound SCIM server, `@better-auth/scim`, as a real receiver, at the same version as Better Auth in each CI row. They cover users through their whole life, `deprovision: "delete"`, organizations as groups, sessions ended on deactivation, and the link an ID-JAG `sub` resolves through, including that a `mapUser` `externalId` breaks it.

### Documentation

- `CONTRIBUTING.md`: setup, the checks CI runs, the adapter and live tests, and what a contribution needs.
- `SECURITY.md`: a 7-day acknowledgement target, how fixed vulnerabilities are announced, and how releases are protected.
- `.bestpractices.json`: answers for the OpenSSF Best Practices badge, which bestpractices.dev reads to pre-fill them.
- The README shows the OpenSSF Best Practices badge (passing, project 15270).
- README, **Better Auth apps, and ID-JAG**: provisioning an app that uses `@better-auth/scim`, and how an ID-JAG receiver finds the user through the SCIM link. Keep the default `externalId` (the user id, which is an ID-JAG's `sub`). Deactivation there also signs the user out.

### Added

- **Organizations' own targets (`registry`)**: each organization connects its own SCIM app, Google Workspace domain or webhook at runtime, through `/scim-provisioning/targets` (list, create, update, check, status, delete), managed by its owners and admins (`organizationRoles`) and the host's administrators (`canManage`). Credentials are encrypted with Better Auth's secret, bound to the target and organization, never shown, never sent anywhere new without being given again, and sealed again when the secret is rotated. URLs must be https, on the standard port and public, and names are looked up before each request (`allowHosts` for exceptions; `registry.fetch` for a proxy). A stored target only receives its organization's members and groups; a disabled one keeps its changes queued and waiting. Stored targets are read from the database when used, so every server sees a change at once. The `scimProvisioningTarget` table exists only with `registry`: **turning it on needs a migration**, before deploying; without it, nothing changes.

### Changed

- A user's change queues an organization's target (`organizationId`) only for that organization's members and for users with an account at the target (however many organizations they're in); the other deliveries did nothing. A team's change queues only the targets of the team's organization.

## [1.0.0] - 2026-10-06

The first stable release: the API, the webhook format and the database schema are now covered by the versioning promise (docs/versioning.md).

**Upgrading from 0.3 needs a database migration, and options or calls 0.3 ignored now stop the plugin: follow [docs/upgrading.md](docs/upgrading.md).**

### Added

- **Webhook events carry `schemaVersion: 1`.** A change a receiver could trip over will be a new version, in a major release.
- **Rotating a webhook secret:** `verifyWebhookSignature` accepts several secrets (`secret: [newSecret, oldSecret]`) while the target switches over.
- **`WebhookSignatureError`**, with a `reason` (`malformed`, `expired`, `mismatch`), so a receiver can answer 401 rather than fail with a 500.
- **`ScimGroup` and `SCIM_GROUP_SCHEMA` are exported**, like `ScimUser` and `SCIM_USER_SCHEMA`.
- **`check` results have a stable `id`** (`create`, `find`, `update-put`, …; `CheckId`); the human-readable `name` may change.
- **[docs/versioning.md](docs/versioning.md)**: what 1.0 will promise, what counts as the public API, and how Better Auth's minor releases are followed.
- **`scimProvisioningStatus`**: per target, the jobs queued (due now), waiting (a backoff, a Retry-After, a ban running out), stuck (an app error still retried past `retry.maxAttempts`) and failed, and the accounts and groups the app confirmed; with `userId`, that user's account and pending job at each target. With `scimProvisioningFailures`, hosts no longer need to read the plugin's tables.
- **`onFailure`**: called when a delivery gives up or reaches `retry.maxAttempts`, with the target, what failed, the error and the app's status. Errors it throws are logged.
- **`scimProvisioningQueue({ userId?, organizationId?, targetId? })`**: queue what changed outside Better Auth's organization endpoints: a user (and the groups they're in), and/or an organization's groups. For a removal, pass both: only the organization finds the group the user left.
- **`scimProvisioningFailures({ targetId?, after?, limit? })`**: the failed and stuck jobs, with the app's last error and status, a page at a time.

### Fixed

- **Our own account is never left unfindable after a lost create reply.** At an app that drops `externalId`, when the retry couldn't tell the account was ours (a custom `userName`, an unverified email), the pending link was dropped: the account stayed active at the app, and a later ban or delete "succeeded" without a request. The link is kept now, and a later leave fails loudly ("resolve it at the app") instead.
- **Role names that differ only by case** (`Admin`, `admin`) **keep apart on MySQL**, whose keys compare case-insensitively: queueing failed with a duplicate-key error, and one role's group link could overwrite the other's. Roles with anything beyond `a-z0-9_-` are encoded in keys; links 0.3 wrote for them move to the new key on their next delivery.
- **Secrets never appear in errors.** A token with a line break made the request fail with an error repeating the header, secret included, into logs, `lastError`, `scimProvisioningFailures`, `onFailure` and `check`'s output. Secrets with control characters are refused at startup, and such an error never repeats the header.
- **`onFailure` isn't told about a delivery that's going out again at once** (bumped during it), and gets 5 seconds before the delivery moves on.
- **A group delivery holds its job for about a minute** (renewed while it runs), not ten or more, so one cut off with its Worker frees the group soon.
- **A webhook event's `id` also covers its content**: a retry sending something different (after a write that bypassed Better Auth's hooks) gets a new id.
- **OAuth and Google tokens no longer stall deliveries on Workers.** A token fetch in progress was shared by every request in the isolate; on Workers, a fetch started by a request that has ended is cancelled, so later deliveries waiting on it waited for ever (reproduced in workerd). Only tokens that have arrived are shared now.
- **An account deactivated at a SCIM app is no longer adopted and switched back on.** A new user with the same verified address (a rehire, a recycled address) reactivated it, with its old data and permissions. It's refused now, as Google's suspended accounts already were: reactivate it at the app first if it should be taken over.
- **Options that need Better Auth's organization plugin** (`organizationId`, `groups`, `roleGroups`), **or its teams** (`teamGroups`), **stop the plugin at startup** without it. Every reconcile, or every user's delivery, failed instead.
- **At Google, a user whose address is a Google Group's** (at targets with groups) fails, saying so; it was retried for ever as "not visible yet".
- `verifyWebhookSignature` without a secret (an unset environment variable) says so, instead of a `TypeError`.
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
- **The Workers example no longer exposes its dev mailbox when deployed.** `wrangler.jsonc` turned it on, and those settings are deployed too, so anyone could fetch the verification link for any address (and verify an admin's address). It's now on only through `.dev.vars`, it only answers on `localhost`, and the README's deploy steps set email up before deploying.
- **The Workers example no longer stalls after a first request it doesn't serve.** Better Auth finishes setting up its handler on the first call, and workerd cancels what a request leaves unfinished; the request that creates Better Auth now also calls its handler once.
- The example's `/admin/reconcile` works a page at a time (`limit: 200`).

### Changed

- **The `@better-auth/core` peer dependency is gone:** nothing in the package uses it, and `better-auth` brings it with it.
- **Taking over accounts made elsewhere is a choice per target: `adopt`**, on by default, **off by default for Google Workspace**, where it could reach someone's real mailbox. An account taken over is marked on its link (`adopted`) and is **never deleted, only deactivated**, even with `deprovision: "delete"`: it wasn't ours to delete. (Part of the 1.0 migration: links gain the `adopted` column.)
- **Webhook URLs may have a query string** (Azure Functions' `?code=`, Logic Apps' signatures); SCIM URLs still may not, since paths are appended to them.
- **`check`** takes `--url=…` as well as `--url …`, refuses unknown flags, and exits 1 only for an app the plugin can't work with: one that can't create, find or deactivate users, or update them with either PUT or PATCH (an app that only takes PATCH works with `update: "patch"`).
- **Endpoint parameters are checked strictly**, like the options: an unknown one (`targetID` for `targetId`) is refused instead of ignored, and a reconcile cursor it didn't hand out is refused (it used to report `next: null` having done nothing).
- **A reconcile called the 0.3 way** (no `limit`, no `after`) that stops at its default page logs a warning saying to call again with `after: next`.
- **The CLI exits 1 for an unknown command** (it exited 0); `help` exits 0.
- Group links are indexed by `organizationId`. New installs get the index from the migration; `npx auth migrate` doesn't add it to an existing table, so add it by hand if you like: `CREATE INDEX "scimProvisioningGroupLink_organizationId_idx" ON "scimProvisioningGroupLink" ("organizationId");` (the Workers example's `0002` migration does).
- **Upgrading needs a database migration** (`npx auth migrate`, or `npx auth generate` for Drizzle and Prisma): group links gain two optional columns, `kind` and `subjectId`, saying which group each is (an organization's, a team's or a role's) instead of it being read from the link's key. Better Auth checks the schema at runtime, so migrate before deploying. Links written before keep working and gain the columns as they're next updated. This is the schema 1.0 keeps.
- **Reconcile goes a page at a time by default** (500): a call without `limit` used to walk every user, link and group at once, past what a Workers invocation can do. Call again with `after: next` until `next` is null.
- **Unknown, misspelled or misplaced options are refused at startup** instead of being dropped without a word. A target with `organisationId` (British spelling) used to provision every verified user instead of one organization's members. The error names the option and, where it's clear, what was meant (`did you mean organizationId?`, or that `groups` is an option of each target). `update` and `compat` are refused on webhook and Google Workspace targets, where they did nothing; the types say so too. **Check your options when upgrading:** anything the plugin ignored before now stops it from starting.

### Documentation

- The 1.0 contract made explicit ([versioning](docs/versioning.md)): `fetch` and Google's `url`/`tokenUrl` are supported options (a proxy, a service binding), lists of values (event types, failure kinds, check ids) can grow in a minor release, and the missing-column behaviour differs by database adapter. The README says what `occurredAt` (when the attempt was sent), `kind` and a role's `subjectId` mean; the upgrade guide covers the webhook id format, each adapter, and that deleted users' links are kept.
- [docs/upgrading.md](docs/upgrading.md): upgrading from 0.3 to 1.0, step by step.
- The README now claims only what's checked, after an independent review:
  - "verified live" says exactly what (Cloudflare Access groups were checked by hand in the field test; the automated live test covers users), and webhooks, which have no third party to verify against, are described as tested over HTTP;
  - "proven in CI" says which suite runs on which Node.js and Better Auth versions;
  - delivery promises are qualified ("once queued");
  - membership **removals** made outside the organization plugin's endpoints wait for the user's next change or a reconcile;
  - the webhook receiver example answers a bad signature with 401 (a 500 was retried for ever), and a retry keeps its event id;
  - the targets table shows `url` isn't needed for Google Workspace, `auth` takes `{ type: "bearer" }` too, and `update`/`compat` are for SCIM targets.

### Examples

- **A Workers example** ([examples/workers](examples/workers)): Better Auth on D1 provisioning to a SCIM app and/or a signed webhook, with `waitUntil`, a Cron Trigger for retries, organizations as groups (only admins, by verified email, create or rename them), email verification, and admin routes to see the queue, run and reconcile. CI runs it inside workerd through Miniflare (sign-up to deletion, a retry delivered by the Cron Trigger, the committed migration checked against Better Auth's), and builds it as installed from npm.

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
