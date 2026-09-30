// Build the published package: ESM bundled per entry (dependencies external), plus .d.ts from tsc.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
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
execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
