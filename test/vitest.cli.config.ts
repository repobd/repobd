import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "node",
    environment: "node",
    include: ["cli.smoke.test.ts", "crypto.envelope.test.ts"],
  },
});
