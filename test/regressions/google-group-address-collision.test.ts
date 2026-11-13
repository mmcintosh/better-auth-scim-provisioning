// A Google Group's default address is its externalId in lower case, with each run of other
// characters than letters and digits made one "-". Two roles in one organization can come out the
// same ("billing_admin" and "billing-admin"). Before, the second role got no group: its job failed
// with a 409 that said to rename a group, which doesn't change an address. Now the second gets a
// spare address, made from a hash of its externalId, and is found there again, even once the first
// role's group is gone. The first keeps its address, as every group made before does. A host's
// own groupEmail is the host's to keep apart: a clash there is still refused, with a message that
// says what to do at Google.
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createHost } from "../support/host";

type Host = Awaited<ReturnType<typeof createHost>>;
const G = { id: "workspace", type: "google-workspace" as const };
const ROLES = ["billing_admin", "billing-admin"];

async function setUp(h: Host) {
	const s = await h.auth.api.signUpEmail({
		body: {
			email: "owner@example.com",
			password: "correct-horse-battery",
			name: "Olive Owner",
		},
	});
	await h.ctx.internalAdapter.updateUser(s.user.id, { emailVerified: true });
	await h.settle();
	const res = await h.auth.api.signInEmail({
		body: { email: "owner@example.com", password: "correct-horse-battery" },
		asResponse: true,
	});
	const headers = {
		cookie: res.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; "),
	};
	const org = (await h.auth.api.createOrganization({
		body: { name: "Acme", slug: "acme" },
		headers,
	}))!;
	const join = async (name: string, role: string) => {
		const u = await h.user(name);
		await h.auth.api.addMember({
			body: { userId: u.id, organizationId: org.id, role: role as never },
		});
		await h.settle();
		return [...h.google.users.values()].find((g) => g.primaryEmail === u.email)!
			.id;
	};
	return { org, join };
}
const groupAt = (h: Host, email: string) =>
	[...h.google.groups.values()].find((g) => g.email === email);
const spare = (externalId: string) =>
	`ba-${createHash("sha256").update(externalId).digest("hex").slice(0, 32)}@example.com`;

it("two roles whose addresses come out the same both get a group: the second at its spare address", async () => {
	const h = await createHost({ targets: [{ ...G, roleGroups: ROLES }] });
	const { org, join } = await setUp(h);
	const ada = await join("Ada Lovelace", "billing_admin");
	const bob = await join("Bob Babbage", "billing-admin");
	expect(await h.jobs()).toEqual([]);
	const first = groupAt(
		h,
		`ba-role-${org.id.toLowerCase()}-billing-admin@example.com`,
	)!;
	const second = groupAt(h, spare(`role:${org.id}:billing-admin`))!;
	expect(first).toMatchObject({
		name: "Acme / billing_admin",
		description: expect.stringContaining(`role:${org.id}:billing_admin`),
	});
	expect([...first.members]).toEqual([ada]);
	expect(second).toMatchObject({
		name: "Acme / billing-admin",
		description: expect.stringContaining(`role:${org.id}:billing-admin`),
	});
	expect([...second.members]).toEqual([bob]);

	// Found again at the spare address: a later change updates it, and makes no other group.
	const cy = await join("Cy Clarke", "billing-admin");
	expect(await h.jobs()).toEqual([]);
	expect([...second.members].sort()).toEqual([bob, cy].sort());
	expect(h.google.groups.size).toBe(2);

	// Once the first role's group is gone, its address is free. The second is still found at its
	// spare address, not made again at the free one; the first is made again at its own.
	h.google.groups.delete(first.id);
	h.db
		.prepare('DELETE FROM "scimProvisioningGroupLink" WHERE "remoteId" = ?')
		.run(first.id);
	const di = await join("Di Dunn", "billing-admin");
	expect(await h.jobs()).toEqual([]);
	expect([...second.members].sort()).toEqual([bob, cy, di].sort());
	expect(h.google.groups.size).toBe(2);
	expect([...groupAt(h, first.email)!.members]).toEqual([ada]);
});

it("with the host's own groupEmail, a clash is still refused, and the error says what to do at Google", async () => {
	const h = await createHost({
		targets: [
			{
				...G,
				roleGroups: ROLES,
				google: { groupEmail: () => "billing@example.com" },
			},
		],
	});
	const { join } = await setUp(h);
	const ada = await join("Ada Lovelace", "billing_admin");
	await join("Bob Babbage", "billing-admin");
	expect(h.google.groups.size).toBe(1);
	expect([...groupAt(h, "billing@example.com")!.members]).toEqual([ada]);
	expect(await h.jobs()).toEqual([
		expect.objectContaining({
			kind: "role",
			failed: true,
			lastError: expect.stringMatching(
				/a Google Group already has this role's address and isn't this role's; give that group another address in Google, or set google\.groupEmail$/,
			),
		}),
	]);
});
