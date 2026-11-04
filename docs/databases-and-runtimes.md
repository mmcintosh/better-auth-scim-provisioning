# Databases and runtimes

Proven in CI. The whole suite runs on SQLite with Better Auth 1.7.16 and the latest 1.7.x, on Node.js 22 and 24; the database suite runs on Node.js 24 with the Better Auth version in the lockfile:

| Database | Through | |
| --- | --- | --- |
| SQLite (`node:sqlite`) | Kysely (Better Auth's built-in adapter) | every test |
| Cloudflare D1 (local, Miniflare) | Kysely | the outbox suite, D1's 100-parameter limit included |
| PostgreSQL 17 | Kysely, Drizzle, Prisma 7 | the outbox suite |
| MySQL 8.4 | Kysely, Drizzle | the outbox suite |
| MongoDB 8.2 | Better Auth's MongoDB adapter | the outbox suite |

The outbox suite is what differs between databases: leases, version checks, dates, booleans, `in` and `gt` queries, groups and reconcile. In the Drizzle and Prisma runs the tables come from Better Auth's migrator and the ORM schema from Better Auth's own table definitions, as `npx auth generate` builds it.

**MongoDB and unique keys.** Better Auth's MongoDB adapter makes a table's own indexes, not the unique keys declared on single fields. So on MongoDB nothing stops two of the plugin's jobs, links or group links from sharing a key, or two decommissions from sharing a target. (A stored target's id has a table index of its own, so it's unique on MongoDB too.) The plugin is written for that. Two servers queueing the same user at the same moment can leave two jobs: they're delivered one at a time, and the user's latest state is what's sent. Two links for the same account, or two group links for the same group, are updated and removed together. What you may notice:
- `scimProvisioningFailures` and `scimProvisioningStatus` can list or count a user twice.
- The first time a target's credentials are alerted about, two servers running the scheduled run at the same moment can both call `onFailure`.
- A decommission started twice at the same moment can be recorded twice.

The built package also runs on **Bun** and **Deno**: CI runs the `check` CLI and a user's life, delivered to a SCIM app and a signed webhook, on both.

It uses only `fetch` and Web APIs, and runs on Cloudflare Workers. CI runs [the Workers example](../examples/workers) inside workerd with D1, `waitUntil` and its Cron Trigger. It was also field-tested in a real app on Workers against Cloudflare Access, where 200 users were reconciled and delivered at about 6 users a second with the default concurrency.
