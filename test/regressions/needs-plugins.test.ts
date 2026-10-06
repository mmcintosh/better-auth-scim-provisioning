// Found in review: options that need Better Auth's organization plugin (organizationId, groups,
// teamGroups, roleGroups), or its teams (teamGroups), were accepted without it: every reconcile then
// threw "Model team not found", or every user's job failed. They now stop the plugin at startup.
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { expect, it } from "vitest";
import { scimProvisioning } from "../../src";

const make = (target: Record<string, unknown>, plugins: unknown[]) =>
  betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-that-is-at-least-32-characters-long",
    telemetry: { enabled: false },
    database: new DatabaseSync(":memory:"),
    plugins: [...(plugins as never[]), scimProvisioning({ targets: [{ id: "app", url: "https://app.example.com/scim/v2", token: "t", ...target }] as never })],
  }).$context;

it("organizationId, groups and roleGroups need the organization plugin", async () => {
  for (const option of [{ organizationId: "org_1" }, { groups: true }, { roleGroups: ["admin"] }]) {
    await expect(make(option, [])).rejects.toThrow(/organization plugin/);
  }
  await expect(make({ groups: true }, [organization()])).resolves.toBeTruthy();
});

it("teamGroups needs the organization plugin's teams", async () => {
  await expect(make({ teamGroups: true }, [organization()])).rejects.toThrow(/teams/);
  await expect(make({ teamGroups: true }, [organization({ teams: { enabled: true } })])).resolves.toBeTruthy();
});
