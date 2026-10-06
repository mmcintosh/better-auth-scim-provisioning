import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// test/live/ runs only with its own config (vitest.live.config.ts) and a real SCIM service.
// The examples import the package by name; in tests that's this repository's source.
export default defineConfig({
  resolve: { alias: { "better-auth-scim-provisioning": fileURLToPath(new URL("./src/index.ts", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"], exclude: ["test/live/**", "node_modules/**"], testTimeout: 30_000 },
});
