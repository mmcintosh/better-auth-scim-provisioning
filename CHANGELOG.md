# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **SCIM 2.0 provisioning for Better Auth** (`scimProvisioning`): users created, changed, banned or deleted, and organization members added or removed, are created, updated or deactivated at each target. An outbox in the database, delivered in the background and by a scheduled run (`scimProvisioningRun`), with leases, retries with backoff (Retry-After honoured), careful adoption of existing accounts, and `scimProvisioningReconcile` (DECISIONS.md D-001).
- Per target: `organizationId`, `include`, `requireVerifiedEmail`, `mapUser`, `deprovision` (`deactivate` or `delete`), `timeoutMs`.
- Auth methods per target (`auth`): Basic, an API-key header, and OAuth 2.0 client credentials, alongside bearer tokens (D-006).
- `update: "patch"` per target, which keeps attributes set at the app (D-006).
- `npx better-auth-scim-provisioning check` and `checkScimTarget()`: what an app's SCIM supports, tested on a throwaway user (D-006).
- Verified in a real app on Cloudflare Workers, D1 and Cron, live against Cloudflare Access (D-007).
- **Groups** (`groups: true`, `groupName`): organizations as SCIM groups, with their provisioned members, kept in sync (D-008).
- `concurrency` (default 4): the scheduled run delivers several jobs at once; about four times faster than one at a time in the field test.
- `scimProvisioningReconcile` in pages (`limit`, `after` → `next`), for Workers and large user bases.
- Reviewed twice before release (D-002, D-005), tested on SQLite, PostgreSQL, MySQL and MongoDB (D-004), and verified live against Cloudflare Access (D-003).
