# Versioning

From 1.0, this package follows [Semantic Versioning](https://semver.org): a **major** release for a change that could break your app, a **minor** release for anything new, and a **patch** release for fixes.

## What counts as the public API

A change to any of these that could break an app using them as documented comes only in a major release:

- **The exports** of `better-auth-scim-provisioning`: `scimProvisioning`, the profiles, `defaultScimUser`, `splitName`, `checkScimTarget`, `verifyWebhookSignature`, `webhookSignature`, `WebhookSignatureError`, the constants (`SCIM_USER_SCHEMA`, `SCIM_GROUP_SCHEMA`, `WEBHOOK_*`), `ScimError`, and the exported types.
- **The options**: their names, what they accept, and their defaults, including `fetch` (a proxy's or a Workers service binding's) and Google's `url` and `tokenUrl`. Unknown options are refused at startup, so a new option never changes what an existing configuration means.
- **The endpoints** on `auth.api`: `scimProvisioningRun`, `scimProvisioningReconcile`, `scimProvisioningStatus`, `scimProvisioningFailures` and `scimProvisioningQueue`, their parameters (unknown ones are refused) and the shape of what they return. New optional parameters and new fields in what they return can come in a minor release. A reconcile cursor (`next`) is opaque: pass it back as it is.
- **What's sent to apps**: the SCIM attributes in [Who is provisioned, and what's sent](../README.md#who-is-provisioned-and-whats-sent), and **webhook events** as described in [Webhooks](../README.md#webhooks), at `schemaVersion: 1`. New event types and new fields can come in a minor release, so receivers should ignore what they don't know.
- **The database schema**: the three tables and their columns. A column the plugin expects but the database lacks breaks things until you migrate (with Better Auth's built-in adapter it refuses every request; with Drizzle or Prisma the plugin's writes fail), so **any new or changed column comes only in a major release**, announced at the top of its release notes with the migration. A new index (which Better Auth doesn't check) can come in a minor release, with its SQL in the release notes. The rows themselves are internal: read them through `scimProvisioningStatus` and `scimProvisioningFailures`, not directly.
- **The CLI**: `check`, its flags, its exit code, and each result's `id` (the human-readable `name` may change).

## What doesn't

- Log messages, error message text, and the `name` and `detail` of `check` results.
- How deliveries are scheduled (timing, ordering, concurrency within the limits documented), as long as what's documented still holds.
- The example apps in `examples/`, which follow the next release.
- Behaviour that contradicts the documentation is a bug, and fixing it can come in a minor or patch release.

**Lists of values can grow in a minor release**: webhook event `type`s, `DeliveryFailure.kind` and the failures' `kind`, and `CheckId`. Their TypeScript types list today's values; code that switches over them should handle a value it doesn't know (a `default` branch), not assume the list is complete.

## Better Auth versions

The peer range (`better-auth` only; it brings `@better-auth/core` with it) covers the Better Auth versions this release is tested with: `>=1.7.5 <1.8.0` for 1.x so far. A new Better Auth minor (1.8) gets a release of this package that widens the range once it's tested, usually a minor one. Until then, npm will warn about the peer range. A weekly canary in CI runs the tests against Better Auth's newest releases, so that release comes quickly.

## Node.js and runtimes

Node.js 22 and later, Cloudflare Workers, Bun and Deno, as tested in CI. Dropping a Node.js version that's still maintained comes only in a major release.
