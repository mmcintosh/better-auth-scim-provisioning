// A run gives no target more than half its batch while others' jobs are due, even when one target's
// backlog is larger than all a run looks at (four times its batch). Before, the run looked only at
// the oldest jobs: a large organization's resync then held every other target's jobs, a
// deactivation among them, until its backlog was nearly gone.
import { expect, it } from "vitest";
import { type Adapter, outbox, staticTargets } from "../../src/outbox";
import type { Target } from "../../src/types";
import { createHost } from "../support/host";
import { mockScim } from "../support/mock-scim";

it("a target whose backlog is more than a run looks at still leaves room for the others", async () => {
	const h = await createHost({ targets: [] });
	const busy = mockScim();
	const quiet = mockScim();
	const targets: Target[] = [
		{
			id: "busy",
			type: "scim",
			url: busy.url,
			token: busy.token,
			fetch: busy.fetch,
		},
		{
			id: "quiet",
			type: "scim",
			url: quiet.url,
			token: quiet.token,
			fetch: quiet.fetch,
		},
	];
	const box = outbox(
		{ targets },
		h.ctx.adapter as unknown as Adapter,
		{ warn: () => {}, error: () => {} },
		staticTargets(targets),
	);
	// 20 for one target, more than the 16 a run of 4 looks at, then 2 for another.
	for (let i = 0; i < 20; i++)
		await box.enqueue("busy", (await h.user(`Busy ${i}`)).id);
	for (let i = 0; i < 2; i++)
		await box.enqueue("quiet", (await h.user(`Quiet ${i}`)).id);
	await box.runDue(4);
	expect(quiet.users.size).toBe(2);
	expect(busy.users.size).toBe(2);
	// Alone, a target still fills the batch.
	await box.runDue(4);
	expect(busy.users.size).toBe(6);
});
