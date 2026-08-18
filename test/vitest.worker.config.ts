import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Read once here rather than in each test: the pool serialises these into the
// test environment, and the setup file applies them to the local database.
const migrations = await readD1Migrations(path.join(repoRoot, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.join(repoRoot, "wrangler.jsonc") },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    name: "worker",
    include: ["worker.smoke.test.ts", "worker.d1.test.ts"],
    setupFiles: ["./apply-migrations.ts"],
  },
});
