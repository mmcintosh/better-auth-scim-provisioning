-- better-auth-scim-provisioning 1.8: the target id's uniqueness as a table-level index too, which
-- a create with a requestId relies on (and MongoDB's adapter makes). An index only: nothing else changes.
CREATE UNIQUE INDEX "scimProvisioningTarget_targetId_unique_idx" ON "scimProvisioningTarget" ("targetId");
