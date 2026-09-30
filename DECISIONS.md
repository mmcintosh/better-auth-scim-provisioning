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
