# Webhooks

For anything that doesn't speak SCIM (your own apps, or automation platforms such as Zapier, Make and n8n), a webhook target POSTs every change as a JSON event, signed with HMAC-SHA256:

```ts
{ id: "my-app", type: "webhook", url: "https://my-app.example.com/hooks/provisioning", secret: process.env.PROVISIONING_WEBHOOK_SECRET! }
```

Each event holds the full current state, so applying one twice is harmless, and `occurredAt` lets a receiver ignore an older one:

| `type` | Body |
|---|---|
| `user.upsert` | `user`: the SCIM user (as `mapUser` makes it), with `externalId` |
| `user.deactivate` | `user: { externalId }` |
| `user.delete` | `user: { externalId }` (with `deprovision: "delete"`) |
| `group.upsert` | `group`: `displayName`, `externalId`, `members` (the users' `externalId`s); with `groups`, `teamGroups` or `roleGroups` |
| `group.delete` | `group: { externalId }` |

Every event also carries `id`, `schemaVersion` (1; a change a receiver could trip over is a new version, in a major release), `target` and `occurredAt`: when this attempt was sent (not when the change was made). A user's or group's events are sent one at a time, so a later `occurredAt` is a later state. Check the signature on the receiving side with the raw body:

```ts
import { verifyWebhookSignature, WebhookSignatureError } from "better-auth-scim-provisioning";

export async function POST(request: Request) {
  const body = await request.text();
  let event;
  try {
    event = await verifyWebhookSignature({ body, signature: request.headers.get("x-scim-provisioning-signature"), secret: process.env.PROVISIONING_WEBHOOK_SECRET! });
  } catch (e) {
    // 401, not a 500: the sender's error then says "check the target's secret".
    if (e instanceof WebhookSignatureError) return new Response(e.reason, { status: 401 });
    throw e;
  }
  // event.type, event.user / event.group …
  return new Response(null, { status: 204 });
}
```

It throws on a wrong signature, or one more than 5 minutes old, which stops a captured request being replayed later. A retry of the same change carries the same `id` (with a new signature and `occurredAt`), and within those 5 minutes a captured request could be replayed, so make applying an event idempotent: remember the event `id`s you've applied for a while, and drop an event whose `occurredAt` is older than the last one you applied for that user or group.

**Rotating the secret:** let the receiver accept both (`secret: [newSecret, oldSecret]`), switch the target to the new one and deploy, then drop the old one from the receiver.

A user's `externalId` is their id at the receiver. If a `mapUser` changes it for users already sent, the receiver sees new users, and the old ones are never deactivated: keep it stable.
- **Retried:** 5xx, 429, 408, timeouts, and 401/403 ("check the target's secret").
- **Fails the job:** any other 4xx.
- **A 404 is a wrong URL:** it's retried, and never read as "already gone".
