import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Cases that need something to happen *during* one call, or need a metadata
// value the test process cannot legitimately produce.
//
// Kept in their own file because the interception must not apply to the rest
// of the target tests, and deliberately thin: the wrapper below delegates
// every operation to the real `node:fs/promises`. Nothing is simulated — real
// files, real renames, real permissions — and the hooks only fire where a
// test asks them to. This is a seam, not a filesystem mock.
//
// Two things need one:
//
//   1. Concurrent change. RepoBD reads `.env`, the user takes a moment over
//      the confirmation prompt, and something else touches the file. Saving in
//      place reuses the inode, and a chmod or chgrp changes neither the inode
//      nor the bytes, so each needs a different check and each has to be
//      staged inside the window between read and rename.
//
//   2. Identity and metadata RepoBD refuses to change. Producing a file owned
//      by another user, or a temp file whose uid cannot be set, needs
//      privilege — so those values are substituted at the boundary instead.

interface Hooks {
  /** Fires once, just after the replacement temp file is opened. */
  onTempOpen: (() => void) | null;
  /**
   * Fires once, immediately after the inspection has read the target — the
   * point at which a decision has been made and the file could still change
   * before anything is written.
   */
  afterInspectionRead: (() => void) | null;
  /** Rewrites what `lstat` reports for the target, after the temp exists. */
  lateLstat: ((stats: Stats) => Stats) | null;
  /** Rewrites what the temp file's own `fstat` reports. */
  tempStat: ((stats: Stats) => Stats) | null;
  /** Makes exclusive temp creation fail as though the path already existed. */
  tempExists: boolean;
}

const hooks: Hooks = {
  onTempOpen: null,
  afterInspectionRead: null,
  lateLstat: null,
  tempStat: null,
  tempExists: false,
};

let tempOpened = false;
const unlinked: string[] = [];
/** Ordered log of what was done to the replacement temp file's descriptor. */
const tempOps: string[] = [];

/** Overrides numeric stat fields while keeping the real `isFile()` and friends. */
function withStat(stats: Stats, overrides: Partial<Stats>): Stats {
  return Object.create(stats, {
    ...Object.fromEntries(
      Object.entries(overrides).map(([k, v]) => [k, { value: v, enumerable: true }]),
    ),
  }) as Stats;
}

const isTempPath = (p: unknown): boolean => String(p).includes(".repobd-");

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (isTempPath(args[0])) {
        if (hooks.tempExists) {
          const error = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
          error.code = "EEXIST";
          throw error;
        }
        const handle = await actual.open(...args);
        tempOpened = true;
        tempOps.push("open");
        if (hooks.onTempOpen !== null) {
          const fire = hooks.onTempOpen;
          hooks.onTempOpen = null;
          fire();
        }
        const rewrite = hooks.tempStat;
        return new Proxy(handle, {
          get(target, property) {
            const name = String(property);
            if (name === "stat") {
              return async () => {
                tempOps.push("stat");
                const stats = await target.stat();
                return rewrite === null ? stats : rewrite(stats);
              };
            }
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") {
              return value;
            }
            return (...callArgs: unknown[]) => {
              if (["writeFile", "write", "chmod", "chown", "sync"].includes(name)) {
                tempOps.push(name);
              }
              return (value as (...a: unknown[]) => unknown).apply(target, callArgs);
            };
          },
        });
      }
      return actual.open(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const contents = await actual.readFile(...args);
      if (hooks.afterInspectionRead !== null) {
        const fire = hooks.afterInspectionRead;
        hooks.afterInspectionRead = null;
        fire();
      }
      return contents;
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stats = await actual.lstat(...args);
      return hooks.lateLstat !== null && tempOpened
        ? hooks.lateLstat(stats as Stats)
        : stats;
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      unlinked.push(String(args[0]));
      return actual.unlink(...args);
    },
  };
});

const { applyAssignment, ENV_FILENAME } = await import("../src/apply/target.js");

const INCOMING = "TEST_ALPHA_123456";
const EXISTING = "TEST_BETA_987654";
const KEY = { key: "API_KEY", value: INCOMING } as const;

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "repobd-seam-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  hooks.onTempOpen = null;
  hooks.afterInspectionRead = null;
  tempOps.length = 0;
  hooks.lateLstat = null;
  hooks.tempStat = null;
  hooks.tempExists = false;
  tempOpened = false;
  unlinked.length = 0;
});

async function workspace(): Promise<string> {
  return mkdtemp(path.join(root, "case-"));
}

const envPath = (dir: string): string => path.join(dir, ENV_FILENAME);
const read = (dir: string): string => readFileSync(envPath(dir), "utf8");
const entries = (dir: string): string[] => readdirSync(dir).sort();
const modeOf = (dir: string): number => statSync(envPath(dir)).mode & 0o7777;

async function replace(dir: string) {
  return applyAssignment({ root: dir }, KEY, { approvedReplacement: true });
}

/** Rewrites the file through the same inode, exactly as an editor's save does. */
function editInPlace(dir: string, content: string): void {
  const before = statSync(envPath(dir)).ino;
  writeFileSync(envPath(dir), content);
  // If this ever stopped reusing the inode the test would be proving nothing.
  expect(statSync(envPath(dir)).ino).toBe(before);
}

describe("a concurrent content change blocks the replacement", () => {
  it("refuses when the bytes changed even though the inode did not", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `# header\nAPI_KEY=${EXISTING}\n`);
    const inodeBefore = statSync(envPath(dir)).ino;

    const edited = `# header\nAPI_KEY=${EXISTING}\nADDED_BY_EDITOR=1\n`;
    hooks.onTempOpen = () => editInPlace(dir, edited);

    const result = await replace(dir);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("target-changed");
    expect(result.targetMayHaveChanged).toBe(false);
    // The user's save survives, untouched.
    expect(read(dir)).toBe(edited);
    expect(statSync(envPath(dir)).ino).toBe(inodeBefore);
  });

  it("removes its own temp file when it aborts", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `API_KEY=${EXISTING}\n`);
    hooks.onTempOpen = () => editInPlace(dir, `API_KEY=${EXISTING}\nX=1\n`);

    await replace(dir);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("does not retry, and reports without changing anything", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `API_KEY=${EXISTING}\n`);
    // The edit removes the key entirely. A re-plan would decide to append;
    // RepoBD must not silently do that, because the approval it holds was
    // given about a file that no longer exists.
    const edited = "SOMETHING_ELSE=1\n";
    hooks.onTempOpen = () => editInPlace(dir, edited);

    const result = await replace(dir);
    expect(result.ok).toBe(false);
    expect(read(dir)).toBe(edited);
  });

  it("carries no secret in the refusal", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `API_KEY=${EXISTING}\n`);
    hooks.onTempOpen = () => editInPlace(dir, `API_KEY=${EXISTING}\nX=1\n`);

    const serialized = JSON.stringify(await replace(dir));
    expect(serialized).not.toContain(INCOMING);
    expect(serialized).not.toContain(EXISTING);
  });

  it("still replaces normally when nothing changed", async () => {
    // The guard must not block the ordinary case.
    const dir = await workspace();
    writeFileSync(envPath(dir), `# header\nAPI_KEY=${EXISTING}\n`);
    const result = await replace(dir);
    expect(result.ok).toBe(true);
    expect(read(dir)).toBe(`# header\nAPI_KEY=${INCOMING}\n`);
  });
});

describe("a concurrent metadata change blocks the replacement", () => {
  // Neither of these changes the inode or a single byte, so only comparing
  // the metadata catches them. Renaming over either would silently undo a
  // permission decision the user just made.

  it("refuses when the mode changed under it", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `API_KEY=${EXISTING}\n`);
    chmodSync(envPath(dir), 0o600);
    const bytesBefore = readFileSync(envPath(dir));

    // A real chmod, from "another terminal", inside the window.
    hooks.onTempOpen = () => chmodSync(envPath(dir), 0o644);

    const result = await replace(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("target-changed");
    // The chmod stands, and the content is untouched.
    expect(modeOf(dir)).toBe(0o644);
    expect(readFileSync(envPath(dir))).toEqual(bytesBefore);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("refuses when the group changed under it", async () => {
    // Changing the gid for real needs membership of a second group, which is
    // not guaranteed on a build machine, so the value is substituted at the
    // boundary instead of requiring privilege.
    const dir = await workspace();
    writeFileSync(envPath(dir), `API_KEY=${EXISTING}\n`);
    const bytesBefore = readFileSync(envPath(dir));
    const realGid = statSync(envPath(dir)).gid;

    hooks.onTempOpen = () => undefined;
    hooks.lateLstat = (stats) => withStat(stats, { gid: realGid + 1 });

    const result = await replace(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("target-changed");
    expect(readFileSync(envPath(dir))).toEqual(bytesBefore);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("refuses when the owner changed under it", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `API_KEY=${EXISTING}\n`);
    const realUid = statSync(envPath(dir)).uid;

    hooks.onTempOpen = () => undefined;
    hooks.lateLstat = (stats) => withStat(stats, { uid: realUid + 1 });

    const result = await replace(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("target-changed");
    expect(entries(dir)).toEqual([".env"]);
  });
});

describe("the replacement is not renamed unless its metadata matches", () => {
  it("refuses when the temp file's uid could not be set", async () => {
    const dir = await workspace();
    const before = `API_KEY=${EXISTING}\n`;
    writeFileSync(envPath(dir), before);
    const realUid = statSync(envPath(dir)).uid;

    // As though `chown` had silently failed: the temp file would carry a
    // different owner into the target.
    hooks.tempStat = (stats) => withStat(stats, { uid: realUid + 1 });

    const result = await replace(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("metadata-not-preserved");
    expect(result.targetMayHaveChanged).toBe(false);
    expect(read(dir)).toBe(before);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("refuses when the temp file's gid could not be set", async () => {
    const dir = await workspace();
    const before = `API_KEY=${EXISTING}\n`;
    writeFileSync(envPath(dir), before);
    const realGid = statSync(envPath(dir)).gid;

    hooks.tempStat = (stats) => withStat(stats, { gid: realGid + 1 });

    const result = await replace(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("metadata-not-preserved");
    expect(read(dir)).toBe(before);
  });

  it("refuses when the temp file's mode could not be set", async () => {
    const dir = await workspace();
    const before = `API_KEY=${EXISTING}\n`;
    writeFileSync(envPath(dir), before);
    chmodSync(envPath(dir), 0o640);

    // As though `chmod` had silently dropped a bit — including the direction
    // that would widen access.
    hooks.tempStat = (stats) => withStat(stats, { mode: (stats.mode & ~0o777) | 0o666 });

    const result = await replace(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("metadata-not-preserved");
    expect(modeOf(dir)).toBe(0o640);
    expect(read(dir)).toBe(before);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("carries no secret in a metadata refusal", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `API_KEY=${EXISTING}\n`);
    hooks.tempStat = (stats) => withStat(stats, { uid: stats.uid + 1 });
    const serialized = JSON.stringify(await replace(dir));
    expect(serialized).not.toContain(INCOMING);
    expect(serialized).not.toContain(EXISTING);
  });
});

describe("append is gated on the same snapshot as a replacement", () => {
  // Append is a mutation too. The block it is about to write was decided from
  // a file that may have moved on, and none of these changes the inode — so
  // none is caught by the descriptor check alone.

  async function append(dir: string) {
    return applyAssignment({ root: dir }, KEY, { approvedReplacement: false });
  }

  it("refuses when the bytes changed under it", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `OTHER=${EXISTING}\n`);
    const edited = `OTHER=${EXISTING}\nEDITOR_ADDED=1\n`;
    hooks.afterInspectionRead = () => editInPlace(dir, edited);

    const result = await append(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("target-changed");
    expect(result.targetMayHaveChanged).toBe(false);
    // No secret was appended.
    expect(read(dir)).toBe(edited);
    expect(read(dir)).not.toContain(INCOMING);
  });

  it("refuses when only the terminal newline changed", async () => {
    // The separator RepoBD would write depends on this, so a stale reading
    // produces a joined or double-spaced line.
    const dir = await workspace();
    writeFileSync(envPath(dir), `OTHER=${EXISTING}\n`);
    hooks.afterInspectionRead = () => editInPlace(dir, `OTHER=${EXISTING}`);

    const result = await append(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("target-changed");
    expect(read(dir)).toBe(`OTHER=${EXISTING}`);
    expect(read(dir)).not.toContain(INCOMING);
  });

  it("refuses when the target key appeared after inspection", async () => {
    // The regression that matters most: appending now would create a
    // duplicate of a key somebody else just set.
    const dir = await workspace();
    writeFileSync(envPath(dir), `OTHER=${EXISTING}\n`);
    const edited = `OTHER=${EXISTING}\nAPI_KEY=${EXISTING}\n`;
    hooks.afterInspectionRead = () => editInPlace(dir, edited);

    const result = await append(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("target-changed");
    expect(read(dir)).toBe(edited);
    expect(read(dir)).not.toContain(INCOMING);
  });

  it("refuses when the mode changed under it", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `OTHER=${EXISTING}\n`);
    chmodSync(envPath(dir), 0o600);
    hooks.afterInspectionRead = () => chmodSync(envPath(dir), 0o644);

    const result = await append(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("target-changed");
    expect(modeOf(dir)).toBe(0o644);
    expect(read(dir)).not.toContain(INCOMING);
  });

  it("refuses when the group changed under it", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `OTHER=${EXISTING}\n`);
    const realGid = statSync(envPath(dir)).gid;
    // Substituted at the boundary: changing the gid for real needs membership
    // of a second group, which is not guaranteed on a build machine.
    let seen = 0;
    hooks.lateLstat = (stats) => {
      seen += 1;
      // The first lstat is the inspection; the gate's is the second.
      return seen > 1 ? withStat(stats, { gid: realGid + 1 }) : stats;
    };
    tempOpened = true;

    const result = await append(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("target-changed");
    expect(read(dir)).not.toContain(INCOMING);
  });

  it("appends when nothing changed", async () => {
    // The gate must not block the ordinary case.
    const dir = await workspace();
    writeFileSync(envPath(dir), `OTHER=${EXISTING}\n`);
    const result = await append(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("append");
    }
    expect(read(dir)).toBe(`OTHER=${EXISTING}\nAPI_KEY=${INCOMING}\n`);
  });

  it("carries no secret in the refusal", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `OTHER=${EXISTING}\n`);
    hooks.afterInspectionRead = () => editInPlace(dir, `OTHER=${EXISTING}\nX=1\n`);
    const serialized = JSON.stringify(await append(dir));
    expect(serialized).not.toContain(INCOMING);
    expect(serialized).not.toContain(EXISTING);
  });
});

describe("the temp file's metadata is settled before the secret is written", () => {
  // The secret must never sit on disk in a file whose ownership and
  // permissions RepoBD has not yet established and checked.

  it("establishes and verifies metadata before the first secret-bearing write", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `API_KEY=${EXISTING}\n`);

    const result = await replace(dir);
    expect(result.ok).toBe(true);

    const firstWrite = tempOps.findIndex((op) => op === "writeFile" || op === "write");
    expect(firstWrite).toBeGreaterThan(-1);
    // Ownership, permissions, and the read-back that checks them all precede
    // the write. This is the ordering, asserted as behaviour.
    for (const op of ["chown", "chmod", "stat"]) {
      const at = tempOps.indexOf(op);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(firstWrite);
    }
    // And the file is created before any of it.
    expect(tempOps.indexOf("open")).toBe(0);
  });

  it("writes no secret bytes at all when metadata cannot be established", async () => {
    const dir = await workspace();
    const before = `API_KEY=${EXISTING}\n`;
    writeFileSync(envPath(dir), before);
    hooks.tempStat = (stats) => withStat(stats, { uid: stats.uid + 1 });

    const result = await replace(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("metadata-not-preserved");
    // The point of the ordering: the temp file was never written to.
    expect(tempOps).not.toContain("writeFile");
    expect(tempOps).not.toContain("write");
    expect(read(dir)).toBe(before);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("creates the temp file owner-only, before widening it to the target's mode", async () => {
    // A group-readable target: the temp must not start group-readable while
    // it is still being set up.
    const dir = await workspace();
    writeFileSync(envPath(dir), `API_KEY=${EXISTING}\n`);
    chmodSync(envPath(dir), 0o644);

    let modeAtCreation: number | null = null;
    hooks.onTempOpen = () => {
      const temp = readdirSync(dir).find((f) => f.includes(".repobd-"));
      if (temp !== undefined) {
        modeAtCreation = statSync(path.join(dir, temp)).mode & 0o7777;
      }
    };

    const result = await replace(dir);
    expect(result.ok).toBe(true);
    // Created narrower than the target, and empty at that moment.
    expect(modeAtCreation).toBe(0o600);
    // Widened to the target's own mode by the end.
    expect(modeOf(dir)).toBe(0o644);
  });
});

describe("a temp path this invocation did not create is never removed", () => {
  it("does not unlink on EEXIST", async () => {
    const dir = await workspace();
    const before = `API_KEY=${EXISTING}\n`;
    writeFileSync(envPath(dir), before);

    hooks.tempExists = true;

    const result = await replace(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("write-failed");
    // The behaviour, not the source: nothing was unlinked, because this
    // invocation never created the path it would have unlinked.
    expect(unlinked).toEqual([]);
    expect(read(dir)).toBe(before);
    expect(entries(dir)).toEqual([".env"]);
  });

  it("does unlink the temp file it did create", async () => {
    // The other side of the branch, so the test above is not passing merely
    // because cleanup never happens at all.
    const dir = await workspace();
    writeFileSync(envPath(dir), `API_KEY=${EXISTING}\n`);
    hooks.onTempOpen = () => editInPlace(dir, `API_KEY=${EXISTING}\nX=1\n`);

    await replace(dir);
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toContain(".repobd-");
  });
});

describe("a target owned by another user is refused", () => {
  it("refuses to replace it, and writes nothing", async () => {
    // Producing a file owned by someone else needs privilege, so the uid is
    // substituted at the boundary. The behaviour under test is RepoBD's, not
    // the filesystem's.
    const dir = await workspace();
    const before = `API_KEY=${EXISTING}\n`;
    writeFileSync(envPath(dir), before);
    const realUid = statSync(envPath(dir)).uid;

    // From the very first lstat this time, not only after the temp exists.
    tempOpened = true;
    hooks.lateLstat = (stats) => withStat(stats, { uid: realUid + 1 });

    const result = await replace(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("foreign-owner");
    expect(result.targetMayHaveChanged).toBe(false);
    expect(read(dir)).toBe(before);
    expect(entries(dir)).toEqual([".env"]);
    // Refused before any temp file was prepared.
    expect(unlinked).toEqual([]);
  });

  it("names the file and the key but no value", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `API_KEY=${EXISTING}\n`);
    const realUid = statSync(envPath(dir)).uid;
    tempOpened = true;
    hooks.lateLstat = (stats) => withStat(stats, { uid: realUid + 1 });

    const result = await replace(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.detail).toContain(ENV_FILENAME);
    expect(result.detail).not.toContain(INCOMING);
    expect(result.detail).not.toContain(EXISTING);
  });

  it("still appends to a file owned by another user", async () => {
    // Append does not rename, so it does not change ownership, and is
    // deliberately not gated on it.
    const dir = await workspace();
    writeFileSync(envPath(dir), `OTHER=${EXISTING}\n`);
    const realUid = statSync(envPath(dir)).uid;
    tempOpened = true;
    hooks.lateLstat = (stats) => withStat(stats, { uid: realUid + 1 });

    const result = await applyAssignment({ root: dir }, KEY, {
      approvedReplacement: false,
    });
    expect(result.ok).toBe(true);
    expect(read(dir)).toBe(`OTHER=${EXISTING}\nAPI_KEY=${INCOMING}\n`);
  });
});
