import { defineConfig } from "vitest/config";

// test/live/ runs only with its own config (vitest.live.config.ts) and a real SCIM service.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["test/live/**", "node_modules/**"], testTimeout: 30_000 } });
