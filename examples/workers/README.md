# Example: provisioning on Cloudflare Workers

A Worker whose Better Auth users are provisioned to a SCIM app, a webhook receiver, or both, with:

- **D1** as Better Auth's database, with the package's tables in [`migrations/`](migrations);
- deliveries right after each response, kept alive with **`waitUntil`**;
- a **Cron Trigger** that delivers retries (an app that was down, a rate limit);
- organizations as **groups** at each target, and only admins may create organizations (see [Who can name a group?](../../README.md#groups));
- sign-up with email verification, since only verified addresses are provisioned;
- admin routes to see the queue, deliver now, and reconcile.

It's tested in CI inside workerd: [`test/example/workers.test.ts`](../../test/example/workers.test.ts) bundles it with this repository's source, runs it with D1 and the migration, the SCIM app and webhook mocked, and drives sign-up, verification, an organization, a failed delivery retried by the Cron Trigger, an account deletion and the admin routes. It also checks the dev mailbox stays off outside `localhost`. A second CI job installs this repository's package into it as npm would (packed), typechecks it and builds it with Wrangler.

> The example on `main` follows the next release: it may use features not yet on npm. For the published version, copy the example from that version's tag.

| Route | |
| --- | --- |
| `/api/auth/*` | Better Auth |
| `GET /dev/mailbox?email=…` | local development only: the verification link that would have been emailed (with `DEV_MAILBOX="true"`, on `localhost`) |
| `GET /admin/status` | per target: jobs queued, stuck and failed, accounts and groups at the app (`scimProvisioningStatus`) |
| `POST /admin/run` | deliver what's due now |
| `GET /admin/failures` | the jobs that failed or are stuck, with the app's last error (`scimProvisioningFailures`; `?after=` for the next page) |
| `POST /admin/reconcile` | queue every user and group again (after an outage, or to adopt existing users), a page per request: `?after=<next>` until `next` is null |

`/admin/*` is for signed-in users whose email is in `ADMIN_EMAILS`.

## Run it locally

```sh
cd examples/workers
npm install
cp .dev.vars.example .dev.vars        # set BETTER_AUTH_SECRET and a target; DEV_MAILBOX=true is for local use
npm run db:migrate:local
npm run dev
```

Before testing against a real app, check it with the package's CLI: `SCIM_TOKEN=… npx better-auth-scim-provisioning check --url <SCIM base URL>`.

Then sign up at `POST /api/auth/sign-up/email`, open the link from `http://localhost:8787/dev/mailbox?email=…`, and the user appears at the app.

## Deploy

Set everything up first, then deploy:

1. **Email:** send the verification link from `sendVerificationEmail` in [`src/auth.ts`](src/auth.ts) with your email provider. The dev mailbox is off unless `DEV_MAILBOX` is `"true"` (only in `.dev.vars`), and it never answers anywhere but `localhost`.
2. **Settings** in `wrangler.jsonc`: `BETTER_AUTH_URL` (the Worker's URL) and `ADMIN_EMAILS` (yours).
3. **Database and secrets, then deploy:**

```sh
npx wrangler d1 create scim-example      # paste its database_id into wrangler.jsonc
npm run db:migrate:remote
openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put SCIM_URL         # and SCIM_TOKEN; or WEBHOOK_URL and WEBHOOK_SECRET
npm run deploy
```

## Files

| | |
| --- | --- |
| [`src/auth.ts`](src/auth.ts) | Better Auth and the targets, from the Worker's settings |
| [`src/index.ts`](src/index.ts) | the routes, `waitUntil` and the Cron Trigger |
| [`migrations/`](migrations) | the tables (`0001`), and 1.0's group-link columns and index (`0002`); the test fails if they're behind the plugin's schema |
| [`wrangler.jsonc`](wrangler.jsonc) | D1, the cron schedule and the variables |

For sign-in as well as provisioning, see better-auth-saml-idp's [guide to using both together](https://github.com/mmcintosh/better-auth-saml-idp/blob/main/docs/guide/provisioning.md); its Workers example has an admin page for provisioning too.
