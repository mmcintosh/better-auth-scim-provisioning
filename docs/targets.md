# Targets

| Option | Default | |
|---|---|---|
| `id` | required | Stable id: letters, digits, `-`, `_`. Jobs, links and logs use it. |
| `type` | `"scim"` | `"google-workspace"` for Google Workspace's Directory API (see [Google Workspace](google-workspace.md)), `"entra-id"` for Microsoft Entra ID through Microsoft Graph (see [Microsoft Entra ID](entra-id.md)), or `"webhook"` for signed webhooks (see [Webhooks](webhooks.md)). |
| `url` | required (not for Google Workspace or Entra ID) | The app's SCIM base URL, without `/Users`. `https://` (`http://` only for localhost), with no query or credentials. |
| `token` | | Its bearer token. Or `auth`, for anything else: one of the two is required. |
| `auth` | | `{ type: "bearer", token }` (the same as `token`; give one or the other), `{ type: "basic", username, password }`, `{ type: "header", name, value }` (an API key), or `{ type: "oauth2", tokenUrl, clientId, clientSecret, scope?, clientAuth?, params? }` (client credentials; tokens cached and renewed before they expire). |
| `update` | `"put"` | SCIM targets: `"put"` replaces the whole user at the app; `"patch"` changes only the attributes we send, keeping what an admin set there. |
| `organizationId` | | Only members of this organization (Better Auth's organization plugin). |
| `include` | | `(user) => boolean`: who else to leave out. Only `true` includes; anything else deprovisions a provisioned user at their next delivery. |
| `requireVerifiedEmail` | `true` | Only users with a verified email. Set false if your sign-in leaves `emailVerified` false for addresses you trust. An account that already exists at the app is still only taken over for a verified email. |
| `adopt` | `true` (`false` for Google Workspace and Entra ID) | Take over an account made elsewhere when it's nobody's, active, and its userName is the user's verified email. It's then never deleted, only deactivated. |
| `mapUser` | see below | `(user) => ScimUser`: what's sent. |
| `enterprise` | | The Enterprise User extension, from user fields (see [Enterprise User attributes](users-and-attributes.md#enterprise-user-attributes)). |
| `attributes` | | More of the user's details from user fields: the title, phones, a work address, language, locale, time zone, user type, photo, nickname, profile URL, middle name and honorifics (see [More attributes](users-and-attributes.md#more-attributes)). |
| `groups` | `false` | Organizations as groups at the app: `true`, or `(organization) => boolean` to choose which (see [Groups](groups.md)). |
| `groupName` | the organization's name | `(organization) => string`: the group's name. |
| `teamGroups` | `false` | Teams as groups: `true`, or `(team, organization) => boolean`. |
| `teamGroupName` | "Org / Team" | `(team, organization) => string`. |
| `roleGroups` | `false` | Roles as groups: `true` (every role held) or a list, `["admin"]`. |
| `roleGroupName` | "Org / role" | `(role, organization) => string`. |
| `compat` | | SCIM targets: how the app differs from the standard, usually set by a profile (see [Apps](apps.md)). |
| `deprovision` | `"deactivate"` | `"deactivate"` (`active: false`, the account is kept) or `"delete"`. |
| `timeoutMs` | `10000` | Per request. |
| `maxRequestsPerMinute` | none (30 with the `githubEnterprise` profile) | At most this many requests a minute to the app, for apps with a rate limit (see [Rate limits](reliability.md)). |
| `credentialsExpireAt` | none (a bearer token that's a JWT: its own `exp`) | When the credentials expire, as an ISO date or a `Date`: shown in the status and warned about before it comes (see [Watching it](monitoring.md)). An AWS IAM Identity Center token lasts a year; a GitHub token or an Entra ID client secret, as long as you chose. |
| `roles` | `false` | The user's organization roles, as SCIM `roles` (see [Roles and entitlements](users-and-attributes.md#roles-and-entitlements)). |
| `entitlements` | none | A function of the user returning what they're entitled to, as SCIM `entitlements`. |
| `decommission` | `false` | Marked for decommissioning: frozen until it's started (see [Retiring an app](retiring-an-app.md)). Needs the plugin's `decommission: true`. |
| `fetch` | the global `fetch` | The fetch requests go through: a proxy's, or a Workers service binding's. |

Options are checked when the plugin starts: an unknown or misspelled option, or one in the wrong place, stops it with a message naming it. The scheduled run delivers 4 jobs at once by default: `concurrency: 4` (1 to 32), shared by all targets. Retries are shared too: `retry: { maxAttempts: 8, baseDelayMs: 30000 }`. The delay doubles each attempt, or is longer if the app's `Retry-After` asks for it (up to a day). After `maxAttempts`, failures that can fix themselves are retried every 6 hours. A rate limit isn't a failure: it never counts toward `maxAttempts` (see Rate limits under [How it holds up](reliability.md)).

A change to a target (`include`, `organizationId`, `deprovision`) applies to each user at their next change: run a reconcile to apply it to everyone, once the new version is fully deployed (on Workers, old and new run side by side for a few seconds). Do the same after an app's outage or a token fix, to deliver what's waiting now rather than at its next retry.
