import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  REDACTED,
  redact,
  redactionTargets,
} from "../src/cli/diagnostics.js";

// Read from the same package.json the CLI reads at runtime, not a second
// hardcoded literal — see cli.smoke.test.ts for the identical reasoning.
const packageVersion = (
  JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, "../package.json"),
      "utf8",
    ),
  ) as { version: string }
).version;

// The CLI diagnostic safety boundary.
//
// A delivery link pasted anywhere on the command line must not come back out
// of the argument parser. These tests run the real CLI as a subprocess, so
// what is asserted is what a user's terminal would actually show — not what a
// unit-level stub was told to produce.
//
// Nothing here reaches a network: every case fails during argument parsing,
// before any command body runs.

const CLI = path.resolve(import.meta.dirname, "../src/cli/index.ts");

// Distinct sentinels, so a leak of any single part of the link is
// unmistakable and attributable.
const SENTINEL_ID = "SENTINELsecretIDvalue";
const SENTINEL_KEY = "SENTINELdecryptionKEYvalue";
const SENTINEL_OWNER = "sentinelowner";
const SENTINEL_REPO = "sentinelrepo";
const SENTINEL_HOST = "sentinelservice.example";
const SENTINEL_BINDING = `{"bv":1,"repo":"github.com/${SENTINEL_OWNER}/${SENTINEL_REPO}"}`;
const SENTINEL_FRAGMENT = `k=${SENTINEL_KEY}&b=${encodeURIComponent(SENTINEL_BINDING)}`;
const LINK = `https://${SENTINEL_HOST}/d/${SENTINEL_ID}#${SENTINEL_FRAGMENT}`;

/** Everything that must never survive into a diagnostic. */
const SECRET_BEARING = [
  LINK,
  SENTINEL_ID,
  SENTINEL_KEY,
  SENTINEL_OWNER,
  SENTINEL_REPO,
  SENTINEL_HOST,
  SENTINEL_FRAGMENT,
  SENTINEL_BINDING,
  encodeURIComponent(SENTINEL_BINDING),
];

function runCli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("npx", ["tsx", CLI, ...args], {
    encoding: "utf8",
    input: "",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function expectNoLeak(result: { stdout: string; stderr: string }): void {
  for (const stream of [result.stdout, result.stderr]) {
    for (const secret of SECRET_BEARING) {
      expect(stream).not.toContain(secret);
    }
    // Nothing that could be reassembled into a fragment, either.
    expect(stream).not.toContain("#");
    expect(stream).not.toContain("SENTINEL");
  }
}

describe("redaction rules", () => {
  it("passes RepoBD's own vocabulary through", () => {
    expect(redactionTargets(["pull"])).toEqual([]);
    expect(redactionTargets(["--help"])).toEqual([]);
    expect(redactionTargets(["send", "--version"])).toEqual([]);
  });

  it("targets every other token, longest first", () => {
    const targets = redactionTargets(["pull", "aaa", "bbbbb"]);
    expect(targets).toEqual(["bbbbb", "aaa"]);
  });

  it("targets the value of an assignment as well as the whole token", () => {
    const targets = redactionTargets([`--link=${LINK}`]);
    expect(targets).toContain(`--link=${LINK}`);
    expect(targets).toContain(LINK);
    // Longest first, so the whole token cannot be partially replaced.
    expect(targets[0]).toBe(`--link=${LINK}`);
  });

  it("replaces every occurrence", () => {
    const text = `unknown option '${LINK}' near ${LINK}`;
    const output = redact(text, redactionTargets([LINK]));
    expect(output).toBe(`unknown option '${REDACTED}' near ${REDACTED}`);
    expect(output).not.toContain(SENTINEL_KEY);
  });

  it("redacts malformed input without parsing it", () => {
    // Not a URL, not a link, unbalanced — redaction must not depend on the
    // value being well-formed.
    const junk = "https://%%%#k=&&&b=<<<not-json";
    expect(redact(`error: ${junk}`, redactionTargets([junk]))).toBe(
      `error: ${REDACTED}`,
    );
  });

  it("is not confused by regex metacharacters in the value", () => {
    const nasty = "https://x/d/a#k=.*+?[]()|^$";
    expect(redact(`bad: ${nasty}`, redactionTargets([nasty]))).toBe(
      `bad: ${REDACTED}`,
    );
  });
});

describe("no argv shape leaks a delivery link into diagnostics", () => {
  it("rejects a link as a pull operand", () => {
    const result = runCli("pull", LINK);
    expect(result.status).toBe(1);
    expectNoLeak(result);
  });

  it("rejects a link after a pull separator", () => {
    const result = runCli("pull", "--", LINK);
    expect(result.status).not.toBe(0);
    expectNoLeak(result);
  });

  it("rejects a link after a program-level separator", () => {
    const result = runCli("--", "pull", LINK);
    expect(result.status).not.toBe(0);
    expectNoLeak(result);
  });

  it("rejects a link supplied as an option value", () => {
    const result = runCli("pull", `--link=${LINK}`);
    expect(result.status).not.toBe(0);
    expectNoLeak(result);
  });

  it("rejects a link passed to send", () => {
    const result = runCli("send", LINK);
    expect(result.status).not.toBe(0);
    expectNoLeak(result);
  });

  it("rejects a link glued to a command name", () => {
    const result = runCli(`pull=${LINK}`);
    expect(result.status).not.toBe(0);
    expectNoLeak(result);
  });

  it("rejects an unknown command carrying a link", () => {
    const result = runCli(`deliver${LINK}`);
    expect(result.status).not.toBe(0);
    expectNoLeak(result);
  });

  it("rejects a link in an unknown option's position", () => {
    const result = runCli("--paste", LINK);
    expect(result.status).not.toBe(0);
    expectNoLeak(result);
  });
});

describe("ordinary diagnostics stay useful", () => {
  it("prints complete help", () => {
    const result = runCli("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: repobd");
    expect(result.stdout).toContain("send");
    expect(result.stdout).toContain("pull");
    expect(result.stdout).not.toContain(REDACTED);
  });

  it("prints pull help describing the prompt", () => {
    const result = runCli("pull", "--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("prompts for the delivery link");
    expect(result.stdout).not.toContain(REDACTED);
  });

  it("prints the version", () => {
    const result = runCli("--version");
    expect(result.stdout.trim()).toBe(packageVersion);
  });

  it("still says what kind of mistake an unknown command was", () => {
    // The token itself is redacted — the boundary cannot know which user
    // tokens are harmless — but the diagnostic still names the problem, and
    // `repobd --help` lists the real commands.
    const result = runCli("wibble");
    expect(result.stderr).toContain("unknown command");
    expect(result.stderr).toContain(REDACTED);
  });

  it("gives the friendly message for the likely pull mistake", () => {
    const result = runCli("pull", LINK);
    expect(result.stderr.trim()).toBe(
      "repobd pull does not accept a link argument. Run repobd pull and paste the link when prompted.",
    );
    expect(result.stdout).toBe("");
  });
});
