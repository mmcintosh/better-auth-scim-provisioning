// Live tests against a real SCIM service, opt-in: they run only with .env.live (git-ignored),
// holding SCIM_URL and SCIM_TOKEN. `npx vitest run -c vitest.live.config.ts`. Never in CI.
import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile(".env.live");
} catch {}

export default defineConfig({ test: { include: ["test/live/**/*.test.ts"], testTimeout: 120_000, fileParallelism: false } });
