// A webhook receiver, as a fetch function: it checks every request's signature with the package's
// own verifyWebhookSignature, records the events, and keeps the state they describe. `fail` makes
// the next requests answer with a status instead.
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER, type WebhookEvent } from "../../src/webhook";

export function mockWebhook(secret = "webhook-secret-that-is-at-least-32-characters-long") {
  const events: WebhookEvent[] = [];
  const rejected: string[] = [];
  /** Every event id received, including requests answered with a fault. */
  const attempts: string[] = [];
  const users = new Map<string, { userName: string; active: boolean; displayName?: string | undefined; deleted?: boolean }>();
  const groups = new Map<string, { displayName: string; members: string[] }>();
  const faults: number[] = [];
  const url = "https://hooks.example.com/scim";

  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input) !== url) return new Response("not here", { status: 404 });
    attempts.push((JSON.parse(String(init?.body ?? "{}")) as { id?: string }).id ?? "");
    const fault = faults.shift();
    if (fault) return new Response("injected", { status: fault });
    const body = String(init?.body ?? "");
    let event: WebhookEvent;
    try {
      event = await verifyWebhookSignature({ body, signature: ((init?.headers ?? {}) as Record<string, string>)[WEBHOOK_SIGNATURE_HEADER], secret });
    } catch (e) {
      rejected.push((e as Error).message);
      return new Response("bad signature", { status: 401 });
    }
    events.push(event);
    if (event.type === "user.upsert") users.set(event.user.externalId, { userName: event.user.userName, active: event.user.active, displayName: event.user.displayName });
    if (event.type === "user.deactivate") users.set(event.user.externalId, { ...(users.get(event.user.externalId) ?? { userName: "?" }), active: false });
    if (event.type === "user.delete") users.set(event.user.externalId, { ...(users.get(event.user.externalId) ?? { userName: "?" }), active: false, deleted: true });
    if (event.type === "group.upsert") groups.set(event.group.externalId, { displayName: event.group.displayName, members: event.group.members.map((m) => m.value).sort() });
    if (event.type === "group.delete") groups.delete(event.group.externalId);
    return new Response(null, { status: 204 });
  };
  return { fetch, url, secret, events, rejected, attempts, users, groups, fail: (...statuses: number[]) => void faults.push(...statuses) };
}
