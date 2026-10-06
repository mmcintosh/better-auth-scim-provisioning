# Upgrading from 0.3 to 1.0

1.0 fixes the API and the database schema it promises to keep ([versioning](versioning.md)). Most apps need two things: a migration, and a look at the startup log.

## Before you deploy

1. **Migrate the database.** Group links gain two columns, `kind` and `subjectId`, and links one, `adopted`. Better Auth checks the schema at runtime and refuses every request while they're missing, so migrate first: `npx auth migrate`, or `npx auth generate` for Drizzle and Prisma, then your usual migration. On D1, for example:
   ```sql
   ALTER TABLE "scimProvisioningGroupLink" ADD COLUMN "kind" text;
   ALTER TABLE "scimProvisioningGroupLink" ADD COLUMN "subjectId" text;
   ALTER TABLE "scimProvisioningLink" ADD COLUMN "adopted" integer;
   ```
   Optionally add the new index too (`npx auth migrate` doesn't add indexes to an existing table):
   ```sql
   CREATE INDEX "scimProvisioningGroupLink_organizationId_idx" ON "scimProvisioningGroupLink" ("organizationId");
   ```
   Links written before keep working: they're read the old way, and gain the columns when they're next updated.

   **By database:** MongoDB has nothing to migrate. With Drizzle or Prisma, regenerate your schema (`npx auth generate`) and add the index there if you want it. With the built-in adapter, Better Auth refuses every request until the columns exist; with Drizzle or Prisma the plugin's writes fail instead.
2. **Check your options.** Unknown, misspelled or misplaced options now stop the plugin at startup, with a message naming them (`did you mean organizationId?`). So do `update` and `compat` on webhook or Google Workspace targets (they did nothing there), secrets containing control characters (a line break, say), and options that need Better Auth's organization plugin (`organizationId`, `groups`, `roleGroups`) or its teams (`teamGroups`) without it. Anything 0.3 ignored is now an error: run your app once and read the log.
3. **Google Workspace targets no longer take over existing accounts** unless you set `adopt: true` on them. A new user whose address matches a Workspace account made elsewhere now fails ("this target doesn't take over existing accounts") instead of being taken over. Accounts taken over before 1.0 aren't marked `adopted` (the column is new): with `deprovision: "delete"`, run once with `deprovision: "deactivate"` if you want to be sure none of them is deleted.
4. **Reconcile goes a page at a time** (500 by default). If you call `scimProvisioningReconcile` once and ignore `next`, you now reconcile only the first page: loop with `after: next` until `next` is null ([setting up](../README.md#set-up)); on Workers, one page per invocation. A call from the start without `limit` that stops early logs a warning.

## Also changed

- **Endpoint parameters are strict.** An unknown parameter is refused, not ignored, and so is a reconcile cursor it didn't hand out.
- **An account deactivated at the app is never adopted.** If a new user's verified address matches a deactivated, unclaimed account at a SCIM app, it's refused (as Google's suspended accounts already were), not switched back on. Reactivate it at the app if it should be taken over; the job's error says so.
- **Webhook events carry `schemaVersion: 1`**, and keep their `id` across retries. The `id` is no longer a random UUID: it's derived from the change and its content, shaped like a UUID but not a valid v4 one, so don't validate it as v4. Receivers that ignore unknown fields need no change. `verifyWebhookSignature` throws `WebhookSignatureError` for a bad signature (answer 401) and accepts several secrets for rotation.
- **The `check` CLI exits 1 for an unknown command**, and its results have a stable `id`.
- **On Workers, OAuth and Google tokens** are no longer shared while being fetched, which could stall deliveries.

## New, if you want them

- `scimProvisioningStatus`, `scimProvisioningFailures`, `scimProvisioningQueue` and `onFailure`: see [Watching it](../README.md#watching-it). Hosts that read the plugin's tables directly should move to these; the tables are internal from 1.0.
