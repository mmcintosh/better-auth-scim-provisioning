// Prepares a release: bumps package.json, dates CHANGELOG.md's [Unreleased] section, and opens the
// "Release X.Y.Z" pull request. Merging it releases (tag-release.yml tags it and starts release.yml).
//
//   pnpm release patch|minor|major ["One sentence for the top of the version's section."]
//
// Run on an up-to-date, clean main, with `gh` signed in.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const run = (cmd, args, o = {}) => String(execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...o }) ?? "").trim();
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const [bump, summary] = process.argv.slice(2);
if (!["patch", "minor", "major"].includes(bump)) fail('usage: pnpm release patch|minor|major ["summary"]');

if (run("git", ["branch", "--show-current"]) !== "main") fail("run it on main");
if (run("git", ["status", "--porcelain"])) fail("the working tree isn't clean");
run("git", ["fetch", "--quiet", "origin", "main"]);
if (run("git", ["rev-parse", "HEAD"]) !== run("git", ["rev-parse", "origin/main"])) fail("main isn't up to date with origin/main (git pull)");

const pkg = readFileSync("package.json", "utf8");
const current = JSON.parse(pkg).version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!m) fail(`package.json's version ${current} isn't a plain X.Y.Z`);
const [major, minor, patch] = m.slice(1).map(Number);
const next = bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

const changelog = readFileSync("CHANGELOG.md", "utf8");
const head = "## [Unreleased]\n";
const at = changelog.indexOf(head);
if (at < 0) fail("CHANGELOG.md has no ## [Unreleased] section");
const rest = changelog.slice(at + head.length);
const end = rest.search(/^## \[/m);
const unreleased = (end < 0 ? rest : rest.slice(0, end)).trim();
if (!unreleased) fail("the [Unreleased] section is empty: there's nothing to release");

const date = new Date().toISOString().slice(0, 10);
const section = `## [${next}] - ${date}\n\n${summary ? `${summary}\n\n` : ""}${unreleased}\n\n`;
writeFileSync("CHANGELOG.md", `${changelog.slice(0, at)}${head}\n${section}${end < 0 ? "" : rest.slice(end)}`);
writeFileSync("package.json", pkg.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`));

const branch = `release/${next}`;
run("git", ["checkout", "-b", branch]);
run("git", ["commit", "-am", `Release ${next}`]);
run("git", ["push", "-u", "origin", branch], { stdio: ["ignore", "ignore", "inherit"] });
const url = run("gh", ["pr", "create", "--draft", "--base", "main", "--title", `Release ${next}`, "--body", `Version ${next} in package.json and its dated CHANGELOG section.\n\n**Merging this releases it:** tag-release.yml tags v${next} on main and starts the release run. Then approve the \`npm\` environment in GitHub, and the staged publish on npmjs.com.`]);
console.log(`${current} → ${next}: ${url}\nWhen CI is green, mark it ready and merge it to release.`);
