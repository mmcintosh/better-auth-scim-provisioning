# Example: provisioning on Cloudflare Workers

A Worker whose Better Auth users are provisioned to a SCIM app, a webhook receiver, or both, with:

- **D1** as Better Auth's database, with the package's tables in [`migrations/0001_init.sql`](migrations/0001_init.sql);
- deliveries right after each response, kept alive with **`waitUntil`**;
- a **Cron Trigger** that delivers retries (an app that was down, a rate limit);
- organizations as **groups** at each target, and only admins may create organizations (see [Who can name a group?](../../README.md#groups));
- sign-up with email verification, since only verified addresses are provisioned;
- admin routes to see the queue, deliver now, and reconcile.

It's tested in CI inside workerd, as deployed: [`test/example/workers.test.ts`](../../test/example/workers.test.ts) bundles it, runs it with D1 and the migration, and drives sign-up, verification, an organization, a failed delivery retried by the Cron Trigger, an account deletion, and the admin routes.

| Route | |
| --- | --- |
| `/api/auth/*` | Better Auth |
| `GET /dev/mailbox?email=…` | the verification link that would have been emailed (only with `DEV_MAILBOX="true"`) |
| `GET /admin/status` | jobs queued and failed, accounts and groups at the apps |
| `POST /admin/run` | deliver what's due now |
| `POST /admin/reconcile` | queue every user and group again (after an outage, or to adopt existing users) |

`/admin/*` is for signed-in users whose email is in `ADMIN_EMAILS`.

## Run it locally

```sh
cd examples/workers
npm install
cp .dev.vars.example .dev.vars        # set BETTER_AUTH_SECRET and a target
npm run db:migrate:local
npm run dev
```

Before testing against a real app, check it with the package's CLI: `SCIM_TOKEN=… npx better-auth-scim-provisioning check --url <SCIM base URL>`.

Then sign up at `POST /api/auth/sign-up/email`, open the link from `/dev/mailbox?email=…`, and the user appears at the app.

## Deploy

```sh
npx wrangler d1 create scim-example      # paste its database_id into wrangler.jsonc
npm run db:migrate:remote
openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put SCIM_URL         # and SCIM_TOKEN; or WEBHOOK_URL and WEBHOOK_SECRET
npm run deploy
```

Set `BETTER_AUTH_URL` to the Worker's URL, `ADMIN_EMAILS` to yours, and `DEV_MAILBOX` to `"false"` in `wrangler.jsonc`, then send verification email from `sendVerificationEmail` in [`src/auth.ts`](src/auth.ts) with your email provider.

## Files

| | |
| --- | --- |
| [`src/auth.ts`](src/auth.ts) | Better Auth and the targets, from the Worker's settings |
| [`src/index.ts`](src/index.ts) | the routes, `waitUntil` and the Cron Trigger |
| [`migrations/0001_init.sql`](migrations/0001_init.sql) | the tables, as Better Auth's migrator writes them for these options (the test fails if it's out of date) |
| [`wrangler.jsonc`](wrangler.jsonc) | D1, the cron schedule and the variables |

For sign-in as well as provisioning, see better-auth-saml-idp's [guide to using both together](https://github.com/mmcintosh/better-auth-saml-idp/blob/main/docs/guide/provisioning.md); its Workers example has an admin page for provisioning too.
