# Decisions

## D-001: Outbound SCIM provisioning, as its own package (2026-09-30)

Better Auth's `@better-auth/scim` is inbound: directories push users into a Better Auth app. Nothing pushes users out to the apps they use, which an identity provider needs so accounts exist before the first sign-in and go away when someone leaves. This package does that, over SCIM 2.0 (RFC 7644).

It's separate from `better-auth-saml-idp` because provisioning doesn't depend on how users sign in (SAML, OIDC, or the app's own login), and people who only want sign-in shouldn't carry it.

**Design:**
- **Triggers:** Better Auth's database hooks for users (create, update, delete; a ban is an update). They run after the transaction commits. Organization memberships change through the organization plugin's own adapter calls, which those hooks don't see, so an after-hook on its membership writes queues the user it returns.
- **Outbox:** one job per (target, user) meaning "make the app match this user". It carries no user data: delivery reads the user as they are then, so quick changes collapse into one request with the latest state. One link per (target, user) keeps the app's id for them.
- **Delivery:** in the background (`runInBackground`, `waitUntil` on Workers) right after queueing, and by `scimProvisioningRun` from a scheduled job for retries.
- **Concurrency:** a job is claimed with a lease (a conditional update). A change during delivery bumps its version, so the finished delivery keeps the job and delivers again at once.
- **Failures:** 429 (with Retry-After), 5xx, timeouts, network errors, and 401/403 are retried with exponential backoff; other 4xx fail the job until the user changes again, or until a reconcile.
- **Adoption:** a user who already exists at the app (409) is found by userName and taken over, but only if that account is nobody's or ours (see S1-1).
- **Deprovisioning:** `active: false` by default, or delete.

## D-002: Review S1, a fresh look at the MVP (2026-09-30)

Read as if written by someone else, looking for what breaks in real use. Each finding was fixed with a test that failed first (`test/review/`).

- **S1-1 (High): adoption could hand one person's app account to another.** A deleted user's account stays at the app, deactivated; someone signing up with their old email got a 409, and the adopt path took over and reactivated that account, with its permissions and history at the app.
  - Fix: adopt only an account with no `externalId`, or with the one we send.
- **S1-2 (Medium): reading membership provisioned.** The membership hook treated any result holding a member row as a change, including reads such as `getActiveMember` that apps call on page loads: one SCIM request per page view.
  - Fix: only the organization plugin's membership writes (and the path-less server-side `addMember`).
- **S1-3 (Medium): the lease was shorter than the slowest delivery.** A delivery can make four requests, each up to the target's timeout (max 120 s), against a flat 60-second lease.
  - Fix: the lease is four timeouts plus 30 seconds, per target.
- **S1-4 (Medium): a token problem failed jobs for good.** 401 and 403 counted as "won't fix itself", so while a token was expired, every changed user's job failed until that user changed again.
  - Fix: retried, with a message pointing at the target's token.
- **S1-5 (Medium): reconcile couldn't clean up deleted users.** It walked existing users only, so a deleted user whose deprovisioning was lost stayed active at the app.
  - Fix: reconcile also queues every user linked at the target.
- **S1-6 (Low): a verified email was always required.** Users whose sign-in leaves `emailVerified` false were never provisioned.
  - Fix: `requireVerifiedEmail: false` per target.
- **Checked and fine:**
  - after-hooks run after the transaction commits (`queueAfterTransactionHook`), so delivery never reads an uncommitted user;
  - two concurrent bumps can't lose a change (the version check);
  - a failure to queue never fails the user's own write.
- **Open, decided after live tests:** updates use PUT, which replaces the whole user at the app, including attributes an admin set there. PATCH is gentler, but which apps accept which PATCH form needs checking against AWS IAM Identity Center and Cloudflare Access first.

## D-003: Verified live against Cloudflare Access (2026-09-30)

`test/live/lifecycle.test.ts` runs the plugin, unchanged, against a real SCIM service (`SCIM_URL`, `SCIM_TOKEN` in the git-ignored `.env.live`; `npx vitest run -c vitest.live.config.ts`; never in CI), reads the user back from the service after each step, and removes it there at the end.

Against Cloudflare Zero Trust (a generic SAML identity provider with **Enable SCIM** on), every step passed:
- **created:** userName = email, active, given/family names split, displayName and externalId stored as sent;
- **renamed:** name and displayName updated;
- **email changed:** the same account's userName changed;
- **banned:** `active: false`; **unbanned:** `active: true`;
- **deleted:** `active: false`, account kept;
- **a deleted user's email reused:** refused (S1-1); the old account stayed the old user's and inactive, and the job failed with "belongs to another user".

Cloudflare's ServiceProviderConfig: PATCH, filter (max 100) and sort supported; no bulk, no ETags. Nothing was left at the service.

Notes:
- Cloudflare's SCIM secret only takes effect once the identity provider is **saved**; the secret shown before the first save was rejected (401). Regenerate, copy, save.
- Better Auth's `Database schema mismatch` log in the tests is the test hosts' order (Better Auth checks its tables when it starts, before the test migrates), not the plugin.
- PUT and PATCH both work on Cloudflare; the PUT-or-PATCH question stays open until an app that behaves differently (AWS IAM Identity Center) can be checked.

## D-004: The outbox on Postgres, MySQL and MongoDB (2026-09-30)

`test/adapters/outbox.adapters.test.ts` runs the outbox on real databases, a fresh one per test (CI's `adapters` job; locally with `ADAPTER_DB` and `ADAPTER_URL`). Its leases, version checks, date comparisons and booleans are what differ between databases. The first run found two bugs that SQLite and Postgres don't show:
- **MySQL: nothing was provisioned.** The "not held" lease value was the Unix epoch, and MySQL's TIMESTAMP columns start one second after it, so every queue attempt failed with `Incorrect datetime value`.
  - Fix: 2000-01-01, valid in every database; any past date works.
- **MongoDB: a change during delivery waited for the scheduled run.** Better Auth's MongoDB adapter hadn't built the UNIQUE index on the job key, so a second change created a duplicate job instead of bumping the one being delivered. That delivery finished its own job and never saw the duplicate.
  - Fix: the outbox no longer depends on the UNIQUE key. `enqueue` bumps an existing job before creating one. After a delivery, any other free job for the same user and target (a bump or a duplicate) is delivered at once, so a duplicate costs at most one extra delivery of the latest state. Only new work goes round again: a job that just failed unchanged waits for its backoff.

Result: the six adapter tests (a user's life, the lease, a change during delivery, retry timing and failed jobs, S1-1, S1-5) pass on Postgres 17, MySQL 8.4 and MongoDB 8.2, twice each.

## D-005: Review S2, fresh eyes before 0.1.0 (2026-09-30)

A review by a new agent with no history in the project, looking for what's wrong rather than what's there. Each finding it proved was reproduced by a test outside the repo; each fix has a test in `test/review/s2-*` that failed first, and the database-sensitive paths are in the adapter matrix too.

- **S2-1 (High): a change could be lost.** The hook read the job, the delivery that just finished deleted it, and the bump then updated nothing. D-002's "two concurrent bumps can't lose a change" held for bumps, not for a bump racing the delete.
  - Fix: a bump that changes no row looks again and creates the job.
- **S2-2 (Medium): a create whose reply was lost couldn't be undone.** The link was saved only after the app answered, so a user who then left (banned, deleted, removed) had no link, and their account stayed active at the app, even through reconcile.
  - Fix: a pending link (no remoteId yet) is written before the create. A leaving user with a pending link is looked up by userName: deprovisioned if the account is ours (our externalId), forgotten if there's none. If the app doesn't keep externalId, the job fails with a message rather than guess.
- **S2-3 (Medium, security): adoption trusted the app to keep externalId.** Many apps drop it, so every account looked like nobody's, and a new user with a deleted user's email was handed the old account, reactivated.
  - Fix: an account already linked to another user at the target, by our own links, is never adopted. (`remoteId` is indexed for this.)
- **S2-4 (Medium): outages longer than about an hour dropped changes.** 5xx, timeouts and 401/403 counted toward `maxAttempts` (8), then the job failed for good, deprovisioning included.
  - Fix: only an error that won't fix itself fails a job. Past `maxAttempts`, retries continue every 6 hours, and the log turns to an error once.
- **S2-5 (Medium, security): `requireVerifiedEmail: false` let anyone claim an account.** Sign up as someone else's address, unverified, and the matching hand-made account at the app was adopted.
  - Fix: an existing account that isn't ours is adopted only for a verified email.
- **S2-6 (Medium): large organizations and user bases.**
  - Deleting an organization queued and delivered every member inside the admin's request, all at once. Now it's in the background, one user at a time; what doesn't finish stays queued.
  - Reconcile did everything in one call, and "every linked user" stopped at 10,000. Now links are walked in pages (userId order), and reconcile takes `limit` and `after` and returns `next`, so on Workers it can run a page per invocation. An unknown `targetId` is refused. `targetId` is indexed.
- **S2-7 (Low): a timed ban never lifted at the app.** Better Auth clears an expired ban only at the next sign-in. Now the job is kept until `banExpires`, and delivered then.
- **S2-8 (Low): delete mode skipped users who were only deactivated,** e.g. after switching a target from `deactivate` to `delete`. Now they're deleted too.
- **S2-9 (Low): backoff.** Every change reset a job's backoff, so a busy user kept hitting an app that answered 429. Now a job the app rate-limited keeps its wait (reconcile still starts over). `Retry-After` is capped at a day: a huge value made an invalid date and wedged the job.
- **S2-10 (Low): a database error in the organization-delete hook failed the admin's request** after the organization was gone. The work is now in the background (S2-6), where errors are logged.
- **S2-11 (Low): duplicate jobs (MongoDB) could be delivered at once.** A claimed job now removes free duplicates, and of held ones only the first claimed goes ahead.
- **S2-12 (Low): memberships made outside the organization plugin's endpoints aren't seen,** e.g. the creator of a new organization, SSO or inbound SCIM provisioning, or the host's own adapter writes. Documented; reconcile covers them.
- **S2-13 (Low): the target URL check.** `http://localhost:80@evil.example/…` passed (userinfo), query strings passed and broke every path, and fetch followed redirects, replaying the token and body.
  - Fix: parsed with `URL`; https, or http to a loopback address; no credentials, query or fragment. Redirects are never followed: a 3xx fails with the location, to put the final URL in the target.
- **S2-14 (Low): the release checked CHANGELOG.md after staging on npm,** so a missing section would stage a version and then fail. Now checked before anything is built. Leftovers from better-auth-saml-idp in comments and the lint config are gone.
- **Checked and fine:** server-only endpoints have no HTTP route; hooks run after commit and keep the host's own hooks; the membership matcher; the SCIM filter and path encoding; tokens never logged; the release pipeline's pinning, permissions and provenance.

## D-006: Reaching more apps: auth methods, PATCH, and `check` (2026-10-02)

The goal is every app a Better Auth identity provider might provision into. The outbox (queue, retries, links, adoption rules, reconcile) is shared, so reaching more apps means thin layers on it, not a package per app.

- **Auth methods.** Bearer (`token`) stays the common case. `auth` adds Basic, a header of the app's own (API keys), and OAuth 2.0 client credentials (Salesforce, Zoom server-to-server through `params`, Microsoft Graph).
  - OAuth tokens are cached per isolate, keyed by endpoint, client, scope and params, and renewed a minute before expiry (halfway, for short ones). Concurrent requests share one token request, and a failed one isn't cached.
  - A 401 drops the cached token and retries once.
  - Token endpoint errors carry the status and the `error` code only, never the body, which could echo a secret. Like S1-4, they're retried: a misconfigured client is the host's problem, not the user's.
- **`update: "patch"`.** One path-less `replace` with our attributes, so attributes set at the app survive. PUT stays the default: it's the most widely supported, and the open question from D-002 is now the app's to answer, through `check`. Cloudflare Access accepts both, verified live, and the live lifecycle passes in either mode.
- **`check`.** A doctor for one app: its ServiceProviderConfig, then a throwaway user through create, externalId kept, find (exact and any case), duplicate 409, PUT, PATCH without and with a path, deactivate, delete and gone. The token comes from `SCIM_TOKEN` or an `--auth` file, never the command line. `checkScimTarget()` is exported for admin pages.
  - Against Cloudflare Access: everything passes. Its ServiceProviderConfig advertises only HTTP Basic, yet it takes bearer tokens.
- **Found by the Workers field test:** reconcile's `in` lookup of a page of linked users broke D1's 100-parameter limit. Batches of 50 now, with a test that fails on any longer list.
- **Next:** groups (most apps grant access by group), app profiles once each app is checked, and connectors for apps without SCIM (Google Workspace's Directory API; a signed webhook as the general escape hatch).

## D-007: The field test: a real app on Workers, live against Cloudflare Access (2026-10-02)

The package ran in a real Better Auth app for the first time: the better-auth-saml-idp Workers example with D1, `waitUntil` and a Cron Trigger, deployed to Cloudflare. It provisioned into Cloudflare Access, through a SAML identity provider that is that same app.

- **What held up, live:**
  - **Pre-provisioning:** a user created in the app existed at Cloudflare before she ever signed in, and her first SAML sign-in landed on that same account.
  - **Rename:** reached Cloudflare at once.
  - **Ban:** deactivated at once. Cloudflare revoked her live session within 35 seconds, and a browser refresh was sent back to sign in.
  - **Unban:** active again.
  - **Timed ban:** lifted by the Cron Trigger 46 seconds after it ran out.
  - **Delete:** deactivated.
  - **An organization-scoped target:** add provisions; remove, or delete the organization, deprovisions.
  - **A wrong token:** 401s with "check the target's token", jobs kept for retry, nothing sent. After the fix and one reconcile, all delivered.
- **Found and fixed:**
  - **Reconcile broke D1's 100-parameter limit** (an `in` query over a page of linked users). Now in batches of 50.
  - **A wrong target URL made deprovisioning look done.** A URL that 404s for everything (in the test, a Worker calling its own workers.dev address) had every "deactivate" answer 404, read as "already gone at the app". The user was marked deactivated here and stayed active there, beyond the reach of reconcile.
    - A 404 for one user now counts as gone only when the app's list agrees. A 404 on `/Users` itself, or a 200 that isn't a SCIM list, is a retryable "check the target's url".
    - An update that 404s follows the account if the app lists it under another id.
- **Learned about Cloudflare Access:**
  - Its Users list shows the name from the last sign-in, not the SCIM record.
  - A deactivated user keeps their seat unless the identity provider's SCIM "seat deprovisioning" is on.
  - A config change rolls out over a few seconds, so for a moment old and new versions both run: run a reconcile after changing a target.
- **An outage, recovered by the Cron Trigger alone:** the target URL was pointed somewhere unreachable while a ban was queued. Each retry said `404 (check the target's url)`, the link stayed active, and nothing was marked done. Once the URL was restored, the next scheduled retry delivered the ban, with no reconcile. (A Worker can't reach another Worker of the same account by URL; both "down" stand-ins answered 404, so this ran as the wrong-URL case. The 503 path is covered by the unit tests.)
- **Scale on D1:**
  - 208 users reconciled in 3 calls of up to 100 (about 6 s each), then delivered by `scimProvisioningRun` and the Cron Trigger together;
  - about 45 users per 50-job run, 36 s per run, so about 0.7 s per user, sequentially;
  - "busy" counts showed the cron and a manual run contending, with no double delivery;
  - no Workers limit errors.
- **Then:** `concurrency` (default 4) delivers several jobs at once. The same 200 users went from about 36 s per 50-job run to 7 to 9 s, about 0.17 s a user, with no lease contention.

## D-008: Groups: organizations as SCIM groups (2026-10-02)

Most apps grant access by group (AWS permission sets, Atlassian products, Slack user groups, Cloudflare Access policies), so pushing users alone isn't enough.

- **Model:** an organization (Better Auth's organization plugin) is a group at each target with `groups: true` (all organizations, or only `organizationId`). Its members are the organization's members who are provisioned and active at that target. `groupName` overrides the name, which is the organization's by default. Teams and roles as groups can come later through the same path.
- **Same outbox:** group jobs share the queue (`kind: "group"`, key `<target>:group:<organization>`), with leases, retries and backoff as for users. Group links are their own table (`scimProvisioningGroupLink`).
- **Rebuilt, not patched:** each delivery recomputes the members from the database and replaces the group. Changes can arrive in any order, and every delivery converges, so there are no add/remove operations to get wrong.
- **When groups are queued:**
  - a membership write or an organization's create, update or delete (from the organization plugin's endpoints);
  - every user delivery, for that user's organizations;
  - reconcile, for every organization and every linked group whose organization is gone.

  Only queued after a user delivery, so reconciling a whole organization updates its group a few times, not once per member. A single change made in the app is delivered at once.
- **Taking over is never silent:**
  - An existing group with the same name is updated only if it carries this organization's `externalId`, or it has none and our own pending create may have made it: a create whose reply was lost, as for users (S2-2).
  - Anything else fails the job with a message: replacing someone's hand-made group would rewrite its members.
  - The 404 rule from D-007 applies: a 404 is believed only when the app's list agrees.
- **Tests:**
  - the mock app gained strict `/Groups` (unique names, known members only);
  - eight tests cover joins and leaves, deprovisioning, rename and delete, `groupName`, `organizationId`, refusing a stranger's group, a lost create reply, a reconcile of a 13-member organization, and a wrong URL;
  - the takeover and lost-reply tests were checked by breaking the code on purpose;
  - an adapter test runs on PostgreSQL, MySQL and MongoDB.
- **Live against Cloudflare Access:**
  - an organization's group appeared with our `externalId`;
  - added members appeared; a removed or banned member left, and an unbanned one came back;
  - a member banned earlier was correctly absent;
  - deleting the organization removed the group.
- **Limits:** a group is sent whole, so one request carries every member's id. Very large organizations at apps with request size limits may need PATCH batches; not seen yet.
