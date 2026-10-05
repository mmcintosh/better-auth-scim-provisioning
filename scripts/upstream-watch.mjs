// Weekly upstream watch: what this repository depends on that Dependabot doesn't cover. Reads
// .github/upstream-watch.json and keeps one open issue ("Upstream watch") up to date with:
// - Better Auth: its latest release against our peer range (the canary tests it; this says when a
//   new minor needs the range widened);
// - vendored builds of unreleased upstream code (vendor/*.tgz): commits upstream since the pinned
//   one, and whether npm has a release yet that could replace the build;
// - updates held back on purpose: the newest version, and the condition for taking it.
// It rewrites the issue's body each run and comments only when something changed, so a
// notification means there's something to look at.
//
//   node scripts/upstream-watch.mjs            (in CI: GITHUB_TOKEN, GITHUB_REPOSITORY)
//   node scripts/upstream-watch.mjs --dry-run  (prints the issue body)
import { readFileSync, readdirSync, existsSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const config = JSON.parse(readFileSync(".github/upstream-watch.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const TITLE = "Upstream watch";

async function json(url, init = {}) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url}: ${res.status} ${await res.text()}`);
  return res.json();
}
const gh = (path, init = {}) =>
  json(`https://api.github.com/${path}`, {
    ...init,
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
const npm = (name) => json(`https://registry.npmjs.org/${name.replace("/", "%2F")}`);

const num = (v) => v.split(/[.-]/).slice(0, 3).map(Number);
const lt = (a, b) => { const [x, y] = [num(a), num(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };

const sections = [];
const state = {}; // what each item looked like this run; a change from last run is worth a comment
const changes = [];
const note = (key, fingerprint, summary) => {
  state[key] = fingerprint;
  return summary;
};

// Better Auth against the peer range's upper bound (">=1.7.5 <1.8.0").
{
  const range = pkg.peerDependencies?.["better-auth"] ?? "";
  const upper = /<\s*(\d+\.\d+\.\d+)/.exec(range)?.[1];
  const meta = await npm("better-auth");
  const latest = meta["dist-tags"].latest;
  // The next tag can be stale (0.8.7-beta.5 in 2026-09): shown only when it's ahead of latest.
  const next = meta["dist-tags"].next && lt(latest, meta["dist-tags"].next) ? meta["dist-tags"].next : "none newer";
  const outside = upper && !lt(latest, upper);
  const line = outside
    ? `- **Better Auth ${latest} is outside the peer range \`${range}\`.** Widen it in a minor release once the canary passes on ${latest}.`
    : `- Better Auth ${latest} (next: ${next}) is inside the peer range \`${range}\`.`;
  sections.push(`## Better Auth\n\n${note("better-auth", outside ? `outside:${latest}` : "inside", line)}`);
}

// Vendored builds: every vendor/*.tgz must be listed, so a new one can't go unwatched.
{
  const files = existsSync("vendor") ? readdirSync("vendor").filter((f) => f.endsWith(".tgz")) : [];
  const lines = [];
  for (const v of config.vendored ?? []) {
    const file = files.find((f) => f.startsWith(v.vendorPrefix));
    if (!file) throw new Error(`no vendor/${v.vendorPrefix}*.tgz for ${v.name}: update .github/upstream-watch.json`);
    const sha = /-([0-9a-f]{7,40})\.tgz$/.exec(file)?.[1];
    if (!sha) throw new Error(`vendor/${file} has no commit in its name`);
    const info = await gh(`repos/${v.repo}`);
    const cmp = await gh(`repos/${v.repo}/compare/${sha}...${info.default_branch}`);
    const meta = await npm(v.npm);
    const latest = meta["dist-tags"].latest;
    const released = latest !== v.releasedWhenVendored;
    const titles = cmp.commits.slice(-10).reverse().map((c) => `  - ${c.commit.message.split("\n")[0]} (${c.sha.slice(0, 7)})`);
    lines.push(
      note(`vendored:${v.name}`, `${cmp.ahead_by}:${latest}`, [
        `- **${v.name}**: \`vendor/${file}\`, built from ${v.repo}@${sha}.`,
        released
          ? `  - **npm has ${v.npm} ${latest}** (was ${v.releasedWhenVendored} when vendored). ${v.replaceWhen}`
          : `  - npm: still ${latest}. ${v.replaceWhen}`,
        cmp.ahead_by ? `  - ${cmp.ahead_by} commit(s) on ${info.default_branch} since the build:` : `  - No new commits on ${info.default_branch}.`,
        ...titles,
        ...(cmp.ahead_by > 10 ? [`  - … [all of them](https://github.com/${v.repo}/compare/${sha}...${info.default_branch})`] : []),
      ].join("\n")),
    );
  }
  const unlisted = files.filter((f) => !(config.vendored ?? []).some((v) => f.startsWith(v.vendorPrefix)));
  if (unlisted.length) throw new Error(`vendor/ has unwatched builds: ${unlisted.join(", ")} (add them to .github/upstream-watch.json)`);
  if (lines.length) sections.push(`## Vendored builds of unreleased code\n\n${lines.join("\n")}`);
}

// Updates held back on purpose.
{
  const lines = [];
  for (const h of config.held ?? []) {
    const meta = await npm(h.npm);
    const latest = meta["dist-tags"].latest;
    lines.push(note(`held:${h.name}`, latest, `- **${h.name}** (newest ${h.npm}: ${latest}). Held because ${h.because} Take it when ${h.takeWhen}`));
  }
  if (lines.length) sections.push(`## Held back on purpose\n\n${lines.join("\n")}`);
}

const month = new Date().toISOString().slice(0, 7);
if (config.monthly?.length) sections.push(`## Every month\n\n${config.monthly.map((m) => `- ${m}`).join("\n")}`);

const body = (_prev) =>
  `Updated weekly by [upstream-watch.yml](../blob/main/.github/workflows/upstream-watch.yml) from \`.github/upstream-watch.json\`. ` +
  `A comment means something changed since the last run.\n\n${sections.join("\n\n")}\n\n` +
  `<!-- upstream-watch-state ${JSON.stringify({ month, items: state })} -->\n`;

if (dryRun || !token || !repo) {
  console.log(body());
  process.exit(0);
}

const open = (await gh(`repos/${repo}/issues?state=open&per_page=100`)).filter((i) => i.title === TITLE && !i.pull_request);
let issue = open[0];
if (!issue) {
  issue = await gh(`repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title: TITLE, body: body() }) });
  console.log("created", issue.html_url);
  process.exit(0);
}
const previous = JSON.parse(/<!-- upstream-watch-state (.*) -->/.exec(issue.body ?? "")?.[1] ?? "{}");
for (const [key, fp] of Object.entries(state)) if (previous.items?.[key] !== fp) changes.push(key.replace(/^\w+:/, ""));
const newMonth = previous.month !== month && config.monthly?.length;
await gh(`repos/${repo}/issues/${issue.number}`, { method: "PATCH", body: JSON.stringify({ body: body() }) });
if (changes.length || newMonth) {
  const parts = [];
  if (changes.length) parts.push(`Changed since the last run: ${changes.join(", ")}. See the issue body.`);
  if (newMonth) parts.push(`New month: ${config.monthly.join(" ")}`);
  await gh(`repos/${repo}/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body: parts.join("\n\n") }) });
}
console.log("updated", issue.html_url, changes.length ? `changed: ${changes.join(", ")}` : "no change");
