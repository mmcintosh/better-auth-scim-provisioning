// Found in review: at Google, creating a user whose address is a Google Group's answers 409. No
// user holds it, so the account was taken to be "not visible yet" and retried for ever. Now the
// address is looked up as a group (at targets with groups, whose token may read groups), and the
// job fails, saying why.
import { expect, it } from "vitest";
import { createHost } from "../support/host";

it("a user whose address belongs to a Google Group fails, saying so, instead of retrying for ever", async () => {
  // A target with groups: the plugin only asks Google for the group scope then, which the lookup needs.
  const h = await createHost({ targets: [{ id: "workspace", type: "google-workspace", groups: true }], googleGroupScope: true });
  h.google.groups.set("grp-sales", { id: "grp-sales", email: "user1@example.com", name: "Sales", members: new Set() });
  await h.user("Ada Lovelace"); // user1@example.com
  const [job] = (await h.jobs()) as { failed: boolean; lastError: string }[];
  expect(job).toMatchObject({ failed: true, lastError: expect.stringContaining("Google Group") });
});
