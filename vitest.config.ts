import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["test/vitest.cli.config.ts", "test/vitest.worker.config.ts"],
  },
});
