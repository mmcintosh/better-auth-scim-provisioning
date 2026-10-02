// Build the published package: ESM bundled per entry (dependencies external), plus .d.ts from tsc.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
rmSync(`${root}dist`, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  packages: "external",
  sourcemap: true,
  logLevel: "warning",
});
// The `check` command (Node only).
await build({
  absWorkingDir: root,
  entryPoints: ["src/cli.ts"],
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  logLevel: "warning",
});
execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });

// Sources use extensionless relative imports (moduleResolution "Bundler"). Consumers on
// "NodeNext" need explicit extensions in declaration files (both `from "./x"` and the inline
// `import("./x")` tsc emits), so add them.
for (const file of readdirSync(`${root}dist`).filter((f) => f.endsWith(".d.ts"))) {
  const path = `${root}dist/${file}`;
  const src = readFileSync(path, "utf8");
  const out = src.replace(/(from\s+|import\()(["'])(\.{1,2}\/[^"']+)\2/g, (m, pre, q, spec) =>
    /\.(js|mjs|cjs|json)$/.test(spec) ? m : `${pre}${q}${spec}.js${q}`,
  );
  if (out !== src) writeFileSync(path, out);
}
