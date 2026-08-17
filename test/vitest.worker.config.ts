import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.join(repoRoot, "wrangler.jsonc") },
    }),
  ],
  test: {
    name: "worker",
    include: ["worker.smoke.test.ts"],
  },
});
