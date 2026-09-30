# better-auth-scim-provisioning

**In development. This version is a placeholder with no code; don't install it yet.**

SCIM provisioning for [Better Auth](https://www.better-auth.com): create, update and deactivate users in the apps they sign in to (AWS IAM Identity Center, Cloudflare Access, Salesforce and others that accept SCIM 2.0), so accounts exist before the first sign-in and are removed when someone leaves.

It's the outbound counterpart of Better Auth's own `@better-auth/scim`, which receives provisioning, and a companion to [better-auth-saml-idp](https://www.npmjs.com/package/better-auth-saml-idp).
