# Check an app first

`check` asks an app what its SCIM supports: its ServiceProviderConfig, whether it advertises the Enterprise User extension (through `/ResourceTypes` or `/Schemas`; many apps have neither, and then it can't tell), then a throwaway user taken through create, find, replace, both PATCH forms, deactivate and delete (removed at the end):

```sh
SCIM_TOKEN=… npx better-auth-scim-provisioning check --url https://example.com/scim/v2 --user-name check@your-domain.com
```

```
✓ ServiceProviderConfig: patch true, filter true, bulk false, etag false, sort false; auth: oauthbearertoken
✓ Enterprise User extension: listed by /ResourceTypes
✓ create a user: 201, id 4bb3b660-…
✓ keeps externalId
✓ find by userName
✓ find by userName, any case
✓ duplicate userName refused (409)
✓ update with PUT
✓ update with PATCH (no path)
✓ update with PATCH (path)
✓ deactivate (PATCH active false)
✓ delete
```

When the app's ServiceProviderConfig says, the first line also gives how it pages (RFC 9865: by cursor, by index, its largest page) and whether it may answer requests asynchronously (RFC 9967's `securityEvents.asyncRequest`). A create it answers with 202 is reported as such: the plugin handles it, but the other checks need the user at once.

Like the plugin, it sends the token only over https (http only to localhost).

For other auth methods, `--auth auth.json`, a file holding the `auth` object as in the table above (or `{ "auth": { … } }`):

```json
{ "type": "oauth2", "tokenUrl": "https://login.example.com/oauth2/token", "clientId": "…", "clientSecret": "…" }
```

 From code (an admin page's "test connection"), `checkScimTarget({ url, token | auth })` returns the same results. It creates and deletes a real test user at the app, so a page that runs it should be an admin-only POST, like any action that changes something.
