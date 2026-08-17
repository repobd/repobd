import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/cli/index.ts",
);

describe("cli scaffold", () => {
  it("prints version", () => {
    const out = execFileSync("npx", ["tsx", cliEntry, "--version"], {
      encoding: "utf8",
    });
    expect(out.trim()).toBe("0.0.0");
  });

  it("prints help including send/pull", () => {
    const out = execFileSync("npx", ["tsx", cliEntry, "--help"], {
      encoding: "utf8",
    });
    expect(out).toContain("send");
    expect(out).toContain("pull");
  });
});
