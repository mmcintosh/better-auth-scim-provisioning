-- better-auth-scim-provisioning 1.0: group links say which group they are in their own columns,
-- and are found by organization through an index.
ALTER TABLE "scimProvisioningGroupLink" ADD COLUMN "kind" text;
ALTER TABLE "scimProvisioningGroupLink" ADD COLUMN "subjectId" text;
CREATE INDEX "scimProvisioningGroupLink_organizationId_idx" ON "scimProvisioningGroupLink" ("organizationId");
