# Microsoft Entra ID

Entra ID, Microsoft 365's directory, doesn't take SCIM from outside, so it's its own kind of target, through Microsoft Graph: users, for now (groups aren't supported yet). Verified live in a test tenant: create (on a managed and a federated domain), rename, email change, disable, enable, delete into the recycle bin and restore, the Enterprise User attributes with a manager, the `attributes` (title, phones, address) set and cleared, and drift detection a page at a time. Each user's `onPremisesImmutableId` is our user id, which is what Entra matches a federated sign-in's NameID against. So with [better-auth-saml-idp](https://www.npmjs.com/package/better-auth-saml-idp) as a domain's SAML identity provider (its NameID the user id, as it is by default), a user provisioned here can sign in to Microsoft 365 straight away, with no password at Microsoft. That was tested live, by hand: a user created through Graph the way this target creates them, without a password, signed in to My Apps through the identity provider on the first try.

```ts
{
  id: "entra",
  type: "entra-id",
  entra: {
    tenantId: "00000000-0000-0000-0000-000000000000", // Entra admin center → Overview → Tenant ID
    clientId: process.env.ENTRA_CLIENT_ID!,           // the app registration's Application (client) ID
    clientSecret: process.env.ENTRA_CLIENT_SECRET!,   // one of its client secrets
  },
}
```

Setting it up:
1. In the Entra admin center, App registrations → **New registration**: single tenant, no redirect URI.
2. API permissions → Add a permission → Microsoft Graph → **Application permissions** → `User.ReadWrite.All`, then **Grant admin consent**.
3. Certificates & secrets → **New client secret**, and copy its value (it's shown once). Note when it expires: after that, deliveries are retried until you give a new one.
4. Users' emails must be on domains verified in the tenant. For sign-in through your identity provider, federate the domain to it. A user on a domain that isn't federated gets a random password that nobody knows.

How it maps:
- the email (`userName`) becomes `userPrincipalName`, and its local part the `mailNickname`; the names map to `displayName`, `givenName` and `surname`;
- with `attributes`, the title is `jobTitle`, the phones `businessPhones` and `mobilePhone`, and the address `streetAddress`, `city`, `state`, `postalCode` and `country` (see [More attributes](users-and-attributes.md#more-attributes));
- our user id is `onPremisesImmutableId`. Entra won't change it on a federated user, so it's set only when an account is created or taken over;
- deprovisioning disables the account (`accountEnabled: false`) and revokes its sessions, so a signed-in user is out straight away rather than when their tokens expire;
- with `deprovision: "delete"`, the user goes to Entra's recycle bin for 30 days and is never purged by the plugin. A user back within that time is restored: the same account, with its id and immutableId (verified live). What Microsoft 365 keeps of their mailbox and files meanwhile depends on its own retention;
- the account is enabled again only if the plugin disabled it (the user is unbanned, or included again). An admin who disabled it, say during an incident, isn't overruled by a rename.

Adoption is off by default, as for Google Workspace: an account with the user's email made elsewhere could be someone's real mailbox, and taking it over gives it our immutableId, which changes how that person signs in. With `adopt: true`, it follows the same rules as SCIM, and a disabled account isn't taken over until an admin enables it. Know what that means on a federated domain: once taken over, the existing account, with its mailbox, files and any roles or licences, is signed in to by whoever holds that verified email in your Better Auth. Your email verification becomes the only guard on it. Turn it on only when your users' emails are verified the way you'd trust with those accounts, and check first that no admin accounts share addresses with your users.

Graph's replicas take seconds to agree after a write (found live), and the plugin works around it rather than failing:
- a user created seconds ago can answer 404 by id, though the lookup by immutableId usually finds them already: retried. Once, live, a delete seconds after the create met that 404 with the lookup finding nothing either, so a delete's 404 isn't taken as gone until the check a minute later (below) meets it again;
- a user deleted seconds ago can still read as live while changes to them 404: retried, then restored from the bin;
- a deleted user keeps their immutableId in the recycle bin, so creating them anew is refused. The plugin restores them instead (verified live). If someone else has their old userPrincipalName by then, the restore is refused and the job fails with Graph's reason;
- a write made seconds after another to the same user can be answered as done and never applied (found live: a disable straight after an enable). So a minute after the plugin disables or deletes a user, their job comes back and checks: a disable or delete Graph doesn't show is sent again, until it shows. Only that is checked. A dropped rename, address or attribute change is sent with the user's next change or a reconcile, and a dropped enable isn't forced later, since an admin may have disabled the account meanwhile: a user who stays disabled after being unbanned can be enabled in Entra, or unbanned again.

Microsoft's national clouds (US Government, China) need their own Graph and sign-in addresses: set `url` (say `https://graph.microsoft.us/v1.0`) and `entra.tokenUrl` (`https://login.microsoftonline.us/<tenantId>/oauth2/v2.0/token`); the token's scope follows `url`. Behind a proxy, set `url` to the proxy and `entra.scope` to `https://graph.microsoft.com/.default`. Only the commercial cloud was tested.
