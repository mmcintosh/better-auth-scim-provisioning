// Signed webhooks, for targets with `type: "webhook"`: every change is POSTed to a URL as a JSON
// event holding the full current state (`user.upsert`, `user.deactivate`, `user.delete`,
// `group.upsert`, `group.delete`), signed with HMAC-SHA256, so anything that can receive an HTTPS
// request can be provisioned: your own apps, or automation platforms. Delivery is at least once,
// and applying an event twice is harmless; `occurredAt` lets a receiver drop an older state.
import { retryAfterMs, ScimError, type ScimGroup, type ScimUser, type scimClient } from "./scim-client";
import type { WebhookTarget } from "./types";

export const WEBHOOK_SIGNATURE_HEADER = "x-scim-provisioning-signature";
export const WEBHOOK_EVENT_HEADER = "x-scim-provisioning-event";

/** The event format's version. A change a receiver could trip over is a new version, in a major release. */
export const WEBHOOK_SCHEMA_VERSION = 1;

/** What every event carries besides its own fields. */
interface EventEnvelope {
  /** The same on every attempt of one change; new for the next change. */
  id: string;
  schemaVersion: typeof WEBHOOK_SCHEMA_VERSION;
  type: string;
  /** The target's id. */
  target: string;
  /** When this attempt was sent (ISO 8601). */
  occurredAt: string;
}

export type WebhookEvent =
  | (EventEnvelope & { type: "user.upsert"; user: ScimUser & { externalId: string } })
  | (EventEnvelope & { type: "user.deactivate" | "user.delete"; user: { externalId: string } })
  | (EventEnvelope & { type: "group.upsert"; group: ScimGroup & { externalId: string } })
  | (EventEnvelope & { type: "group.delete"; group: { externalId: string } });

/** Omit, applied to each member of a union (plain Omit merges them). */
type EventBody = WebhookEvent extends infer E ? (E extends unknown ? Omit<E, "id" | "schemaVersion" | "target" | "occurredAt"> : never) : never;

/** Why a webhook's signature was refused: missing or malformed, too old (or from the future), or not matching. */
export class WebhookSignatureError extends Error {
  constructor(
    message: string,
    readonly reason: "malformed" | "expired" | "mismatch",
  ) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** The signature header for a body: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export async function webhookSignature(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${timestamp},v1=${await hmac(secret, `${timestamp}.${body}`)}`;
}

/**
 * For receivers: check a request's signature and age, and return its event. Pass the raw body
 * (exactly as received) and the `x-scim-provisioning-signature` header. Throws a
 * `WebhookSignatureError` (answer 401) if the signature is missing, doesn't match, or its
 * timestamp is older than `toleranceSeconds` (default 5 minutes), which stops a captured request
 * from being replayed later. To rotate the secret, pass both while the target switches over:
 * `secret: [newSecret, oldSecret]`.
 */
export async function verifyWebhookSignature(o: { body: string; signature: string | null | undefined; secret: string | readonly string[]; toleranceSeconds?: number; now?: number }): Promise<WebhookEvent> {
  const secrets = typeof o.secret === "string" ? [o.secret] : Array.isArray(o.secret) ? o.secret : [];
  // A configuration mistake (an unset environment variable), not a bad request: said plainly.
  if (!secrets.length || secrets.some((x) => typeof x !== "string" || !x)) throw new Error("verifyWebhookSignature: no secret given (check the receiver's environment)");
  const parts = Object.fromEntries((o.signature ?? "").split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) throw new WebhookSignatureError("webhook: missing or malformed signature", "malformed");
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > (o.toleranceSeconds ?? 300)) throw new WebhookSignatureError("webhook: signature too old (or from the future)", "expired");
  const given = parts.v1;
  for (const secret of secrets) {
    const expected = await hmac(secret, `${t}.${o.body}`);
    // Constant-time comparison, so the signature can't be guessed a byte at a time.
    let diff = expected.length ^ given.length;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
    if (diff === 0) return JSON.parse(o.body) as WebhookEvent;
  }
  throw new WebhookSignatureError("webhook: signature doesn't match", "mismatch");
}

/**
 * A webhook client. `change` names the change being delivered (its job and version): an
 * event's id is derived from it, so every attempt of one change carries the same id, and the next
 * change (even back to an earlier state) a new one.
 */
export function webhookClient(target: WebhookTarget, change?: string): ReturnType<typeof scimClient> {
  const doFetch = target.fetch ?? fetch;
  const timeoutMs = target.timeoutMs ?? 10_000;

  const eventId = async (event: EventBody) => {
    if (!change) return crypto.randomUUID();
    const subject = "user" in event ? event.user.externalId : event.group.externalId;
    const digest = hex(await crypto.subtle.digest("SHA-256", encoder.encode(`${target.id}|${change}|${event.type}|${subject}`)));
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  };

  async function send(event: EventBody): Promise<void> {
    const body = JSON.stringify({ id: await eventId(event), schemaVersion: WEBHOOK_SCHEMA_VERSION, target: target.id, occurredAt: new Date().toISOString(), ...event });
    let res: Response;
    try {
      res = await doFetch(target.url, {
        method: "POST",
        headers: { "content-type": "application/json", [WEBHOOK_EVENT_HEADER]: event.type, [WEBHOOK_SIGNATURE_HEADER]: await webhookSignature(target.secret, body) },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
      throw new ScimError(`POST ${event.type}: ${timedOut ? `no response within ${timeoutMs} ms` : (e as Error).message}`, null, true);
    }
    if (res.ok) return;
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const auth = res.status === 401 || res.status === 403;
    // A receiver's 404 is a wrong URL, never "already gone": the outbox must not take it as done.
    const misplaced = res.status === 404 || (res.status >= 300 && res.status < 400);
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500 || auth || misplaced;
    throw new ScimError(
      `POST ${event.type}: ${res.status}${auth ? " (check the target's secret)" : misplaced ? " (check the target's url)" : ""}${detail ? ` ${detail}` : ""}`,
      misplaced ? null : res.status,
      retryable,
      retryable ? retryAfterMs(res.headers.get("retry-after")) : undefined,
    );
  }

  /** The user's id at the receiver is our externalId (the user's id, by default). */
  const userId = (user: ScimUser) => {
    if (!user.externalId) throw new ScimError(`${target.id}: webhook targets need an externalId on every user (mapUser removed it)`, null, false);
    return user.externalId;
  };
  const upsert = async (user: ScimUser) => {
    const externalId = userId(user);
    await send({ type: "user.upsert", user: { ...user, externalId } });
    return externalId;
  };
  const upsertGroup = async (group: ScimGroup) => {
    const externalId = group.externalId as string;
    await send({ type: "group.upsert", group: { ...group, externalId } });
    return externalId;
  };

  return {
    // A receiver has no lookup to ask: every user is new to us until we've sent them.
    findByUserName: async () => null,
    create: upsert,
    replace: async (_id: string, user: ScimUser) => void (await upsert(user)),
    patch: async (_id: string, user: ScimUser) => void (await upsert(user)),
    setActive: async (id: string, active: boolean) => {
      if (!active) await send({ type: "user.deactivate", user: { externalId: id } });
    },
    remove: async (id: string) => send({ type: "user.delete", user: { externalId: id } }),
    findGroupByName: async () => null,
    groupMembers: async () => [],
    createGroup: upsertGroup,
    createGroupInBatches: upsertGroup,
    replaceGroup: async (_id: string, group: ScimGroup) => void (await upsertGroup(group)),
    patchGroup: async (_id: string, group: ScimGroup) => void (await upsertGroup(group)),
    removeGroup: async (id: string) => send({ type: "group.delete", group: { externalId: id } }),
  };
}
