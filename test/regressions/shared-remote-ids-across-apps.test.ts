// A remote id is the app's own: targets at other apps may use the same one ("1", "5"). Whether an
// account or group is shared with another target at the same app, which a decommission leaves be,
// is decided from every link with that id, not the first twenty. Before, many targets at other
// apps with the same group id could hide the one at this app, and the decommission emptied or
// deleted a group that target still used. The preview's group count and the decommission use the
// same check (groupSharedWith).
import { expect, it } from "vitest";
import { type Adapter, outbox } from "../../src/outbox";
import { createHost } from "../support/host";
import { mockScim } from "../support/mock-scim";

it("an account or group shared at this app is found among many other apps' links with the same id", async () => {
	const h = await createHost({ decommission: true, targets: [] });
	const app = mockScim();
	const at = (id: string) => ({
		id,
		url: app.url,
		token: app.token,
		fetch: app.fetch,
		groups: true,
	});
	const adapter = h.ctx.adapter as unknown as Adapter;
	const box = outbox(
		{ decommission: true, targets: [at("app"), at("app2")] },
		adapter,
		{ warn() {}, error() {} },
	);
	const org = (await adapter.create({
		model: "organization",
		data: { name: "Acme", slug: "acme", createdAt: new Date() },
	})) as { id: string };
	const link = (targetId: string, userId: string) =>
		adapter.create({
			model: "scimProvisioningLink",
			data: {
				key: `${targetId}:${userId}`,
				targetId,
				userId,
				remoteId: "1",
				userName: `${userId}@example.com`,
				active: true,
				adopted: false,
				syncedAt: new Date(),
			},
		});
	const group = (targetId: string) =>
		adapter.create({
			model: "scimProvisioningGroupLink",
			data: {
				key: `${targetId}:group:5`,
				targetId,
				organizationId: org.id,
				remoteId: "5",
				displayName: "Acme",
				syncedAt: new Date(),
			},
		});
	await link("app", "u1");
	await group("app");
	// 25 targets at other apps, written first, whose account "1" is someone else's there and whose
	// group is "5" too; then app2, at this app, with the same person's account and the same group.
	for (let i = 0; i < 25; i++) {
		await link(`other-${i}`, `someone-${i}`);
		await group(`other-${i}`);
	}
	await link("app2", "u1");
	await group("app2");
	expect(await box.sharedCounts("app")).toEqual({ accounts: 1, groups: 1 });
});
