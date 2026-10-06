// Found in review: a webhook event got a new id on every attempt, so a receiver deduplicating by
// id (as the README advises) never recognised a retry. An event's id is now the same on every
// attempt of one change, and new for the next change, including a change back to an earlier state.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("a retried event keeps its id; the next change gets a new one", async () => {
  const h = await createHost({ targets: [{ id: "hook", type: "webhook" }], retry: { baseDelayMs: 0 } });
  h.webhook.fail(503);
  const user = await h.user("Ada Lovelace");
  await h.auth.api.scimProvisioningRun({ body: {} });
  await h.settle();
  const [first, retried] = h.webhook.attempts;
  expect(h.webhook.attempts).toHaveLength(2);
  expect(retried).toBe(first);
  expect(first).toMatch(/^[0-9a-f-]{32,}$/);

  await h.ctx.internalAdapter.updateUser(user.id, { name: "Ada King" });
  await h.settle();
  await h.ctx.internalAdapter.updateUser(user.id, { name: "Ada Lovelace" }); // back to the first state
  await h.settle();
  const ids = h.webhook.attempts.slice(1);
  expect(new Set(ids).size).toBe(ids.length);
});
