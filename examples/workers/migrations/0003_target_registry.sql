-- better-auth-scim-provisioning 1.1: the target registry (organizations' own apps), from `registry`.
create table "scimProvisioningTarget" ("id" text not null primary key, "targetId" text not null unique, "organizationId" text not null, "type" text not null, "config" text not null, "sealed" text not null, "enabled" integer not null, "createdAt" date not null, "updatedAt" date not null);

create index "scimProvisioningTarget_organizationId_idx" on "scimProvisioningTarget" ("organizationId");
