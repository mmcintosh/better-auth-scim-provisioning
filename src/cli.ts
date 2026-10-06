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
const KNOWN = new Set(["url", "user-name", "auth"]);
const flags: Record<string, string> = {};
const badFlags: string[] = [];
// --name value, or --name=value; anything else, or an unknown name, is a mistake worth saying.
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i] ?? "";
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
  if (!m || !KNOWN.has(m[1] as string)) {
    badFlags.push(arg);
    continue;
  }
  flags[m[1] as string] = m[2] ?? rest[++i] ?? "";
}

if (command === "help" || command === "--help" || command === "-h") {
  console.log(usage);
  process.exit(0);
}
if (command === "check" && badFlags.length) {
  console.error(`Unknown or malformed argument: ${badFlags.join(" ")}\n\n${usage}`);
  process.exit(1);
}
if (command !== "check" || !flags.url) {
  // An unknown command, or check without --url: a mistake, so a failing exit code.
  console.error(command && command !== "check" ? `Unknown command: ${command}\n\n${usage}` : usage);
  process.exit(1);
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
// Fails an app the plugin can't work with: it can't create, find or deactivate users, or update
// them either way (an app that only takes PATCH works with update: "patch").
const failed = (id: string) => results.some((r) => r.id === id && r.ok === false);
const unusable = ["create", "find", "deactivate"].some(failed) || (failed("update-put") && failed("update-patch")) || !results.some((r) => r.id === "create" && r.ok);
process.exit(unusable ? 1 : 0);
