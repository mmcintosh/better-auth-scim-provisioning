# Watching it

```ts
// Per target: jobs queued (due now), waiting (a backoff, a Retry-After, or a ban running out), stuck
// (an app error still retried past retry.maxAttempts, every 6 hours), failed (until the user changes
// again or a reconcile), and the accounts and groups the app confirmed.
const { targets } = await auth.api.scimProvisioningStatus({ body: {} });
// One user's account and pending job at each target.
const { user } = await auth.api.scimProvisioningStatus({ body: { userId } });
// One target, or a page of them ({ limit, after: next }; with a registry, 25 by default).
const { targets: [app] } = await auth.api.scimProvisioningStatus({ body: { targetId: "app" } });
// Which jobs failed or are stuck, with the app's last error; then { after: next } for more.
const { items, next } = await auth.api.scimProvisioningFailures({ body: { limit: 100 } });
// Drift: what's at the app that isn't as we'd have it, a page of the app's own list at a time
// ({ limit }, 100 by default; then { after: next } until it's null). Reported, never changed.
const { items: drift, scanned, next: more } = await auth.api.scimProvisioningDrift({ body: { targetId: "app", limit: 100 } });
```

`scimProvisioningDrift` reads the app's own list and reports each account that isn't as we'd have it, with a `finding` (at a target being decommissioned, or decommissioned, also `ours-active`: one of our accounts still active there, see [Retiring an app](retiring-an-app.md)): `unmanaged` (no link here and not our externalId: made by hand, or by another tool; at Google Workspace and Entra ID that's every account the plugin didn't make, the whole directory being listed), `unlinked` (our externalId for a user here, but no link: queue the user, and the next delivery takes the account over if its userName is still the user's address), or `mismatch` (deactivated or renamed at the app, or still active though the user was deleted here: a reconcile, or queueing the user, sends our state again). Each item carries the account's `remoteId`, `userName`, `externalId`, `active`, the `userId` here when known, and a `detail`. It changes nothing. A webhook receiver can't be listed; a disabled stored target still is (it's read only), and one whose credentials can't be read isn't. At an organization's target, only its members count as users here. The app must page as SCIM says, by `startIndex` (with `totalResults`, or full pages until a short one) or by a cursor.

In `scimProvisioningFailures` items and `onFailure`, `kind` is what was being delivered: `user`, or a group: `group` (an organization's own group), `team` or `role` (and, in failures only, `resync`: queueing an organization for its own target, page by page; `decommission`: a step of retiring a target). `subjectId` is the user's, organization's or team's id, and for a role group `"<organization id>:<role>"`.

`onFailure` is called when a delivery gives up (an error that won't fix itself) or reaches `retry.maxAttempts`: alert on it, so a deprovisioning that isn't getting through doesn't go unnoticed. It's also called with `kind: "credentials"` (`subjectId` being the target's id) when a target's credentials expire within 7 days, or have (`failed: true`): once a day per target, however many servers run the scheduled run (noted in the database), and again the same day if they then expire. From 30 days out, the scheduled run warns about them in the log, after its deliveries, and `scimProvisioningStatus` shows each target's `credentialsExpireAt` (or null): set it on the target (an ISO date, or date and time), or it's read from a bearer token that's a JWT (for an organization's target, when its credentials are stored, into its settings, so the check never decrypts them). Better there than on the first day nobody can be offboarded.

```ts
scimProvisioning({
  targets: [/* … */],
  onFailure: ({ targetId, kind, subjectId, error, status, attempts, failed }) => alert(`provisioning ${kind} ${subjectId} at ${targetId}: ${error}`),
});
```

When something changes memberships outside Better Auth's organization endpoints (an SSO sync, inbound SCIM, your own database writes), queue what changed, and it's delivered in the background:

```ts
// Someone added to, or removed from, an organization (or given another role, or another team):
await auth.api.scimProvisioningQueue({ body: { userId, organizationId } });
// Only the user (their account, and the groups they're in now): { userId }
// Only an organization's groups: { organizationId }; at one target: add targetId.
```

For a removal, pass the organization as well: the user isn't in its groups any more, so queueing only the user can't find the group they left.

## Audit history

`audit: true` keeps a record of who connected, changed, removed or decommissioned which target, and when, in its own table (`scimProvisioningAuditEvent`: run your migration after turning it on). It never holds a secret: a credentials change is recorded as `changed: ["credentials"]`. Changes are recorded, not reads (status, accounts, drift, check) or refused attempts, which are in the logs.

```ts
scimProvisioning({
  targets: [/* … */],
  // Or just `audit: true`: kept for good, and nothing forwarded.
  audit: { keepDays: 400, onEvent: (event) => siem.send(event) },
});
// Newest first: one target's (a removed one's too), one organization's, or all; then { after: next }.
const { items, next } = await auth.api.scimProvisioningAuditEvents({ body: { targetId: "app", limit: 100 } });
// [{ at, targetId, organizationId, actor, action, detail }, …]
```

`action` is `target.created`, `target.updated` or `target.deleted` (organizations' stored targets), `decommission.started`, `decommission.cancelled`, `decommission.completed`, `decommission.forgot`, `purge.started` or `purge.completed`; the list can grow in a minor release. `actor` is `user:<id>` for the registry's routes (with `detail.hostAdministrator` for a host administrator), `server` for `auth.api` calls from your code, and `system` for the plugin itself (a decommission completing). `detail` says what: the URL (as the API shows it) and `enabled` of a new target; which of `settings`, `credentials` and `enabled` changed; what a delete left at the app (`abandoned`); a decommission's counts. With the registry, an organization's administrators read their own organization's at `targets/events` (see [Organizations' own targets](registry.md)). `keepDays` has the scheduled run remove older events, hourly. `onEvent` gets each event as it's recorded, with a few seconds to take it; an error it throws is logged, never in the way. An event is written just after the change it records: if that write fails, it's logged as an error (the change's own `warn` line is still there), and the change stands.

**A long history.** The table has an index on each of `targetId` and `organizationId` with `key`, so one target's or organization's events are read a page at a time in order, however many there are. Migrate after upgrading to add them (MongoDB's adapter makes them on first use: the first event recorded after the upgrade waits while it indexes the events already there). If you added 1.7.0's two indexes by hand (`scimProvisioningAuditEvent_targetId_key` and `scimProvisioningAuditEvent_organizationId_key`, or MongoDB's `{ targetId: 1, key: -1 }` and `{ organizationId: 1, key: -1 }`), drop them once the migration has added these: they do the same job.
