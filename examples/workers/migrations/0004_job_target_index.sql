-- better-auth-scim-provisioning 1.4: jobs are found by target through an index (a target's runs,
-- its status counts and removing a target scanned every job). An index only: nothing else changes.
CREATE INDEX "scimProvisioningJob_targetId_idx" ON "scimProvisioningJob" ("targetId");
