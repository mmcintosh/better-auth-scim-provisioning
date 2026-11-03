# Apps

Some apps differ from the SCIM standard. A **profile** sets a target up for one: it fills in what that app's documentation requires, and anything you set on the target yourself still wins.

```ts
import { awsIamIdentityCenter, scimProvisioning } from "better-auth-scim-provisioning";

scimProvisioning({
  targets: [awsIamIdentityCenter({ id: "aws", url: process.env.AWS_SCIM_URL!, token: process.env.AWS_SCIM_TOKEN!, groups: true })],
});
```

| App | Profile | Status | What it handles |
|---|---|---|---|
| Cloudflare Access | `cloudflareAccess` | verified live | Nothing differs. Turn on **seat deprovisioning** in the identity provider's SCIM settings, or deactivated users keep their seats. |
| AWS IAM Identity Center | `awsIamIdentityCenter` | verified live | Groups have no PUT and list no members, so they're updated by a diff of members, at most 100 per request, read through AWS's users filter page by page (cursor). Verified with users, organization, team and role groups, and a 105-member group. |
| Slack | `slack` | documented | userNames must be lowercase, at most 21 characters, with only `.` `_` `-`: taken from the email's local part (`slackUserName`). Deleting only deactivates. Since the userName isn't the email, Slack accounts made by hand are never adopted: give them our `externalId`, or remove them, first. |
| Atlassian | `atlassian` | documented | Groups can't be renamed, so a renamed group is created anew with its members, then the old one deleted (retried until it is). If a group with the new name exists and isn't ours, the job fails. |
| GitHub Enterprise Managed Users | `githubEnterprise` | documented | GitHub's DELETE permanently suspends an account, so this only deactivates, and refuses `deprovision: "delete"`. |
| Better Auth apps (`@better-auth/scim`) | | tested against the real package | Nothing differs. See [Better Auth apps](better-auth-apps.md), which also covers ID-JAG. |
| Google Workspace | `type: "google-workspace"` | verified live | Not SCIM: see [Google Workspace](google-workspace.md). |
| Microsoft Entra ID (Microsoft 365) | `type: "entra-id"` | verified live | Not SCIM: see [Microsoft Entra ID](entra-id.md). Users only, for now. |
| Anything else | `type: "webhook"` | | Signed webhooks to your own code or an automation platform: see [Webhooks](webhooks.md). |

"Verified live" means tested against the app itself. "Documented" means built from the app's documentation and tested against a model of it. Run [`check`](check.md) against it first, and tell us what you find.

- **Cloudflare Access.** Zero Trust → Integrations → Identity providers → your identity provider → turn on **Enable SCIM** and **Enable user deprovisioning**, **save**, then copy the SCIM endpoint and secret.
  - The secret only works once the provider is saved: if you copied it before saving, regenerate it, copy it, and save.
  - With SCIM, a user exists at Cloudflare before their first sign-in, and that sign-in lands on the same account.
  - Verified live: a ban revoked the user's Access session within 35 seconds, and a timed ban was lifted by the scheduled run within a minute of ending.
  - Cloudflare's Users list shows the name from the last sign-in, not the latest SCIM update.
- **AWS IAM Identity Center.** IAM Identity Center → Settings → Identity source → **Automatic provisioning**.
  - Its tokens last a year.
  - Your identity provider's SAML NameID must be the same value as the SCIM `userName` (the email, by default).
  - Users need a given name, a family name, a display name and a single primary email, which the default mapping always sends.
- **GitHub Enterprise Managed Users.**
  - The token is a classic personal access token of the setup user, with `scim:enterprise`.
  - Only one system may provision the enterprise.
  - GitHub asks for at most 1,000 users an hour, so the profile sends at most 30 requests a minute (`maxRequestsPerMinute`), about 900 users an hour when the scheduled run runs every minute.
- **Anything else that speaks SCIM 2.0**, with a bearer token, Basic auth, an API-key header or OAuth 2.0 client credentials (Salesforce, Zoom, your own apps).
  - If an app differs in a way a profile would cover, `compat` sets the same behaviours by hand: `groupUpdate: "patch"`, `groupMembers: "users-filter"`, `maxGroupMembersPerRequest`, `groupRename: "recreate"`.
