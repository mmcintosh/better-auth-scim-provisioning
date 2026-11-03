# Organizations' own targets

With `registry`, each organization can connect its own apps at runtime (its SCIM app, its Google Workspace domain, a webhook), the way better-auth-saml-idp's registry does for service providers. A stored target belongs to one organization and only ever receives that organization's members and groups. Targets in code work as before, alongside.

```ts
scimProvisioning({
  targets: [], // or your own, as before
  registry: {
    // Your own administrators manage every organization's targets (optional).
    canManage: ({ user }) => user.role === "admin",
    // And each organization's owners and admins manage their own (the default; [] turns it off).
    organizationRoles: ["owner", "admin"],
  },
}),
```

It needs Better Auth's organization plugin, and adds a table, `scimProvisioningTarget`: run your migration (`npx auth migrate`, or generate your ORM's schema) after turning it on, before deploying: Better Auth refuses requests while a table it expects is missing. Without `registry` the table doesn't exist and the endpoints answer 404 (401 to someone signed out).

With the organization plugin's defaults, every signed-up user can create any number of organizations, and so becomes an owner who can connect targets, whose deliveries share your scheduled run with everyone else's. If that's not what you want, limit who creates organizations (`allowUserToCreateOrganization`, `organizationLimit`), or set `organizationRoles: []` so only `canManage` decides.

```ts
// Connect an app to an organization (as one of its owners or admins). The id is generated.
const { target } = await authClient.$fetch("/scim-provisioning/targets/create", {
  method: "POST",
  body: {
    organizationId,
    settings: { name: "Slack", url: "https://api.slack.com/scim/v2", profile: "slack", groups: true },
    credentials: { token: "xoxp-…" },
    requestId: crypto.randomUUID(), // optional: makes the create safe to retry (see below)
  },
});
// The organization's members and groups are queued, a page at a time; later changes follow as for any target.

GET  /scim-provisioning/targets?organizationId=…&limit=…&offset=…  // list (a host administrator may omit organizationId)
POST /scim-provisioning/targets/update  { id, settings?, credentials?, enabled? }
POST /scim-provisioning/targets/check   { id }   // try the URL and credentials, changing nothing
POST /scim-provisioning/targets/status  { id }   // queued, waiting, stuck, failed; the latest failures' status
POST /scim-provisioning/targets/drift   { id, after?, limit? }   // what's at the app that isn't as we'd have it (see Watching it); read only
POST /scim-provisioning/targets/accounts { id, after?, limit? }  // the accounts made through it: userName, remoteId, active
POST /scim-provisioning/targets/decommission { id, phase?, preview?, confirm?, cancel?, forget? }  // see Retiring an app
POST /scim-provisioning/targets/delete  { id, abandon? }  // says what it leaves at the app: { abandoned: { accounts, groups } }
POST /scim-provisioning/targets/events  { organizationId?, id?, after?, limit? }  // the audit history (with `audit`): see Audit history
```

On the server they're `auth.api.scimProvisioningListTargets`, `…CreateTarget`, `…UpdateTarget`, `…CheckTarget`, `…TargetStatus`, `…TargetDrift`, `…TargetAccounts`, `…DecommissionTarget`, `…DeleteTarget` and `…TargetEvents`, with the user's headers.

- **Settings** are the target options that are data: `type`, `url`, `profile` (by name: `awsIamIdentityCenter`, `slack`, `atlassian`, `githubEnterprise`, `cloudflareAccess`), `update`, `compat`, `groups`, `teamGroups`, `roleGroups`, `adopt`, `deprovision`, `requireVerifiedEmail`, `enterprise`, `attributes`, `roles`, `timeoutMs` (at most 30 s), `credentialsExpireAt` (replacing the credentials clears it, unless the settings give it again), and for Google Workspace `google: { clientEmail, adminEmail, orgUnitPath?, groupDomain? }`; plus a `name` for people. Functions (`mapUser`, `include`, the group name functions) and `organizationId` can't be stored: the organization is always the owner.
- **Credentials** are one of `{ token }`, `{ auth: { type: "basic" | "header" | "oauth2", … } }` (as in [Targets](targets.md)), `{ secret }` for a webhook and `{ privateKey }` for Google Workspace. They're encrypted with Better Auth's secret, tied to the target, its organization and where it sends, and never shown: a target shows only their `kind`, and a webhook URL only its origin (Slack's and Azure's carry secrets in the path or query). They never go anywhere new either: changing a target's URL (or Google's `clientEmail` or `adminEmail`) needs the credentials given again, and a URL changed in the database rather than through the API doesn't get them (the target pauses). Two changes to one target at once can't mix: the second is refused (409) and is made again on what the first left. When you rotate Better Auth's secret (`secrets`), stored credentials are sealed again with the new one as they're used; keep the old secret until every target has been used once. If the secret changes without rotation, they can't be read: those targets pause (logged), and their deliveries are tried again every 15 minutes, so they go once the right secret is back or new credentials are given.
- **Who may**: a signed-in user, their session re-read from the database (a stateless deployment's signed cookie is its own record), as the database has them now (not banned, not impersonating): a host administrator (`canManage`) for every organization, or an owner or admin (`organizationRoles`) of the target's organization. Creating, changing and deleting also need a fresh session (signed in within Better Auth's `session.freshAge`, a day by default), as a password change does. Someone else's target is a 404. Changes are logged at `warn`, Better Auth's default level, with the acting user.
- **URLs** must be `https://` on the standard port and public, as your server calls them: no `localhost`, names without a dot, `.local`, `.internal`, `.lan`, `.home.arpa` and the like, and no private, loopback, link-local, shared, benchmarking, documentation or reserved address (IPv4 written as a number, or inside IPv6, included). Redirects are never followed. Each request is checked again by these rules as it's made (so a row allowed once, by an `allowHosts` entry since removed, say, reaches nothing inside), and the name is looked up (Node.js 22.3 and later, Bun, Deno) and refused if it resolves to a private address or doesn't resolve; on Workers, whose `fetch` can't reach private networks, the URL check is what applies. A name that changes what it resolves to between the check and the request can't be ruled out this way: if your server can reach internal services, route stored targets through an egress proxy with `registry.fetch` (which replaces the lookup). `allowHosts: ["scim.internal.example"]` makes exceptions, ports included. The check endpoint answers in broad terms ("the credentials were refused", "not found: check the URL"), never with the app's own words.
- **Changes** to a target's settings or credentials, or enabling it, queue its organization again (members, those with an account there, and its groups), and new credentials or enabling make what was waiting or failed go again, so a fixed token or a new setting applies to everyone. Renaming (`name`) changes nothing to send. The organization is queued as one job that the deliveries expand a page at a time (the first pages at once, in the background; the rest by the scheduled run), so creating a target for an organization of thousands stays a small request, on Workers too.
- **Sharing the queue**: a scheduled run gives no target more than half its batch while others' deliveries are due, so one slow or busy app doesn't hold everyone else's up.
- **Disabling** (`enabled: false`) pauses a target: changes are still queued for it, and wait, out of the scheduled run's way, until it's enabled again. **Deleting** removes the target, its queued jobs and its record of the accounts and groups it made; the accounts at the app stay as they are, and nothing tells the app any more. The answer says how many it left there (`abandoned`: accounts still active, and groups); decommission the target first for them to go (see [Retiring an app](retiring-an-app.md)). With `deleteRequiresDecommission: true`, a delete that would leave active accounts is refused (409) unless it says `abandon: true`, for an app that's gone; `targets/accounts` lists them, to keep a record first. Deleting the organization deprovisions its members through its targets as usual (a disabled target's wait); its targets then belong to no one's organization, so only a host administrator (`canManage`) can enable or remove them.
- **Safe to retry** with a `requestId` (8 to 128 letters, digits and `. _ : -`; one per target you mean to make, a UUID say): the target's id is derived from it and the organization, so a create sent again after a timeout, or twice at once, makes one target, and the repeat answers with it (`replayed: true`) without recording another audit event. It queues the organization again (one job, however many repeats), so a create cut short after the target was made still gets its members queued. A repeat that asks for something else (other settings, credentials or `enabled`), or comes after the target was changed, is refused (409), as is one Better Auth can no longer read the target's credentials for (its secret changed). So is one after the target was removed, while the audit history still has the removed target's events: without `audit`, or once `keepDays` has removed them, it makes a new target with the old id. Use a fresh `requestId` for each target you mean to make. A repeat is answered even when the organization is at its limit. Without a `requestId`, each create makes a new target, as before. It relies on the target id being unique, which the table's unique index enforces (on MongoDB too, where the adapter makes it on first use).
- **Every server sees a change at once**: targets are read from the database when they're used (by organization for a change, by id for a delivery), nothing is kept as a list. `maxTargetsPerOrganization` (default 10) limits each organization.
