import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "node",
    environment: "node",
    include: [
      "cli.diagnostics.test.ts",
      "cli.guard.test.ts",
      "cli.link.test.ts",
      "cli.smoke.test.ts",
      "crypto.envelope.test.ts",
      "repo.binding.test.ts",
      "repo.git.test.ts",
      "repo.identity.test.ts",
    ],
  },
});
