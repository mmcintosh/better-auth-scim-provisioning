// Better Auth checks the plugin's schema at runtime: a changed table breaks every request until the
// host migrates. So the schema is pinned here, and any change to it is deliberate and announced.
// 0.1.0 to 0.3.x: unchanged. 1.0: group links gain `kind` and `subjectId` (optional, so rows
// written before stay valid), instead of the kind being read from the key.
import { expect, it } from "vitest";
import { scimProvisioning } from "../../src";

const v1 = {
  scimProvisioningJob: ["key", "targetId", "userId", "version", "attempts", "nextAttemptAt", "lockedUntil", "failed", "lastError", "lastStatus", "kind", "createdAt", "updatedAt"],
  scimProvisioningLink: ["key", "targetId", "userId", "remoteId", "userName", "externalId", "active", "syncedAt"],
  scimProvisioningGroupLink: ["key", "targetId", "organizationId", "kind", "subjectId", "remoteId", "displayName", "syncedAt"],
};

it("the schema is 1.0's", () => {
  const schema = scimProvisioning({ targets: [] }).schema as Record<string, { fields: Record<string, { required?: boolean }> }>;
  expect(Object.fromEntries(Object.entries(schema).map(([model, s]) => [model, Object.keys(s.fields)]))).toEqual(v1);
  // The new columns are optional: rows from before 1.0 have neither.
  expect(schema.scimProvisioningGroupLink?.fields.kind?.required).toBe(false);
  expect(schema.scimProvisioningGroupLink?.fields.subjectId?.required).toBe(false);
});
