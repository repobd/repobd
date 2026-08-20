import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "node",
    environment: "node",
    include: [
      "apply.env-file.test.ts",
      "apply.payload.test.ts",
      "apply.target.seam.test.ts",
      "apply.target.test.ts",
      "cli.diagnostics.test.ts",
      "cli.guard.test.ts",
      "cli.link.test.ts",
      "cli.pull-apply.test.ts",
      "cli.secret-client.test.ts",
      "cli.smoke.test.ts",
      "crypto.envelope.test.ts",
      "repo.binding.test.ts",
      "repo.git.test.ts",
      "repo.identity.test.ts",
    ],
  },
});
