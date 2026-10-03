#!/usr/bin/env node
// npx better-auth-scim-provisioning check --url <SCIM base URL> [--user-name <email>] [--auth <file.json>]
// Asks an app what its SCIM supports (see doctor.ts). The bearer token comes from the SCIM_TOKEN
// environment variable, or `--auth` names a JSON file with an `auth` object (basic, header,
// oauth2): never a secret on the command line, where it would land in shell history.
import { readFileSync } from "node:fs";
import { checkScimTarget, parseAuthFile } from "./doctor";

const usage = `Usage: SCIM_TOKEN=… npx better-auth-scim-provisioning check --url <SCIM base URL> [--user-name <email>]
       npx better-auth-scim-provisioning check --url <SCIM base URL> --auth <auth.json>

Creates a throwaway user at the app, takes it through find, update, deactivate and delete,
and reports what works. The test user is deleted at the end.`;

const [command, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < rest.length; i += 2) flags[(rest[i] ?? "").replace(/^--/, "")] = rest[i + 1] ?? "";

if (command !== "check" || !flags.url) {
  console.log(usage);
  process.exit(command === "check" || command === undefined ? 1 : 0);
}
let auth: ReturnType<typeof parseAuthFile> | undefined;
try {
  auth = flags.auth ? parseAuthFile(readFileSync(flags.auth, "utf8")) : undefined;
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
if (!auth && !process.env.SCIM_TOKEN) {
  console.error("Set SCIM_TOKEN, or pass --auth <file.json>.");
  process.exit(1);
}
const results = await checkScimTarget({ url: flags.url, token: process.env.SCIM_TOKEN, auth, userName: flags["user-name"] || undefined }).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
for (const r of results) console.log(`${r.ok === true ? "✓" : r.ok === false ? "✗" : "–"} ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
const essential = ["create a user", "find by userName", "update with PUT", "deactivate (PATCH active false)"];
process.exit(results.some((r) => essential.includes(r.name) && r.ok === false) || !results.some((r) => r.name === "create a user" && r.ok) ? 1 : 0);
