// Better Auth checks the plugin's schema at runtime: a new column breaks every request until the
// host migrates. An upgrade from 0.1.0 must need no migration, so the schema stays exactly 0.1.0's.
import { expect, it } from "vitest";
import { scimProvisioning } from "../../src";

const v010 = {
  scimProvisioningJob: ["key", "targetId", "userId", "version", "attempts", "nextAttemptAt", "lockedUntil", "failed", "lastError", "lastStatus", "kind", "createdAt", "updatedAt"],
  scimProvisioningLink: ["key", "targetId", "userId", "remoteId", "userName", "externalId", "active", "syncedAt"],
  scimProvisioningGroupLink: ["key", "targetId", "organizationId", "remoteId", "displayName", "syncedAt"],
};

it("the schema is 0.1.0's: upgrading needs no migration", () => {
  const schema = scimProvisioning({ targets: [] }).schema as Record<string, { fields: Record<string, unknown> }>;
  expect(Object.fromEntries(Object.entries(schema).map(([model, s]) => [model, Object.keys(s.fields)]))).toEqual(v010);
});
