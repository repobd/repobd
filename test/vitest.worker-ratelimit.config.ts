import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// A separate Vitest project from `vitest.worker.config.ts`, deliberately:
// it points at `wrangler.ratelimit-test.jsonc` rather than `wrangler.jsonc`,
// so its Miniflare Worker instance — and its rate-limit counters — are
// entirely its own. That is what lets `worker.ratelimit.test.ts` exercise
// the exact fixed production thresholds without any other test file's
// requests counting against the same budget. See wrangler.ratelimit-test.jsonc.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const migrations = await readD1Migrations(path.join(repoRoot, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: path.join(repoRoot, "wrangler.ratelimit-test.jsonc"),
      },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    name: "worker-ratelimit",
    include: ["worker.ratelimit.test.ts"],
    setupFiles: ["./apply-migrations.ts"],
  },
});
