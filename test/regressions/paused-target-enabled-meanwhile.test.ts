// A delivery that read its target as paused parks the job only if nothing queued it meanwhile:
// enabling the target (resume, then its organization queued) between that read and the parking
// left the job parked until 2999 with the target enabled.
import { describe, expect, it } from "vitest";
import { type Adapter, markPaused, outbox, PAUSED_UNTIL, type TargetSource } from "../../src/outbox";
import type { Target } from "../../src/types";
import { createHost } from "../support/host";
import { mockScim } from "../support/mock-scim";

describe("a target enabled while a delivery parks its job", () => {
  it.each([
    ["resumed and queued again", true],
    ["resumed only (the organization's resync not expanded yet)", false],
  ])("%s: the job stays due, and is delivered", async (_, requeue) => {
    const remote = mockScim();
    const h = await createHost({ targets: [] });
    const ada = await h.user("Ada Lovelace");
    const adapter = h.ctx.adapter as unknown as Adapter;
    const enabled: Target = { id: "t1", type: "scim", url: remote.url, token: remote.token, fetch: remote.fetch };
    let isEnabled = false;
    let calls = 0;
    // eslint-disable-next-line prefer-const
    let box: ReturnType<typeof outbox>;
    const source: TargetSource = {
      scoped: false,
      async get() {
        calls++;
        const seen = isEnabled ? enabled : markPaused({ ...enabled });
        if (calls === 2) {
          // The worker has claimed the job and read the row (disabled). Now an admin enables the
          // target: the row is updated, then resync makes its jobs due and queues the members.
          isEnabled = true;
          await box.resume("t1");
          if (requeue) await box.enqueue("t1", ada.id, { now: true });
        }
        return seen;
      },
      forOrganizations: async () => [isEnabled ? enabled : markPaused({ ...enabled })],
      every: async () => [isEnabled ? enabled : markPaused({ ...enabled })],
    };
    box = outbox({ targets: [] }, adapter, { warn: () => {}, error: () => {} }, source);
    await box.enqueue("t1", ada.id);
    await box.runFor("t1", ada.id);
    const [job] = (await adapter.findMany({ model: "scimProvisioningJob" })) as { nextAttemptAt: Date }[];
    // Enabled now, but the job waits for the year 2999 and the scheduled run never sees it.
    const tally = await box.runDue();
    expect(remote.users.size, `job nextAttemptAt=${new Date(job!.nextAttemptAt).toISOString()} tally=${JSON.stringify(tally)}`).toBe(1);
    expect(new Date(job!.nextAttemptAt).getTime()).not.toBe(PAUSED_UNTIL.getTime());
  });
});
