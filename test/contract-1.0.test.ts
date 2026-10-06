// The 1.0 contract: webhook events carry schemaVersion; receivers can rotate the secret by
// accepting several; signature failures are a typed error with a reason; ScimGroup and
// SCIM_GROUP_SCHEMA are exported like their user counterparts; check results have stable ids.
import { describe, expect, it } from "vitest";
import { checkScimTarget, SCIM_GROUP_SCHEMA, type ScimGroup, verifyWebhookSignature, WebhookSignatureError, webhookSignature } from "../src";
import { createHost } from "./support/host";
import { mockScim } from "./support/mock-scim";

const body = JSON.stringify({ id: "e1", schemaVersion: 1, type: "user.delete", target: "hook", occurredAt: new Date().toISOString(), user: { externalId: "u1" } });

describe("webhooks", () => {
  it("every event carries schemaVersion 1", async () => {
    const h = await createHost({ targets: [{ id: "hook", type: "webhook" }] });
    await h.user("Ada Lovelace");
    expect(h.webhook.events.length).toBeGreaterThan(0);
    expect(h.webhook.events.every((e) => e.schemaVersion === 1)).toBe(true);
  });

  it("a receiver can accept the old and new secret while rotating", async () => {
    const old = "old-secret-that-is-at-least-32-characters";
    const next = "new-secret-that-is-at-least-32-characters";
    for (const signedWith of [old, next]) {
      const event = await verifyWebhookSignature({ body, signature: await webhookSignature(signedWith, body), secret: [next, old] });
      expect(event.type).toBe("user.delete");
    }
  });

  it("signature failures are a WebhookSignatureError with a reason", async () => {
    const secret = "the-secret-that-is-at-least-32-characters";
    const fail = (signature: string | null) => verifyWebhookSignature({ body, signature, secret }).catch((e: unknown) => e);
    const wrong = await fail(await webhookSignature("another-secret-that-is-at-least-32-chars", body));
    expect(wrong).toBeInstanceOf(WebhookSignatureError);
    expect(wrong).toMatchObject({ reason: "mismatch" });
    expect(await fail(null)).toMatchObject({ reason: "malformed" });
    expect(await fail(await webhookSignature(secret, body, Math.floor(Date.now() / 1000) - 3600))).toMatchObject({ reason: "expired" });
  });
});

describe("exports", () => {
  it("ScimGroup and SCIM_GROUP_SCHEMA", () => {
    const group: ScimGroup = { schemas: [SCIM_GROUP_SCHEMA], displayName: "Acme", externalId: "org_1", members: [] };
    expect(group.schemas).toEqual(["urn:ietf:params:scim:schemas:core:2.0:Group"]);
  });

  it("check results have stable ids", async () => {
    const app = mockScim();
    const results = await checkScimTarget({ url: app.url, token: app.token, fetch: app.fetch });
    expect(results.map((r) => r.id)).toEqual(["service-provider-config", "create", "keeps-external-id", "find", "find-any-case", "duplicate-refused", "update-put", "update-patch", "update-patch-path", "deactivate", "delete"]);
  });
});
