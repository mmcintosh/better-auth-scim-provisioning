# Google Workspace

Google doesn't accept SCIM, so Workspace is its own kind of target, through the Directory API: users, and with `groups`, `teamGroups` or `roleGroups`, Google Groups. Verified live against a real Workspace: users (create, rename, email change, suspend, unsuspend, deprovision, and the refusals below) and groups (an organization, a team and a role, through a rename, a member leaving, and removal).

```ts
{
  id: "google",
  type: "google-workspace",
  google: {
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL!, // the service account (client_email)
    privateKey: process.env.GOOGLE_PRIVATE_KEY!,   // its key (private_key), PEM
    adminEmail: "provisioning-admin@your-domain.com", // the Workspace admin it acts as
    orgUnitPath: "/Provisioned",                   // optional: where new users go (existing users are never moved)
  },
  groups: true,                                    // optional: organizations as Google Groups (also teamGroups, roleGroups)
}
```

Setting it up:
1. In Google Cloud, create or choose a project (a plain one; no billing needed) and enable the **Admin SDK API**.
2. Create a **service account** (IAM & Admin → Service Accounts). It needs no role in the project: skip that step. Then add a JSON key (Keys → Add key → JSON). `client_email` and `private_key` go in the options.
3. In the Workspace Admin console, as a super admin, go to Security → Access and data control → API controls → **Domain-wide delegation** → Add new. The client ID is the service account's **Unique ID** (its Details tab), with the scope `https://www.googleapis.com/auth/admin.directory.user`, and for groups also `https://www.googleapis.com/auth/admin.directory.group` (comma-separated). It can take a few minutes to apply. A target with groups asks for both, and Google refuses its token if delegation allows only one, so set them together.
4. Choose an **admin** for it to act as, with permission to manage users.
5. Optionally, create an **organizational unit** for the users it creates (Directory → Organizational units) and set `orgUnitPath`: there you decide which Workspace services they get.

How it maps:
- the email (`userName`) becomes `primaryEmail`, which must be in one of the Workspace's domains;
- the names map to `name`, and Google requires both;
- with `attributes`, the title goes in the user's primary organization, the phones in `phones` and the work address in `addresses` (see [More attributes](users-and-attributes.md#more-attributes));
- deprovisioning suspends the user, or deletes them with `deprovision: "delete"`;
- our user id is a custom entry in `externalIds`, and any other external ids an admin set are kept;
- Google requires a password when a user is created, so a random one is set. Users sign in through your identity provider (with [better-auth-saml-idp](https://www.npmjs.com/package/better-auth-saml-idp) as Workspace's SAML identity provider), so it's never used.

Groups (`groups`, `teamGroups`, `roleGroups`, as for SCIM apps):
- each group is a Google Group at an address made from its externalId, such as `ba-team-<team id>@your-domain.com`, so renaming an organization renames the group without moving it. Set `google.groupDomain` for another domain, or `google.groupEmail: (externalId) => string` to name them yourself, and keep it stable: the address is how the group is found again;
- the address is the externalId in lower case, with each run of characters other than letters and digits made one `-` (or, past 60 characters, a hash of it). Two role groups in one organization can come out the same that way: `billing_admin` and `billing-admin`, `Admin` and `admin`, or two names written only in other scripts, such as `管理者` and `編集者`. The first keeps that address; the second gets one made from a hash of its externalId, `ba-<32 hex digits>@your-domain.com`, and is found there from then on. With your own `google.groupEmail`, keeping its addresses apart is up to you: the second of two groups it gives one address isn't made, and its job says so;
- the description marks it ours. A group already at that address without our marker is someone else's, and is never taken over;
- members are the provisioned users, added and removed one request each; members that aren't users (a nested group an admin added) are left alone.

Adoption follows the same rules as SCIM, and an account that merely has the user's email as an *alias* is never taken over. Nor is a suspended account made by hand: taking it over would unsuspend it, so the job fails until an admin unsuspends it (or gives it our id). Right after a create, Google sometimes says an account exists before it can show it; that's retried.

Google takes a while to settle, and the plugin waits it out rather than failing:
- for a few seconds after a create, the new user answers 404 by id, and 412 "User creation is not complete" to a delete;
- for a minute or more after an email change, further changes to that user (a ban, say) are answered with 409;
- reads of a new user can trail its changes by a minute or more, so the Admin console may briefly show older details;
- a group made seconds ago can answer 404 to its first members, and say "already exists" while a read of it still finds nothing.

Google sometimes suspends new accounts itself (`suspensionReason` `WEB_LOGIN_REQUIRED`, for example after many accounts are created in a short time), until the user signs in once or an admin lifts it in the Admin console. The API can't lift that, so the plugin leaves it as Google has it and still applies every other change. The plugin lifts only a suspension it made itself, when the user is back (unbanned, or included again); an admin's own suspension, say during an incident, is left alone by every other change.
