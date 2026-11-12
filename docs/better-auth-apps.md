# Better Auth apps, and ID-JAG

An app built on Better Auth can take users in with Better Auth's own [`@better-auth/scim`](https://www.better-auth.com/docs/plugins/scim). Give it a connection for your identity provider, and point a target at its endpoint:

```ts
// The app: inbound SCIM, one connection for your identity provider.
scim({ connections: [{ id: "our-idp", credentials: [{ type: "bearer", id: "idp-token", token: process.env.SCIM_TOKEN! }] }] });

// Your identity provider: a target for that app.
scimProvisioning({ targets: [{ id: "app", url: "https://app.example.com/api/auth/scim/v2", token: process.env.APP_SCIM_TOKEN! }] });
```

The tests run this pair for real: [`@better-auth/scim`](https://www.npmjs.com/package/@better-auth/scim) at the same versions as Better Auth, in CI. They show:

- Users are created there, updated, deactivated when banned or deleted here, and reactivated when unbanned; `deprovision: "delete"` deletes them there.
- Organizations arrive as SCIM Groups with their provisioned members (`groups`).
- **Deactivation signs the user out there.** `@better-auth/scim` deletes a user's sessions once none of their SCIM connections has them active.
- **But it doesn't stop them signing in again.** The user is still there, so any sign-in method the app offers (a password, a password reset, a magic link, a social account) gets them back in, as Better Auth's docs say. To refuse that, the app records the state in `@better-auth/scim`'s `reconcileUser` hook. With Better Auth's admin plugin, a ban does it: the tests show this refuses new sign-ins once we deactivate the user, lets them in again once we reactivate them, and never lifts a ban an admin set themselves.

```ts
// The app (with Better Auth's admin plugin): no new sign-ins while no SCIM connection has the user active.
const SCIM_BAN = "Deprovisioned by SCIM";
scim({
  connections: [/* … */],
  identity: {
    async reconcileUser({ userId, active }, { database }) {
      const where = [{ field: "id", value: userId }];
      const user = await database.findOne<{ banned?: boolean | null; banReason?: string | null }>({ model: "user", where });
      if (!active && !user?.banned) await database.update({ model: "user", where, update: { banned: true, banReason: SCIM_BAN } });
      if (active && user?.banned && user.banReason === SCIM_BAN) await database.update({ model: "user", where, update: { banned: false, banReason: null } });
    },
  },
});
```
- **Only users with a verified email are sent**, by default (`requireVerifiedEmail`), so a new sign-up appears there once they've verified it.
- **Their email is unverified there.** `@better-auth/scim` creates users with `emailVerified: false`. If the app requires verified emails to sign in with a password, provisioned users sign in another way (SSO, an ID-JAG) or verify there.
- **On Cloudflare, give that app Postgres through Hyperdrive, not D1.** `@better-auth/scim` needs database transactions, which D1 doesn't have. On D1, from Better Auth 1.7.21, the app starts but answers 501 to every SCIM request (before, it didn't start). This package retries those like any other error the app's host has to fix, with that reason in the error, and `check` reports it. This package, the identity provider side, runs on D1 as before.

**ID-JAG.** An app that accepts ID-JAGs (Identity Assertion JWT Authorization Grants, the grant behind Cross App Access and MCP's Enterprise-Managed Authorization) can find the user an ID-JAG names through this link: `acquireActiveSCIMUserLink({ connectionId, externalId: sub })` from `@better-auth/scim`. That works because an ID-JAG issued by a Better Auth identity provider carries the Better Auth user id as its `sub` (unless the provider gives clients pairwise subject identifiers), and that id is the `externalId` this package sends by default.

- **Keep the default `externalId`.** A `mapUser` that changes `externalId` breaks the link: the `sub` no longer finds anyone. The tests pin this.
- **Deprovisioning blocks it.** The link is found only while the user is active there, so a banned, deleted or deprovisioned user's ID-JAGs find no one, from the moment the deactivation is delivered (usually at once; after a retry if the app was down).
