// Signed webhooks, for targets with `type: "webhook"`: every change is POSTed to a URL as a JSON
// event holding the full current state (`user.upsert`, `user.deactivate`, `user.delete`,
// `group.upsert`, `group.delete`), signed with HMAC-SHA256, so anything that can receive an HTTPS
// request can be provisioned: your own apps, or automation platforms. Delivery is at least once,
// and applying an event twice is harmless; `occurredAt` lets a receiver drop an older state.
import { retryAfterMs, ScimError, type ScimGroup, type ScimUser, type scimClient } from "./scim-client";
import type { WebhookTarget } from "./types";

export const WEBHOOK_SIGNATURE_HEADER = "x-scim-provisioning-signature";
export const WEBHOOK_EVENT_HEADER = "x-scim-provisioning-event";

export type WebhookEvent =
  | { id: string; type: "user.upsert"; target: string; occurredAt: string; user: ScimUser & { externalId: string } }
  | { id: string; type: "user.deactivate" | "user.delete"; target: string; occurredAt: string; user: { externalId: string } }
  | { id: string; type: "group.upsert"; target: string; occurredAt: string; group: ScimGroup & { externalId: string } }
  | { id: string; type: "group.delete"; target: string; occurredAt: string; group: { externalId: string } };

/** Omit, applied to each member of a union (plain Omit merges them). */
type EventBody = WebhookEvent extends infer E ? (E extends unknown ? Omit<E, "id" | "target" | "occurredAt"> : never) : never;

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
 * (exactly as received) and the `x-scim-provisioning-signature` header. Throws if the signature
 * doesn't match or the timestamp is older than `toleranceSeconds` (default 5 minutes), which
 * stops a captured request from being replayed later.
 */
export async function verifyWebhookSignature(o: { body: string; signature: string | null | undefined; secret: string; toleranceSeconds?: number; now?: number }): Promise<WebhookEvent> {
  const parts = Object.fromEntries((o.signature ?? "").split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) throw new Error("webhook: missing or malformed signature");
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > (o.toleranceSeconds ?? 300)) throw new Error("webhook: signature too old (or from the future)");
  const expected = await hmac(o.secret, `${t}.${o.body}`);
  // Constant-time comparison, so the signature can't be guessed a byte at a time.
  let diff = expected.length ^ parts.v1.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (parts.v1.charCodeAt(i) || 0);
  if (diff !== 0) throw new Error("webhook: signature doesn't match");
  return JSON.parse(o.body) as WebhookEvent;
}

export function webhookClient(target: WebhookTarget): ReturnType<typeof scimClient> {
  const doFetch = target.fetch ?? fetch;
  const timeoutMs = target.timeoutMs ?? 10_000;

  async function send(event: EventBody): Promise<void> {
    const body = JSON.stringify({ id: crypto.randomUUID(), target: target.id, occurredAt: new Date().toISOString(), ...event });
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
