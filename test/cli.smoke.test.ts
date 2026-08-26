import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliEntry = path.join(repoRoot, "src/cli/index.ts");
// The expectation is read from the same package.json the CLI itself reads
// at runtime, not a second hardcoded literal — a version bump with no
// matching CLI change fails this test instead of silently drifting.
const packageVersion = (
  JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as { version: string }
).version;

describe("cli scaffold", () => {
  it("prints version", () => {
    const out = execFileSync("npx", ["tsx", cliEntry, "--version"], {
      encoding: "utf8",
    });
    expect(out.trim()).toBe(packageVersion);
  });

  it("prints help including send/pull", () => {
    const out = execFileSync("npx", ["tsx", cliEntry, "--help"], {
      encoding: "utf8",
    });
    expect(out).toContain("send");
    expect(out).toContain("pull");
  });
});
