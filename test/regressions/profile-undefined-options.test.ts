// A host passing its own unset options (`compat: { groupUpdate: undefined }`) erased a profile's
// values: AWS then got PUT, which it doesn't have. Only options set to something win.
import { expect, it } from "vitest";
import { profiles } from "../../src";

it("an undefined option never removes a profile's value", () => {
  const t = { id: "aws", url: "https://scim.example.com", token: "t", compat: { groupUpdate: undefined, groupRename: undefined } };
  expect(profiles.awsIamIdentityCenter(t).compat).toMatchObject({ groupUpdate: "patch", groupMembers: "users-filter", maxGroupMembersPerRequest: 100 });
  expect(profiles.atlassian(t).compat).toMatchObject({ groupUpdate: "patch", groupRename: "recreate" });
});
