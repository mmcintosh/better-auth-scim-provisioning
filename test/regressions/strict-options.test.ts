// Found in review: unknown, misspelled and misplaced options were dropped without a word. A target
// with `organisationId` (British spelling) provisioned every verified user instead of one
// organization's members. Every options object is strict now, and options that mean nothing for
// a target's type are refused.
import { describe, expect, it } from "vitest";
import { scimProvisioning } from "../../src";

const scim = { id: "app", url: "https://app.example.com/scim/v2", token: "t" };
const webhook = { id: "hook", type: "webhook", url: "https://hooks.example.com/scim", secret: "webhook-secret-that-is-at-least-32-characters" };
const google = { id: "gw", type: "google-workspace", google: { clientEmail: "sa@p.iam.gserviceaccount.com", privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----", adminEmail: "admin@example.com" } };
const make = (options: unknown) => () => scimProvisioning(options as never);

describe("options are checked strictly", () => {
  it("a misspelled target option is refused, with the right spelling suggested", () => {
    expect(make({ targets: [{ ...scim, organisationId: "org_1" }] })).toThrow(/targets\.0\.organisationId.*organizationId/);
    expect(make({ targets: [{ ...scim, deprovison: "delete" }] })).toThrow(/deprovison.*deprovision/);
  });

  it("a target option given at the top level is refused, and said to belong on each target", () => {
    expect(make({ targets: [scim], groups: true })).toThrow(/groups.*each target/);
  });

  it("a misspelled top-level option is refused", () => {
    expect(make({ targets: [scim], concurency: 2 })).toThrow(/concurency.*concurrency/);
  });

  it("unknown keys inside nested options are refused", () => {
    expect(make({ targets: [{ ...scim, compat: { groupUpdates: "patch" } }] })).toThrow(/compat\.groupUpdates/);
    expect(make({ targets: [{ ...google, google: { ...google.google, orgUnit: "/Staff" } }] })).toThrow(/google\.orgUnit.*orgUnitPath/);
    expect(make({ targets: [{ id: "app", url: scim.url, auth: { type: "bearer", token: "t", tokn: "x" } }] })).toThrow(/auth\.tokn/);
    expect(make({ targets: [scim], retry: { maxAttempts: 3, baseDelay: 10 } })).toThrow(/retry\.baseDelay.*baseDelayMs/);
  });

  it("options that mean nothing for a target's type are refused", () => {
    expect(make({ targets: [{ ...webhook, compat: { groupUpdate: "patch" } }] })).toThrow(/compat.*scim/);
    expect(make({ targets: [{ ...webhook, update: "patch" }] })).toThrow(/update.*scim/);
    expect(make({ targets: [{ ...google, update: "patch" }] })).toThrow(/update.*scim/);
  });

  it("valid options still pass", () => {
    expect(make({ targets: [{ ...scim, organizationId: "org_1", deprovision: "delete", compat: { groupUpdate: "patch" }, update: "patch", groups: true }, webhook, google], concurrency: 2, retry: { maxAttempts: 3, baseDelayMs: 10 } })).not.toThrow();
  });
});
