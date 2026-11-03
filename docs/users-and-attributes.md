# Who is provisioned, and what's sent

A user is at a target when their email is verified (unless `requireVerifiedEmail: false`), they aren't banned (the admin plugin), they're a member of `organizationId` if one is set, and `include` returns true (if set). Otherwise they're deprovisioned there, if they had been provisioned. A timed ban is lifted at the app when it runs out.

Membership changes are seen through the organization plugin's endpoints (add, remove, update role, accept an invitation, leave, delete the organization) and server-side `addMember`. Changes made any other way (the creator of a new organization, SSO or inbound SCIM provisioning, your own database writes) are applied at the user's next change or the next reconcile. **That includes removals:** someone removed from an `organizationId` organization by those means keeps their account at the app until then, so call `scimProvisioningQueue` for them (see [Watching it](monitoring.md)), or run a reconcile.

By default the app gets:
- **`userName`** and the one primary **`emails`** value: the user's email;
- **`name`**: `givenName` and `familyName` split from Better Auth's `name`. The last word is the family name; a one-word name fills both, since apps such as AWS IAM Identity Center require both;
- **`displayName`**: the name;
- **`externalId`**: the Better Auth user id;
- **`active`**.

Override it per target with `mapUser`, for example to take `userName` from an employee id. `defaultScimUser(user)` is exported to build on.

## More attributes

With `attributes`, a target also gets the user's job title, phone numbers and work address, read from fields of your users (`user.additionalFields`), as SCIM's `title`, `phoneNumbers` and `addresses`:

```ts
scimProvisioning({
  targets: [
    { id: "aws", url, token, attributes: true }, // fields named as the attributes
    { id: "slack", url, token, attributes: { title: "jobTitle", phone: "workPhone", locality: "city" } }, // your own field names
  ],
});
```

- **`true`** reads `title`, `phone` (the work number), `mobile`, and the address's `streetAddress`, `locality`, `region`, `postalCode` and `country`, for those fields your users have. **`preferredLanguage`, `locale`, `timezone`, `userType`, `photo`, `nickName`, `profileUrl`, `middleName`, `honorificPrefix` and `honorificSuffix` are read only when named** (`{ timezone: "timezone", photo: "image" }`), so upgrading never starts sending, or clearing, a field you didn't ask for. **A map** names your fields, and only those attributes are sent; a field it names that your users don't have stops the plugin at startup. A number is written out as text.
- **What's sent:** `title`; `phoneNumbers` with the work number (type `work`) and the mobile (type `mobile`), the first of them primary; one `addresses` entry of type `work` with the parts that have a value; `preferredLanguage`, `locale`, `timezone`, `userType`, `nickName` and `profileUrl` as they are; the middle name and honorifics in `name`, beside the given and family names; and the photo as one `photos` entry of type `photo`, primary. All as RFC 7643 names them. Better Auth's own `image` is the photo: `{ photo: "image" }`.
- **Checked before they're sent:** `preferredLanguage` and `locale` must be language tags (`en`, `en-CA`), `timezone` a name in the runtime's time zone data (`America/Toronto`, `UTC`), and `photo` and `profileUrl` https URLs written out in full (`https://`, no spaces or backslashes; an image served over http, or a `data:` URL, isn't sent). Anything else (`English`, `Eastern Time`) is left out and logged at `warn` (once an hour per target and attribute), rather than sent for the app to refuse: a PATCH leaves the app's value as it is; a PUT, which replaces the whole account, leaves the attribute out.
- **An empty field clears the attribute at the app**: a PUT leaves it out, and a PATCH (`update: "patch"`) removes it by path (`title`, `photos`, `name.middleName`, and so on; `phoneNumbers` and `addresses` as a whole): once the target names a phone or an address part, the phone list and the address list at the app are the plugin's, and once it names `photo`, so is the photo list (one photo replaces, or clearing removes, any the app had, thumbnails included).
- **Entra ID** keeps these as `jobTitle`, `businessPhones` (the work number), `mobilePhone`, `streetAddress`, `city`, `state`, `postalCode`, `country` and `preferredLanguage`. Not `locale` or `timezone`, which Graph's user doesn't have, and never `userType`: Graph's means member or guest.
- **Google Workspace** keeps the title in the user's primary organization (its other fields, such as a department set by an admin or by `enterprise`, kept), the phones in `phones` (the work and mobile entries are the plugin's; an admin's other numbers stay) and the address in `addresses` (the work entry's named parts; its other parts and other addresses stay). Only the attributes the target reads are touched. Google allows one primary phone and one primary address: when the plugin sends one, an admin's entry loses its primary flag.
- **Google Workspace** gets none of `preferredLanguage`, `locale`, `timezone` and `userType` (yet).
- **The photo, `nickName`, `profileUrl`, the middle name and honorifics** go to SCIM apps and webhooks only. Google Workspace and Entra ID take a photo as an uploaded image through APIs of their own, not a URL, and their users have no such name parts.
- **Webhooks** get the same object as SCIM.
- A `mapUser` that sets one of these itself takes precedence for that attribute, at Google Workspace and Entra ID too: a phone list it sends replaces the phones of the types it holds (Entra keeps only the work and mobile numbers), and only a work address has a place at Entra.
- The apps' own limits apply: Graph refuses a title over 128 characters, say, with a 400 that fails that user's job (with Graph's message) until their next change or a reconcile.
- **Organizations' own targets** may read only the fields you allow: by default the fields named like the eight attributes `true` reads (`title`, `phone` and so on); to let them name the others, add the user fields those read to `registry.attributeFields` (`image` for the photo, say: the list is of your user fields, not attribute names); `registry.attributeFields` sets the list (`[]` turns it off). `true` reads the fields your users have, so a narrowed list that covers those is enough. Never list a field you wouldn't show their administrators.

## Roles and entitlements

```ts
scimProvisioning({
  targets: [
    { id: "app", url, token, roles: true, entitlements: (user) => (user.plan === "pro" ? ["pro"] : []) },
  ],
});
```

- **`roles: true`** sends the user's organization roles as SCIM `roles`. At an organization's target, their roles there, as `{ value: "admin", type: "organization" }`; at any other, their roles in every organization they're in, each with the organization's slug as `type` (`{ value: "admin", type: "acme" }`). They follow membership changes made through the organization plugin; a renamed slug shows at the user's next delivery, or a reconcile. A user's first 1,000 organizations are read (each delivery reads them in one query, as for groups); a user in more is logged at `warn`, and the rest's roles aren't sent. Organizations' own targets can set it too.
- **`entitlements`** is a function of the user that returns what they're entitled to (a licence, a plan), sent as SCIM `entitlements` (`{ value }`, duplicates and blanks dropped). It's called at each delivery of the user, so when what it reads changes outside the user (a billing system), queue them (`scimProvisioningQueue`). In code only: a function can't be stored.
- None (no roles, `[]`) clears them at the app, as for the attributes above. A `mapUser` that sets `roles` or `entitlements` itself takes precedence.
- SCIM apps and webhooks only: Google Workspace and Entra ID have no place for them (Entra's app roles are assignments, not attributes).

## Enterprise User attributes

With `enterprise`, a target also gets the SCIM Enterprise User extension ([RFC 7643 §4.3](https://www.rfc-editor.org/rfc/rfc7643#section-4.3)): employee number, cost center, organization, division, department and manager. They're read from fields of your users, so add them as Better Auth `user.additionalFields`:

```ts
betterAuth({
  user: {
    additionalFields: {
      employeeNumber: { type: "string", required: false },
      department: { type: "string", required: false },
      managerId: { type: "string", required: false, index: true }, // the manager's user id; indexed, since a manager's reports are looked up by it
    },
  },
  plugins: [
    scimProvisioning({
      targets: [
        { id: "aws", url, token, enterprise: true }, // fields named as the attributes, the manager from managerId
        { id: "slack", url, token, enterprise: { employeeNumber: "employeeId", department: "dept", manager: "reportsTo" } }, // your own field names
      ],
    }),
  ],
});
```

- **`true`** reads `employeeNumber`, `costCenter`, `organization`, `division` and `department`, and the manager's user id from `managerId`, for those fields your users have: an attribute without a field is neither sent nor cleared. **A map** names your fields, and only those attributes are sent; a field it names that your users don't have stops the plugin at startup. A number is written out as text.
- **An empty field clears the attribute at the app**: a PUT leaves it out, and a PATCH (`update: "patch"`) removes it by path. An app that refuses to remove an attribute it doesn't have (400) gets the change again without the removes, then each remove on its own. A user with no values at all isn't sent the extension.
- **The manager** is sent as their id at that app (SCIM's `manager.value`), and only once they're provisioned and active there. Whenever that changes (their account appears, goes, is made again under a new id, or at Google gets a new address), the users reporting to them are queued again, at an organization's target only its members, so their manager follows at the next scheduled run. That's a job of its own, retried if it fails. A user named as their own manager has none. Index the manager field: each such change looks up the reports by it.
- **Entra ID** keeps these in its own fields: the employee number as `employeeId` (Entra allows at most 16 characters), the department as `department`, the organization as `companyName`, the cost center and division in `employeeOrgData` (keeping the other one when only one is read), and the manager as the user's `manager`.
- **Google Workspace** keeps these differently: the organization, department, cost center and division (as `description`) go in the user's primary organization, keeping its other fields such as an admin's job title. The employee number becomes the `organization` external id, and the manager the `manager` relation, by their address; other relations are kept. Only the attributes the target reads are touched: with a map of a few, what an admin set for the others stays.
- **Webhooks** get the same object as SCIM, with the manager's id at the receiver: their `externalId` as the target sends it (the user id, unless `mapUser` changes it).
- A `mapUser` that sets the extension itself is sent as it is.
- **Organizations' own targets** may read only the fields you allow, since their administrators choose the fields and the values go to their app: by default the attribute names and `managerId`; `registry.enterpriseFields` sets the list (`[]` turns it off). Never list a field you wouldn't show them.
- **Verified live at AWS IAM Identity Center** (every attribute, the manager as AWS's id for them, and clearing), and tested against Better Auth's own `@better-auth/scim` with PUT and PATCH. Slack documents the extension too. Send it only to apps that accept it.
