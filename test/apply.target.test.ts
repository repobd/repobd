import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENV_FILENAME,
  applyAssignment,
  envTargetPath,
  inspectApplyTarget,
} from "../src/apply/target.js";
import { parseApplyPayload, type ApplyAssignment } from "../src/apply/payload.js";

// Real temporary directories and real files: this module's whole subject is
// what the filesystem does, so nothing here is mocked. Every fixture is a
// throwaway directory created and removed by this file.
//
// Two sentinels, so a leak of either is visible: the value being applied and a
// value already sitting in the file.

const INCOMING = "TEST_ALPHA_123456";
const EXISTING = "TEST_BETA_987654";

const KEY: ApplyAssignment = { key: "API_KEY", value: INCOMING };

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "repobd-target-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A throwaway "work tree root" — this module never asks Git anything. */
async function workspace(): Promise<string> {
  return mkdtemp(path.join(root, "case-"));
}

function envPath(dir: string): string {
  return path.join(dir, ENV_FILENAME);
}

function read(dir: string): string {
  return readFileSync(envPath(dir), "utf8");
}

function write(dir: string, content: string): void {
  writeFileSync(envPath(dir), content);
}

function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

/** Names of everything in the directory, to catch stray temp files. */
function entries(dir: string): string[] {
  return readdirSync(dir).sort();
}

async function apply(dir: string, assignment = KEY, approvedReplacement = false) {
  return applyAssignment({ root: dir }, assignment, { approvedReplacement });
}

describe("target construction", () => {
  it("is always .env at the given root", () => {
    expect(envTargetPath("/some/root")).toBe(path.join("/some/root", ".env"));
    expect(ENV_FILENAME).toBe(".env");
  });

  it("writes to the root it was given, never to the process cwd", async () => {
    const dir = await workspace();
    const cwdBefore = process.cwd();
    const result = await apply(dir);
    expect(result.ok).toBe(true);
    expect(result.path).toBe(envPath(dir));
    // The regression this pins: resolving the target relative to cwd.
    expect(process.cwd()).toBe(cwdBefore);
    expect(entries(dir)).toEqual([".env"]);
    expect(readdirSync(cwdBefore)).not.toContain("__repobd_should_not_exist");
  });
});

describe("create", () => {
  it("creates .env with the assignment", async () => {
    const dir = await workspace();
    const result = await apply(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.action).toBe("create");
    expect(result.written).toBe(true);
    expect(read(dir)).toBe(`API_KEY=${INCOMING}\n`);
  });

  it("requests owner-only permissions", async () => {
    const dir = await workspace();
    await apply(dir);
    const mode = modeOf(envPath(dir));
    // Asserted as "no group or other access" rather than as exactly 0600,
    // because the effective mode is 0600 & ~umask and a stricter umask may
    // legitimately narrow it further.
    expect(mode & 0o077).toBe(0);
    expect(mode & 0o600).toBe(0o600);
  });

  it("uses LF for a file it creates", async () => {
    const dir = await workspace();
    await apply(dir);
    expect(read(dir)).not.toContain("\r");
  });

  it("re-inspects at write time instead of trusting an earlier inspection", async () => {
    const dir = await workspace();
    const inspection = await inspectApplyTarget({ root: dir }, KEY);
    expect(inspection.ok).toBe(true);
    if (inspection.ok) {
      expect(inspection.action).toBe("create");
    }
    // Something arrives between the inspection and the write.
    write(dir, `OTHER=${EXISTING}\n`);
    const result = await applyAssignment({ root: dir }, KEY, {
      approvedReplacement: false,
    });
    // Exclusive creation is not consulted here — the re-inspection sees a
    // regular file and appends — but the file must not be truncated either
    // way.
    expect(result.ok).toBe(true);
    expect(read(dir)).toContain(`OTHER=${EXISTING}`);
  });
});

describe("append", () => {
  it("appends to an LF file, preserving prior bytes exactly", async () => {
    const dir = await workspace();
    const before = `# header\nOTHER=${EXISTING}\n`;
    write(dir, before);
    const result = await apply(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("append");
    }
    expect(read(dir)).toBe(`${before}API_KEY=${INCOMING}\n`);
  });

  it("appends to an empty file without a leading blank line", async () => {
    const dir = await workspace();
    write(dir, "");
    await apply(dir);
    expect(read(dir)).toBe(`API_KEY=${INCOMING}\n`);
  });

  it("terminates the last line first when the file has no trailing newline", async () => {
    const dir = await workspace();
    write(dir, `OTHER=${EXISTING}`);
    await apply(dir);
    expect(read(dir)).toBe(`OTHER=${EXISTING}\nAPI_KEY=${INCOMING}\n`);
  });

  it("preserves CRLF style", async () => {
    const dir = await workspace();
    write(dir, `# header\r\nOTHER=${EXISTING}\r\n`);
    await apply(dir);
    expect(read(dir)).toBe(
      `# header\r\nOTHER=${EXISTING}\r\nAPI_KEY=${INCOMING}\r\n`,
    );
  });

  it("preserves CRLF style when the file has no trailing newline", async () => {
    const dir = await workspace();
    write(dir, `OTHER=${EXISTING}`);
    // Single line, no ending: LF is the default, so use a two-line CRLF file.
    write(dir, `A=1\r\nOTHER=${EXISTING}`);
    await apply(dir);
    expect(read(dir)).toBe(`A=1\r\nOTHER=${EXISTING}\r\nAPI_KEY=${INCOMING}\r\n`);
  });

  it("appends exactly once", async () => {
    const dir = await workspace();
    write(dir, `OTHER=${EXISTING}\n`);
    await apply(dir);
    const occurrences = read(dir).split("API_KEY=").length - 1;
    expect(occurrences).toBe(1);
  });

  it("preserves the existing file's permissions", async () => {
    const dir = await workspace();
    write(dir, `OTHER=${EXISTING}\n`);
    chmodSync(envPath(dir), 0o640);
    await apply(dir);
    // RepoBD does not chmod a file it did not create.
    expect(modeOf(envPath(dir))).toBe(0o640);
  });

  it("does not truncate: every prior byte survives", async () => {
    const dir = await workspace();
    const before = `# a\n\n# b\nX=1\nY=2\n\n# trailing comment\n`;
    write(dir, before);
    await apply(dir);
    expect(read(dir).startsWith(before)).toBe(true);
  });

  it("leaves no temp file behind", async () => {
    const dir = await workspace();
    write(dir, `OTHER=${EXISTING}\n`);
    await apply(dir);
    expect(entries(dir)).toEqual([".env"]);
  });
});

describe("no-op", () => {
  it("writes nothing when the key already holds this value", async () => {
    const dir = await workspace();
    const before = `# header\nAPI_KEY=${INCOMING}\n`;
    write(dir, before);
    const mtimeBefore = statSync(envPath(dir)).mtimeMs;

    const result = await apply(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.action).toBe("noop-success");
    expect(result.written).toBe(false);
    expect(read(dir)).toBe(before);
    expect(statSync(envPath(dir)).mtimeMs).toBe(mtimeBefore);
  });

  it("converges on retry, which is what lets a consume be retried", async () => {
    const dir = await workspace();
    const first = await apply(dir);
    expect(first.ok).toBe(true);
    const second = await apply(dir);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.action).toBe("noop-success");
      expect(second.written).toBe(false);
    }
    expect(read(dir)).toBe(`API_KEY=${INCOMING}\n`);
  });
});

describe("replace", () => {
  it("requires approval and touches nothing without it", async () => {
    const dir = await workspace();
    const before = `API_KEY=${EXISTING}\n`;
    write(dir, before);
    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("confirmation-required");
    expect(result.targetMayHaveChanged).toBe(false);
    expect(read(dir)).toBe(before);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("reports replace from inspection without writing", async () => {
    const dir = await workspace();
    const before = `API_KEY=${EXISTING}\n`;
    write(dir, before);
    const inspection = await inspectApplyTarget({ root: dir }, KEY);
    expect(inspection.ok).toBe(true);
    if (inspection.ok) {
      expect(inspection.action).toBe("replace");
    }
    expect(read(dir)).toBe(before);
  });

  it("changes only the matched line when approved", async () => {
    const dir = await workspace();
    write(
      dir,
      [
        "# leading comment",
        "",
        `FIRST=${EXISTING}`,
        `API_KEY=${EXISTING}`,
        "# trailing comment with spaces   ",
        `LAST=${EXISTING}`,
        "",
      ].join("\n"),
    );
    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("replace");
    }
    expect(read(dir)).toBe(
      [
        "# leading comment",
        "",
        `FIRST=${EXISTING}`,
        `API_KEY=${INCOMING}`,
        "# trailing comment with spaces   ",
        `LAST=${EXISTING}`,
        "",
      ].join("\n"),
    );
  });

  it("preserves CRLF and trailing-newline shape", async () => {
    const dir = await workspace();
    write(dir, `A=1\r\nAPI_KEY=${EXISTING}\r\nB=2`);
    await apply(dir, KEY, true);
    expect(read(dir)).toBe(`A=1\r\nAPI_KEY=${INCOMING}\r\nB=2`);
  });

  it("replaces an export-spelled assignment in place", async () => {
    const dir = await workspace();
    write(dir, `export API_KEY=${EXISTING}\nB=2\n`);
    await apply(dir, KEY, true);
    // The line is rewritten in RepoBD's own plain form, and only that line.
    expect(read(dir)).toBe(`API_KEY=${INCOMING}\nB=2\n`);
  });

  it("preserves the existing file's permissions", async () => {
    const dir = await workspace();
    write(dir, `API_KEY=${EXISTING}\n`);
    chmodSync(envPath(dir), 0o640);
    await apply(dir, KEY, true);
    expect(modeOf(envPath(dir))).toBe(0o640);
  });

  it("leaves no temp file behind on success", async () => {
    const dir = await workspace();
    write(dir, `API_KEY=${EXISTING}\n`);
    await apply(dir, KEY, true);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("never opens the original for truncation", () => {
    const source = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../src/apply/target.ts",
      ),
      "utf8",
    );
    // A truncating open is the one write mode that could destroy the file it
    // was asked to edit, so its absence is asserted rather than assumed.
    // Matched as code, not as prose: the comments in that file discuss
    // truncation deliberately.
    expect(source).not.toMatch(/O_TRUNC/);
    expect(source).not.toMatch(/\btruncate\(/);
    // `fs.writeFile(path, …)` truncates; only the handle form is used, and
    // only on a handle opened `wx` or `O_APPEND`.
    expect(source).not.toMatch(/[^.]\bwriteFile\(\s*target/);
    expect(source).not.toMatch(/open\([^)]*,\s*"w"[^x]/);
  });
});

describe("unsafe targets", () => {
  it("refuses a symlink pointing outside the repository", async () => {
    const dir = await workspace();
    const outside = path.join(root, "outside-target");
    writeFileSync(outside, "untouched\n");
    symlinkSync(outside, envPath(dir));

    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("unsafe-target");
    expect(result.targetMayHaveChanged).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("untouched\n");
  });

  it("refuses a symlink pointing inside the repository", async () => {
    const dir = await workspace();
    const inside = path.join(dir, "real-env");
    writeFileSync(inside, `OTHER=${EXISTING}\n`);
    symlinkSync(inside, envPath(dir));

    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    // Invariant 25 is unconditional: pointing somewhere harmless is not an
    // exception to it.
    expect(result.reason).toBe("unsafe-target");
    expect(readFileSync(inside, "utf8")).toBe(`OTHER=${EXISTING}\n`);
  });

  it("refuses a dangling symlink instead of creating through it", async () => {
    const dir = await workspace();
    const missing = path.join(dir, "nowhere");
    symlinkSync(missing, envPath(dir));

    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("unsafe-target");
    // The regression this pins: treating a dangling symlink as "missing" and
    // creating the file at the far end.
    expect(entries(dir)).toEqual([".env"]);
    expect(() => readFileSync(missing)).toThrow();
  });

  it("refuses a symlink to a directory", async () => {
    const dir = await workspace();
    const other = path.join(root, "some-directory");
    mkdirSync(other, { recursive: true });
    symlinkSync(other, envPath(dir));
    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("unsafe-target");
  });

  it("refuses a directory named .env", async () => {
    const dir = await workspace();
    mkdirSync(envPath(dir));
    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("unsafe-target");
    expect(result.detail).toContain("directory");
  });

  it("refuses a FIFO", async () => {
    const dir = await workspace();
    try {
      execFileSync("mkfifo", [envPath(dir)]);
    } catch {
      // No mkfifo on this platform; the classification is still covered by
      // the directory and symlink cases.
      return;
    }
    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("unsafe-target");
    expect(result.detail).toContain("FIFO");
  });

  it("reports an unsafe target from inspection too", async () => {
    const dir = await workspace();
    symlinkSync(path.join(root, "anything"), envPath(dir));
    const inspection = await inspectApplyTarget({ root: dir }, KEY);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) {
      return;
    }
    expect(inspection.reason).toBe("unsafe-target");
  });
});

describe("ambiguous existing files", () => {
  it("refuses a duplicate key", async () => {
    const dir = await workspace();
    const before = `API_KEY=${EXISTING}\nAPI_KEY=${INCOMING}\n`;
    write(dir, before);
    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("ambiguous-existing-file");
    expect(read(dir)).toBe(before);
  });

  it("refuses an unterminated quoted value", async () => {
    const dir = await workspace();
    const before = `OTHER="${EXISTING}\nAPI_KEY=${EXISTING}\n`;
    write(dir, before);
    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("ambiguous-existing-file");
    expect(read(dir)).toBe(before);
  });

  it("refuses mixed line endings", async () => {
    const dir = await workspace();
    const before = `A=1\r\nB=2\n`;
    write(dir, before);
    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("ambiguous-existing-file");
    expect(read(dir)).toBe(before);
  });

  it("refuses a file that is not valid UTF-8", async () => {
    const dir = await workspace();
    const before = Buffer.from([0x41, 0x3d, 0x31, 0x0a, 0xff, 0xfe, 0x0a]);
    writeFileSync(envPath(dir), before);
    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("ambiguous-existing-file");
    // Rewriting bytes RepoBD cannot decode would corrupt them.
    expect(readFileSync(envPath(dir))).toEqual(before);
  });
});

describe("an ambiguous same-line fragment causes no filesystem change", () => {
  // The end-to-end half of the scanner rule: the reported file must not be
  // appended to, replaced, or reported as verified, whatever the caller asks.

  const REPORTED = `OTHER="closed" AGAIN="open\nAPI_KEY=${EXISTING}\nclose"\n`;

  it("refuses and writes nothing, without approval", async () => {
    const dir = await workspace();
    write(dir, REPORTED);
    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("ambiguous-existing-file");
    expect(result.targetMayHaveChanged).toBe(false);
    expect(read(dir)).toBe(REPORTED);
    // The hazard this closes: a duplicate assignment appended because the
    // real one was hidden inside an invented multiline value.
    expect(read(dir)).not.toContain(INCOMING);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("refuses and writes nothing, even with replacement approved", async () => {
    const dir = await workspace();
    write(dir, REPORTED);
    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("ambiguous-existing-file");
    expect(read(dir)).toBe(REPORTED);
    expect(read(dir)).not.toContain(INCOMING);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("reports the same from inspection, without writing", async () => {
    const dir = await workspace();
    write(dir, REPORTED);
    const inspection = await inspectApplyTarget({ root: dir }, KEY);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) {
      return;
    }
    expect(inspection.reason).toBe("ambiguous-existing-file");
    expect(read(dir)).toBe(REPORTED);
  });

  it("leaks neither value in the refusal", async () => {
    const dir = await workspace();
    write(dir, REPORTED);
    const serialized = JSON.stringify(await apply(dir, KEY, true));
    expect(serialized).not.toContain(INCOMING);
    expect(serialized).not.toContain(EXISTING);
  });

  it("still applies normally to the same file once the line is unambiguous", async () => {
    // The rule refuses a shape, not a file: with the stray fragment removed
    // the same content applies as usual.
    const dir = await workspace();
    write(dir, `OTHER="closed"\nAPI_KEY=${EXISTING}\n`);
    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(true);
    expect(read(dir)).toBe(`OTHER="closed"\nAPI_KEY=${INCOMING}\n`);
  });
});

describe("an unquoted same-line fragment causes no filesystem change", () => {
  // End-to-end for both reported shapes: the hidden-target one, which would
  // have produced a duplicate append, and the trailing-fragment one, which
  // would have deleted unrelated content during a replacement.

  it("refuses a hidden target and appends nothing", async () => {
    const dir = await workspace();
    const before = `OTHER=x API_KEY=${EXISTING}\n`;
    write(dir, before);

    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("ambiguous-existing-file");
    expect(result.targetMayHaveChanged).toBe(false);
    expect(read(dir)).toBe(before);
    expect(read(dir)).not.toContain(INCOMING);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("refuses a trailing fragment and preserves it, even with approval", async () => {
    const dir = await workspace();
    const before = `API_KEY=${EXISTING} OTHER=x\n`;
    write(dir, before);

    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("ambiguous-existing-file");
    // The whole original line survives — including the fragment a
    // line-rewriting replacement would have discarded.
    expect(read(dir)).toBe(before);
    expect(read(dir)).toContain("OTHER=x");
    expect(read(dir)).not.toContain(INCOMING);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("reports the same from inspection, without writing", async () => {
    const dir = await workspace();
    const before = `OTHER=x API_KEY=${EXISTING}\n`;
    write(dir, before);
    const inspection = await inspectApplyTarget({ root: dir }, KEY);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) {
      return;
    }
    expect(inspection.reason).toBe("ambiguous-existing-file");
    expect(read(dir)).toBe(before);
  });

  it("leaks neither value in the refusal", async () => {
    const dir = await workspace();
    write(dir, `API_KEY=${EXISTING} OTHER=x\n`);
    const serialized = JSON.stringify(await apply(dir, KEY, true));
    expect(serialized).not.toContain(INCOMING);
    expect(serialized).not.toContain(EXISTING);
  });

  it("applies normally once the line holds one assignment", async () => {
    const dir = await workspace();
    write(dir, `OTHER=x\nAPI_KEY=${EXISTING}\n`);
    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(true);
    expect(read(dir)).toBe(`OTHER=x\nAPI_KEY=${INCOMING}\n`);
  });

  it("applies normally to a line with a trailing comment", async () => {
    const dir = await workspace();
    write(dir, `API_KEY=${EXISTING} # rotate me\n`);
    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(true);
    // The replacement rewrites the one line it was approved to rewrite.
    expect(read(dir)).toBe(`API_KEY=${INCOMING}\n`);
  });
});

describe("what RepoBD writes, RepoBD can read back", () => {
  // End-to-end form of the invariant: a real create or append must leave a
  // file that a second run classifies as already applied, for every value the
  // payload grammar permits. If it did not, a successful apply could produce a
  // `.env` its own retry refuses — and a delivery that can never be consumed.

  const VALUES = [
    INCOMING,
    "ambiguous",
    "unsupported-syntax",
    "sk-live_9.a~b+c/d=",
    "YWJjZA==",
    "a.b.c",
    "1",
    "!%*()[]{}^~+,./:?@",
  ];

  it.each(VALUES)("creates then re-reads %s", async (value) => {
    const dir = await workspace();
    const parsed = parseApplyPayload(`API_KEY=${value}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const created = await apply(dir, parsed.assignment);
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.action).toBe("create");
    }
    expect(read(dir)).toBe(`API_KEY=${value}\n`);

    // The retry that a lost consume would produce: converges, writes nothing.
    const retry = await apply(dir, parsed.assignment);
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.action).toBe("noop-success");
      expect(retry.written).toBe(false);
    }
  });

  it.each(VALUES)("appends then re-reads %s", async (value) => {
    const dir = await workspace();
    write(dir, `# header\nOTHER=x\n`);
    const parsed = parseApplyPayload(`API_KEY=${value}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const appended = await apply(dir, parsed.assignment);
    expect(appended.ok).toBe(true);
    if (appended.ok) {
      expect(appended.action).toBe("append");
    }
    expect(read(dir)).toBe(`# header\nOTHER=x\nAPI_KEY=${value}\n`);

    const retry = await apply(dir, parsed.assignment);
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.action).toBe("noop-success");
    }
  });

  it("replaces then re-reads, including a value named after a failure reason", async () => {
    const dir = await workspace();
    write(dir, `OTHER=x\nAPI_KEY=${EXISTING}\n`);
    const parsed = parseApplyPayload("API_KEY=ambiguous");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const replaced = await apply(dir, parsed.assignment, true);
    expect(replaced.ok).toBe(true);
    if (replaced.ok) {
      expect(replaced.action).toBe("replace");
    }
    expect(read(dir)).toBe(`OTHER=x\nAPI_KEY=ambiguous\n`);

    const retry = await apply(dir, parsed.assignment, true);
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.action).toBe("noop-success");
      expect(retry.written).toBe(false);
    }
  });

  it("round-trips through a CRLF file", async () => {
    const dir = await workspace();
    write(dir, `A=1\r\nOTHER=x\r\n`);
    const result = await apply(dir);
    expect(result.ok).toBe(true);
    expect(read(dir)).toBe(`A=1\r\nOTHER=x\r\nAPI_KEY=${INCOMING}\r\n`);

    const retry = await apply(dir);
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.action).toBe("noop-success");
    }
  });
});

describe("a compound line causes no filesystem change", () => {
  // Whitespace- and punctuation-delimited, in both directions. The first shape
  // would hide the active target and append a duplicate; the second would
  // delete unrelated content during a replacement.

  const COMPOUND: readonly [string, string][] = [
    ["space, target hidden", `OTHER=x API_KEY=${EXISTING}\n`],
    ["space, target first", `API_KEY=${EXISTING} OTHER=x\n`],
    ["semicolon, target hidden", `OTHER=x;API_KEY=${EXISTING}\n`],
    ["semicolon, target first", `API_KEY=${EXISTING};OTHER=x\n`],
    ["&&, target hidden", `OTHER=x&&API_KEY=${EXISTING}\n`],
    ["&&, target first", `API_KEY=${EXISTING}&&OTHER=x\n`],
  ];

  it.each(COMPOUND)("refuses %s without approval", async (_label, content) => {
    const dir = await workspace();
    write(dir, content);
    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("ambiguous-existing-file");
    expect(result.targetMayHaveChanged).toBe(false);
    expect(read(dir)).toBe(content);
    expect(read(dir)).not.toContain(INCOMING);
    expect(entries(dir)).toEqual([".env"]);
  });

  it.each(COMPOUND)("refuses %s with approval", async (_label, content) => {
    const dir = await workspace();
    write(dir, content);
    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("ambiguous-existing-file");
    // Every byte survives, including the fragment a line-rewriting
    // replacement would have discarded.
    expect(read(dir)).toBe(content);
    expect(read(dir)).not.toContain(INCOMING);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("leaks neither value in the refusal", async () => {
    const dir = await workspace();
    write(dir, `API_KEY=${EXISTING};OTHER=x\n`);
    const serialized = JSON.stringify(await apply(dir, KEY, true));
    expect(serialized).not.toContain(INCOMING);
    expect(serialized).not.toContain(EXISTING);
  });

  it("applies normally once the line holds one assignment", async () => {
    const dir = await workspace();
    write(dir, `OTHER=x\nAPI_KEY=${EXISTING}\n`);
    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(true);
    expect(read(dir)).toBe(`OTHER=x\nAPI_KEY=${INCOMING}\n`);
  });
});

describe("an ordinary file with historical comments", () => {
  it("replaces only the active target line", async () => {
    const dir = await workspace();
    const before = [
      "# old key",
      `# API_KEY=older`,
      "",
      "OTHER_KEY=value",
      `API_KEY=${EXISTING}`,
      "",
    ].join("\n");
    write(dir, before);

    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(true);
    // The commented historical key is untouched, and so is everything else.
    expect(read(dir)).toBe(
      [
        "# old key",
        `# API_KEY=older`,
        "",
        "OTHER_KEY=value",
        `API_KEY=${INCOMING}`,
        "",
      ].join("\n"),
    );
  });

  it("appends below historical comments when the key is absent", async () => {
    const dir = await workspace();
    const before = `# API_KEY=older\nOTHER_KEY=value\n`;
    write(dir, before);
    const result = await apply(dir);
    expect(result.ok).toBe(true);
    expect(read(dir)).toBe(`${before}API_KEY=${INCOMING}\n`);
  });
});

describe("an immediate # after a quoted value causes no filesystem change", () => {
  it("refuses a hidden assignment behind an adjacent comment", async () => {
    const dir = await workspace();
    const before = `OTHER="x"#;API_KEY=${EXISTING}\n`;
    write(dir, before);

    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("ambiguous-existing-file");
    expect(result.targetMayHaveChanged).toBe(false);
    expect(read(dir)).toBe(before);
    expect(read(dir)).not.toContain(INCOMING);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("refuses with approval and preserves the whole line", async () => {
    const dir = await workspace();
    const before = `API_KEY="${EXISTING}"#;OTHER=x\n`;
    write(dir, before);

    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("ambiguous-existing-file");
    expect(read(dir)).toBe(before);
    expect(read(dir)).toContain("OTHER=x");
    expect(read(dir)).not.toContain(INCOMING);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("leaks neither value in the refusal", async () => {
    const dir = await workspace();
    write(dir, `API_KEY="${EXISTING}"#;OTHER=x\n`);
    const serialized = JSON.stringify(await apply(dir, KEY, true));
    expect(serialized).not.toContain(INCOMING);
    expect(serialized).not.toContain(EXISTING);
  });

  it("applies normally when the comment is separated", async () => {
    const dir = await workspace();
    write(dir, `OTHER="x" # ordinary comment\nAPI_KEY=${EXISTING}\n`);
    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(true);
    expect(read(dir)).toBe(
      `OTHER="x" # ordinary comment\nAPI_KEY=${INCOMING}\n`,
    );
  });
});

describe("write failures", () => {
  it("reports failure when the directory is not writable", async () => {
    const dir = await workspace();
    chmodSync(dir, 0o500);
    try {
      const result = await apply(dir);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toBe("write-failed");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("reports failure when an existing .env is not writable, leaving it intact", async () => {
    const dir = await workspace();
    const before = `OTHER=${EXISTING}\n`;
    write(dir, before);
    chmodSync(envPath(dir), 0o400);
    try {
      const result = await apply(dir);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toBe("write-failed");
      expect(read(dir)).toBe(before);
    } finally {
      chmodSync(envPath(dir), 0o600);
    }
  });

  it("leaves the original intact and removes the temp file when a replacement cannot be prepared", async () => {
    const dir = await workspace();
    const before = `API_KEY=${EXISTING}\n`;
    write(dir, before);
    // The file itself stays writable; the directory does not, so the temp
    // file cannot be created. The original must survive untouched.
    chmodSync(dir, 0o500);
    try {
      const result = await apply(dir, KEY, true);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toBe("write-failed");
      expect(result.targetMayHaveChanged).toBe(false);
      expect(result.detail).toContain("not modified");
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(read(dir)).toBe(before);
    expect(entries(dir)).toEqual([".env"]);
  });
});

describe("read-back verification gates success", () => {
  it("proves the value rather than trusting the write", async () => {
    const dir = await workspace();
    const result = await apply(dir);
    expect(result.ok).toBe(true);
    // The file really holds it, which is what verification asserted.
    expect(read(dir)).toContain(`API_KEY=${INCOMING}`);
  });

  it("refuses to read an existing file it cannot open, before writing", async () => {
    const dir = await workspace();
    const before = `OTHER=${EXISTING}\n`;
    write(dir, before);
    const target = envPath(dir);
    chmodSync(target, 0o200); // write-only
    try {
      const result = await apply(dir);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      // The key's state is unknown, so nothing is written at all — this is a
      // pre-write refusal, not a verification failure.
      expect(result.reason).toBe("read-failed");
      expect(result.targetMayHaveChanged).toBe(false);
    } finally {
      chmodSync(target, 0o600);
    }
    expect(read(dir)).toBe(before);
  });

  it("fails, without rolling back, when a written file cannot be read back", async () => {
    // A real read-back failure, staged with no mocking: a umask that strips
    // the owner read bit makes the file RepoBD creates write-only, so the
    // create succeeds and the verification read cannot open it. This also
    // documents the honest limit of the 0600 request — the effective mode is
    // `0600 & ~umask`.
    const dir = await workspace();
    const previous = process.umask(0o477);
    let result;
    try {
      result = await apply(dir);
    } finally {
      process.umask(previous);
    }

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("verification-failed");
    // The write landed even though verification could not confirm it, and
    // that must be reported rather than hidden.
    expect(result.targetMayHaveChanged).toBe(true);
    expect(result.detail).toContain("may already hold the change");

    const target = envPath(dir);
    expect(modeOf(target)).toBe(0o200);
    chmodSync(target, 0o600);
    // No blind undo of a write whose read-back just proved unreliable: the
    // file still holds what was written.
    expect(read(dir)).toBe(`API_KEY=${INCOMING}\n`);
  });

  it("routes every write path through the read-back gate", () => {
    const source = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../src/apply/target.ts",
      ),
      "utf8",
    );
    // Success after a write is returned from `verify` and nowhere else. The
    // regression this pins is a write path that reports applied on the
    // strength of the write itself having returned.
    function bodyOf(fn: string): string {
      const start = source.indexOf(`async function ${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const body = source.slice(start);
      return body.slice(0, body.indexOf("\n}\n"));
    }

    for (const fn of ["createEnv", "appendEnv", "replaceEnv"]) {
      const body = bodyOf(fn);
      expect(body).toContain("return verify(");
      // No write helper constructs its own success.
      expect(body).not.toContain("ok: true");
    }
    // The single success that legitimately bypasses a read-back is the no-op,
    // whose equality the inspection already proved.
    expect(bodyOf("applyAssignment")).toContain('action: "noop-success"');
  });
});

describe("the writer validates the assignment itself", () => {
  // `ApplyAssignment` is an ordinary interface, so any caller can build one
  // without going through `parseApplyPayload`. The filesystem boundary
  // re-checks the grammar rather than trusting the type, and rejects before
  // touching anything.

  const MALFORMED: readonly [string, ApplyAssignment][] = [
    ["malformed key", { key: "1BAD", value: INCOMING }],
    ["hyphenated key", { key: "API-KEY", value: INCOMING }],
    ["empty key", { key: "", value: INCOMING }],
    ["quoted value", { key: "API_KEY", value: `"${INCOMING}"` }],
    ["multiline value", { key: "API_KEY", value: `a\n${INCOMING}` }],
    ["value with spaces", { key: "API_KEY", value: "two words" }],
    ["value with #", { key: "API_KEY", value: `${INCOMING}#x` }],
    ["value with $", { key: "API_KEY", value: "$HOME" }],
    ["value with backtick", { key: "API_KEY", value: "a`id`" }],
    ["empty value", { key: "API_KEY", value: "" }],
  ];

  it.each(MALFORMED)("rejects a %s and creates nothing", async (_label, bad) => {
    const dir = await workspace();
    const result = await apply(dir, bad, true);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("invalid-assignment");
    expect(result.targetMayHaveChanged).toBe(false);
    // Zero filesystem mutation: not even an empty .env.
    expect(entries(dir)).toEqual([]);
  });

  it.each(MALFORMED)("rejects a %s without modifying an existing file", async (_label, bad) => {
    const dir = await workspace();
    const before = `API_KEY=${EXISTING}\n`;
    write(dir, before);
    const result = await apply(dir, bad, true);
    expect(result.ok).toBe(false);
    expect(read(dir)).toBe(before);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("rejects malformed assignments from inspection too, and says nothing about them", async () => {
    const dir = await workspace();
    for (const [, bad] of MALFORMED) {
      const inspection = await inspectApplyTarget({ root: dir }, bad);
      expect(inspection.ok).toBe(false);
      if (inspection.ok) {
        continue;
      }
      expect(inspection.reason).toBe("invalid-assignment");
      // Unvalidated input: neither half may reach user-visible text. The
      // empty key is skipped because every string contains "".
      for (const half of [bad.key, bad.value]) {
        if (half !== "") {
          expect(inspection.detail).not.toContain(half);
        }
      }
      expect(inspection.detail).not.toContain(INCOMING);
      expect(inspection.detail).not.toContain(EXISTING);
    }
  });

  it("still accepts a well-formed assignment", async () => {
    const dir = await workspace();
    const result = await apply(dir, { key: "_A9", value: "sk-live_9.a~b+c/d=" });
    expect(result.ok).toBe(true);
    expect(read(dir)).toBe("_A9=sk-live_9.a~b+c/d=\n");
  });
});

describe("caller objects are snapshotted at entry", () => {
  // The arguments belong to the caller and are ordinary mutable objects.
  // Everything after the first `await` inside applyAssignment is a decision
  // about a file, so a property that answers one thing during validation and
  // another thing afterwards must not be able to change what gets written, or
  // whether a replacement was approved.

  it("ignores a value mutated after the call starts", async () => {
    const dir = await workspace();
    const mutable = { key: "API_KEY", value: INCOMING };
    const promise = applyAssignment({ root: dir }, mutable, {
      approvedReplacement: false,
    });
    // Lands after the synchronous snapshot, before the write.
    mutable.value = "MUTATED_AFTER_ENTRY";
    mutable.key = "OTHER_KEY";
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(read(dir)).toBe(`API_KEY=${INCOMING}\n`);
  });

  it("cannot be turned into an approved replacement after the call starts", async () => {
    const dir = await workspace();
    const before = `API_KEY=${EXISTING}\n`;
    write(dir, before);
    const options = { approvedReplacement: false };
    const promise = applyAssignment({ root: dir }, KEY, options);
    options.approvedReplacement = true;
    const result = await promise;

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("confirmation-required");
    expect(read(dir)).toBe(before);
  });

  it("cannot smuggle an invalid value past validation", async () => {
    const dir = await workspace();
    // Valid when validated, invalid by the time it would be written.
    const mutable = { key: "API_KEY", value: INCOMING };
    const promise = applyAssignment({ root: dir }, mutable, {
      approvedReplacement: false,
    });
    mutable.value = `evil "with spaces" #and $stuff`;
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(read(dir)).toBe(`API_KEY=${INCOMING}\n`);
  });

  it("reads each half of the assignment exactly once", async () => {
    const dir = await workspace();
    let keyReads = 0;
    let valueReads = 0;
    const probe = {
      get key() {
        keyReads += 1;
        return "API_KEY";
      },
      get value() {
        valueReads += 1;
        // A second read would return something that never passed validation.
        return valueReads === 1 ? INCOMING : "SECOND_READ_LEAKED";
      },
    };

    const result = await applyAssignment({ root: dir }, probe, {
      approvedReplacement: false,
    });

    expect(result.ok).toBe(true);
    expect(keyReads).toBe(1);
    expect(valueReads).toBe(1);
    expect(read(dir)).toBe(`API_KEY=${INCOMING}\n`);
  });

  it("reads the approval and the root exactly once", async () => {
    const dir = await workspace();
    write(dir, `API_KEY=${EXISTING}\n`);
    let approvalReads = 0;
    let rootReads = 0;
    const options = {
      get approvedReplacement() {
        approvalReads += 1;
        return true;
      },
    };
    const worktree = {
      get root() {
        rootReads += 1;
        return dir;
      },
    };

    const result = await applyAssignment(worktree, KEY, options);
    expect(result.ok).toBe(true);
    expect(approvalReads).toBe(1);
    expect(rootReads).toBe(1);
    expect(read(dir)).toBe(`API_KEY=${INCOMING}\n`);
  });

  it("treats a non-boolean approval as not approved", async () => {
    const dir = await workspace();
    const before = `API_KEY=${EXISTING}\n`;
    write(dir, before);
    const result = await applyAssignment({ root: dir }, KEY, {
      approvedReplacement: "yes" as unknown as boolean,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("confirmation-required");
    expect(read(dir)).toBe(before);
  });
});

describe("UTF-8 BOM", () => {
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

  function writeBytes(dir: string, ...parts: (Buffer | string)[]): void {
    writeFileSync(
      envPath(dir),
      Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : p))),
    );
  }

  it("preserves an existing BOM byte-for-byte through a replacement", async () => {
    const dir = await workspace();
    const body = `# header\nAPI_KEY=${EXISTING}\nLAST=1\n`;
    writeBytes(dir, BOM, body);

    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(true);

    const after = readFileSync(envPath(dir));
    // Compared as bytes, not as decoded text: TextDecoder strips a leading
    // BOM, so a text-level comparison would pass even if the bytes were lost.
    expect(after.subarray(0, 3)).toEqual(BOM);
    expect(after).toEqual(
      Buffer.concat([
        BOM,
        Buffer.from(`# header\nAPI_KEY=${INCOMING}\nLAST=1\n`, "utf8"),
      ]),
    );
  });

  it("does not add a BOM to a file that has none", async () => {
    const dir = await workspace();
    const body = `API_KEY=${EXISTING}\n`;
    writeBytes(dir, body);
    await apply(dir, KEY, true);
    const after = readFileSync(envPath(dir));
    expect(after.subarray(0, 3)).not.toEqual(BOM);
    expect(after).toEqual(Buffer.from(`API_KEY=${INCOMING}\n`, "utf8"));
  });

  it("does not add a BOM to a file it creates", async () => {
    const dir = await workspace();
    await apply(dir);
    expect(readFileSync(envPath(dir)).subarray(0, 3)).not.toEqual(BOM);
  });

  it("preserves a BOM through an append", async () => {
    const dir = await workspace();
    writeBytes(dir, BOM, `OTHER=${EXISTING}\n`);
    await apply(dir);
    expect(readFileSync(envPath(dir))).toEqual(
      Buffer.concat([
        BOM,
        Buffer.from(`OTHER=${EXISTING}\nAPI_KEY=${INCOMING}\n`, "utf8"),
      ]),
    );
  });

  it("reads the key correctly in a BOM-prefixed file", async () => {
    const dir = await workspace();
    writeBytes(dir, BOM, `API_KEY=${INCOMING}\n`);
    const result = await apply(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The BOM must not make the first line unreadable.
      expect(result.action).toBe("noop-success");
    }
  });
});

describe("permission preservation under a restrictive umask", () => {
  // The regression: the mode passed to `open` is filtered by umask, so it
  // alone cannot reproduce the original's permissions. Only an explicit
  // chmod on the descriptor does.

  it("preserves a group-readable mode on replacement under umask 077", async () => {
    const dir = await workspace();
    write(dir, `API_KEY=${EXISTING}\nOTHER=1\n`);
    chmodSync(envPath(dir), 0o644);

    const previous = process.umask(0o077);
    try {
      const result = await apply(dir, KEY, true);
      expect(result.ok).toBe(true);
    } finally {
      process.umask(previous);
    }

    expect(modeOf(envPath(dir))).toBe(0o644);
    expect(read(dir)).toBe(`API_KEY=${INCOMING}\nOTHER=1\n`);
  });

  it("preserves an owner-only mode under a permissive umask", async () => {
    const dir = await workspace();
    write(dir, `API_KEY=${EXISTING}\n`);
    chmodSync(envPath(dir), 0o600);

    const previous = process.umask(0o000);
    try {
      await apply(dir, KEY, true);
    } finally {
      process.umask(previous);
    }

    // Never broadened either: a permissive umask must not widen the file.
    expect(modeOf(envPath(dir))).toBe(0o600);
  });

  it("preserves an unusual mode exactly", async () => {
    const dir = await workspace();
    write(dir, `API_KEY=${EXISTING}\n`);
    chmodSync(envPath(dir), 0o640);
    await apply(dir, KEY, true);
    expect(modeOf(envPath(dir))).toBe(0o640);
  });
});

describe("temp-file ownership", () => {
  it("never removes a pre-existing file this invocation did not create", async () => {
    const dir = await workspace();
    write(dir, `API_KEY=${EXISTING}\n`);
    // A leftover from some other run, or from another tool. It is not this
    // invocation's to delete, whatever happens here.
    const decoy = path.join(dir, `${ENV_FILENAME}.repobd-decoy.tmp`);
    writeFileSync(decoy, "not ours\n");

    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(true);
    expect(readFileSync(decoy, "utf8")).toBe("not ours\n");
  });

  it("guards the unlink on this invocation having created the file", () => {
    const source = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../src/apply/target.ts",
      ),
      "utf8",
    );
    // An EEXIST on the temp path means the path was someone else's; deleting
    // it would destroy an unrelated file.
    expect(source).toMatch(/tempCreated\s*&&\s*!renamed/);
    expect(source).toMatch(/tempCreated = true;/);
  });
});

describe("durability", () => {
  it("syncs the parent directory after creating a new file", () => {
    const source = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../src/apply/target.ts",
      ),
      "utf8",
    );
    // The file's bytes and the directory entry naming it are separate writes.
    // Observing the fsync itself is not practical, so the call is pinned here;
    // it stays best-effort, as on the replacement path.
    const body = source.slice(source.indexOf("async function createEnv("));
    expect(body.slice(0, body.indexOf("\n}\n"))).toContain("syncDirectory(");
  });
});

describe("diagnostics carry no secret", () => {
  it("keeps both sentinels out of every failure result", async () => {
    const cases: (() => Promise<string>)[] = [
      async () => {
        const dir = await workspace();
        write(dir, `API_KEY=${EXISTING}\n`);
        return dir;
      },
      async () => {
        const dir = await workspace();
        write(dir, `API_KEY=${EXISTING}\nAPI_KEY=${INCOMING}\n`);
        return dir;
      },
      async () => {
        const dir = await workspace();
        write(dir, `OTHER="${EXISTING}\n`);
        return dir;
      },
      async () => {
        const dir = await workspace();
        write(dir, `A=${EXISTING}\r\nB=${INCOMING}\n`);
        return dir;
      },
      async () => {
        const dir = await workspace();
        symlinkSync(path.join(root, "anywhere"), envPath(dir));
        return dir;
      },
    ];

    for (const makeCase of cases) {
      const dir = await makeCase();
      const result = await apply(dir);
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(INCOMING);
      expect(serialized).not.toContain(EXISTING);
      // Nor any `.env` content beyond the file name and the key.
      expect(serialized).not.toContain("OTHER=");
    }
  });

  it("keeps both sentinels out of successful results", async () => {
    const dir = await workspace();
    write(dir, `API_KEY=${EXISTING}\n`);
    const result = await apply(dir, KEY, true);
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(INCOMING);
    expect(serialized).not.toContain(EXISTING);
  });

  it("names the key in a confirmation-required detail, and no value", async () => {
    const dir = await workspace();
    write(dir, `API_KEY=${EXISTING}\n`);
    const result = await apply(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.detail).toContain("API_KEY");
    expect(result.detail).not.toContain(EXISTING);
    expect(result.detail).not.toContain(INCOMING);
  });
});

describe("no secret residue outside .env", () => {
  it("writes nothing to /tmp or anywhere but the target directory", async () => {
    const dir = await workspace();
    write(dir, `API_KEY=${EXISTING}\n`);
    await apply(dir, KEY, true);
    // The only artifact is .env itself; the temp file lived beside it and was
    // consumed by the rename.
    expect(entries(dir)).toEqual([".env"]);
  });

  it("names the temp file beside .env, not in a system temp directory", () => {
    const source = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../src/apply/target.ts",
      ),
      "utf8",
    );
    expect(source).toContain("repobd-");
    expect(source).not.toMatch(/tmpdir\(\)/);
    expect(source).not.toMatch(/"\/tmp/);
    expect(source).not.toMatch(/node:os/);
  });
});
