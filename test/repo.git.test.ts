import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GIT_COMMANDS,
  REPOSITORY_SELECTION_ENV,
  childEnvironment,
  resolveCurrentRepoIdentity,
  type RepoResolutionFailureReason,
} from "../src/repo/git.js";

// Every fixture is a throwaway repository created here. Nothing reads the
// developer's own repositories, and nothing reaches a network: no fixture is
// ever fetched, cloned from a real host, or pushed.
//
// Global and system Git configuration are switched off for this process so a
// developer's own `insteadOf` rules or defaults cannot change what these
// tests observe. That is an environment variable in the test process only —
// no configuration file of the user's is read or written.

const ISOLATION = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
} as const;

const savedEnv: Record<string, string | undefined> = {};
let root: string;

beforeAll(() => {
  for (const [key, value] of Object.entries(ISOLATION)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  root = mkdtempSync(path.join(tmpdir(), "repobd-git-"));
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(root, "case-"));
}

/** A repository with one empty commit and, optionally, an `origin`. */
async function makeRepo(originUrl?: string): Promise<string> {
  const dir = await tempDir();
  git(dir, "init", "-q", "-b", "main", ".");
  git(dir, "config", "user.name", "RepoBD Test");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  if (originUrl !== undefined) {
    git(dir, "remote", "add", "origin", originUrl);
  }
  return dir;
}

/** Runs a block with extra environment variables set on this process. */
async function withEnv(
  overrides: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function identityOf(dir: string): Promise<string> {
  const result = await resolveCurrentRepoIdentity(dir);
  if (!result.ok) {
    throw new Error(`expected resolution, got ${result.reason}: ${result.detail}`);
  }
  return result.repo.canonical;
}

async function failureOf(dir: string): Promise<RepoResolutionFailureReason> {
  const result = await resolveCurrentRepoIdentity(dir);
  if (result.ok) {
    throw new Error(`expected failure, got ${result.repo.canonical}`);
  }
  return result.reason;
}

describe("normal resolution", () => {
  it("resolves a GitHub HTTPS origin", async () => {
    const dir = await makeRepo("https://github.com/acme/widgets.git");
    expect(await identityOf(dir)).toBe("github.com/acme/widgets");
  });

  it("resolves a GitHub SSH origin to the same identity", async () => {
    const https = await makeRepo("https://github.com/acme/widgets.git");
    const scp = await makeRepo("git@github.com:acme/widgets.git");
    const uri = await makeRepo("ssh://git@github.com/acme/widgets.git");
    expect(await identityOf(scp)).toBe(await identityOf(https));
    expect(await identityOf(uri)).toBe(await identityOf(https));
  });

  it("resolves GitLab and Bitbucket origins", async () => {
    const gitlab = await makeRepo("https://gitlab.com/group/sub/project.git");
    expect(await identityOf(gitlab)).toBe("gitlab.com/group/sub/project");
    const bitbucket = await makeRepo("git@bitbucket.org:team/service.git");
    expect(await identityOf(bitbucket)).toBe("bitbucket.org/team/service");
  });

  it("resolves from a subdirectory, using Git's own discovery", async () => {
    const dir = await makeRepo("https://github.com/acme/widgets.git");
    const nested = path.join(dir, "src", "deep");
    await mkdir(nested, { recursive: true });
    expect(await identityOf(nested)).toBe("github.com/acme/widgets");
  });

  it("resolves a linked worktree to the same identity", async () => {
    const dir = await makeRepo("https://github.com/acme/widgets.git");
    const worktree = path.join(root, `${path.basename(dir)}-wt`);
    git(dir, "worktree", "add", "-q", worktree, "-b", "feature");
    // The worktree lives at a different filesystem path and on a different
    // branch, and neither is identity.
    expect(await identityOf(worktree)).toBe("github.com/acme/widgets");
  });

  it("is unaffected by a detached HEAD or the branch name", async () => {
    const dir = await makeRepo("https://github.com/acme/widgets.git");
    const before = await identityOf(dir);
    git(dir, "checkout", "-q", "-b", "some/other-branch");
    expect(await identityOf(dir)).toBe(before);
    git(dir, "checkout", "-q", "--detach");
    expect(await identityOf(dir)).toBe(before);
  });

  it("gives two separate clones of one remote the same identity", async () => {
    const first = await makeRepo("https://github.com/acme/widgets.git");
    const second = await makeRepo("git@github.com:acme/widgets.git");
    expect(await identityOf(second)).toBe(await identityOf(first));
  });
});

describe("the result follows cwd, not the inherited environment", () => {
  // An inherited GIT_DIR really does redirect Git: with it set to repository
  // A, plain `git remote get-url origin` run inside repository B reports A's
  // origin, and `--is-inside-work-tree` still prints true. The resolver
  // answers for the cwd it was given, so it must not inherit these.

  it("ignores an inherited GIT_DIR", async () => {
    const other = await makeRepo("https://github.com/acme/other.git");
    const target = await makeRepo("https://github.com/acme/widgets.git");
    await withEnv({ GIT_DIR: path.join(other, ".git") }, async () => {
      expect(await identityOf(target)).toBe("github.com/acme/widgets");
    });
  });

  it("ignores an inherited GIT_WORK_TREE", async () => {
    const other = await makeRepo("https://github.com/acme/other.git");
    const target = await makeRepo("https://github.com/acme/widgets.git");
    await withEnv(
      { GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other },
      async () => {
        expect(await identityOf(target)).toBe("github.com/acme/widgets");
      },
    );
  });

  it("ignores an inherited GIT_COMMON_DIR", async () => {
    const other = await makeRepo("https://github.com/acme/other.git");
    const target = await makeRepo("https://github.com/acme/widgets.git");
    await withEnv({ GIT_COMMON_DIR: path.join(other, ".git") }, async () => {
      expect(await identityOf(target)).toBe("github.com/acme/widgets");
    });
  });

  it("still fails closed for a non-repository cwd under an inherited GIT_DIR", async () => {
    const other = await makeRepo("https://github.com/acme/other.git");
    const plain = await tempDir();
    // Without the stripping this would happily report `acme/other`.
    await withEnv({ GIT_DIR: path.join(other, ".git") }, async () => {
      const result = await resolveCurrentRepoIdentity(plain);
      expect(result.ok).toBe(false);
    });
  });

  it("does not pass an inherited GIT_DISCOVERY_ACROSS_FILESYSTEM to git", async () => {
    // This variable lets discovery walk past a mount boundary, so a cwd that
    // would resolve to no repository can instead resolve to an outer parent
    // one. Its effect only appears across a real mount boundary, which a
    // temporary directory cannot provide, so the child environment Git is
    // handed is asserted directly instead of staging a mount.
    await withEnv({ GIT_DISCOVERY_ACROSS_FILESYSTEM: "true" }, async () => {
      expect(process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM).toBe("true");
      expect(childEnvironment()).not.toHaveProperty(
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
      );
    });
  });

  it("removes every repository-selection variable and nothing else", async () => {
    const other = await makeRepo("https://github.com/acme/other.git");
    await withEnv(
      {
        GIT_DIR: path.join(other, ".git"),
        GIT_WORK_TREE: other,
        GIT_COMMON_DIR: path.join(other, ".git"),
        GIT_DISCOVERY_ACROSS_FILESYSTEM: "true",
        GIT_CEILING_DIRECTORIES: root,
      },
      async () => {
        const env = childEnvironment();
        for (const name of REPOSITORY_SELECTION_ENV) {
          expect(env).not.toHaveProperty(name);
        }
        // Narrowing-only and configuration variables must survive: the first
        // can only fail closed, the second is what makes insteadOf work.
        expect(env.GIT_CEILING_DIRECTORIES).toBe(root);
        expect(env.GIT_CONFIG_GLOBAL).toBe(ISOLATION.GIT_CONFIG_GLOBAL);
        expect(env.GIT_CONFIG_SYSTEM).toBe(ISOLATION.GIT_CONFIG_SYSTEM);
      },
    );
  });

  it("leaves configuration environment alone so insteadOf keeps working", async () => {
    // GIT_CONFIG_GLOBAL is set for this whole test file; if the resolver
    // wiped Git configuration variables wholesale, the isolation these tests
    // rely on would silently stop applying.
    const dir = await makeRepo("https://github.com/acme/widgets.git");
    expect(await identityOf(dir)).toBe("github.com/acme/widgets");
  });
});

describe("repository detection failures", () => {
  it("fails closed outside a Git repository", async () => {
    const dir = await tempDir();
    // Git exits fatally here, and a fatal status covers many causes, so the
    // reason says Git failed rather than asserting something Git did not.
    expect(await failureOf(dir)).toBe("git-failed");
  });

  it("reports not-a-repository only when Git proves it", async () => {
    const bare = await tempDir();
    git(bare, "init", "-q", "--bare", ".");
    // `--is-inside-work-tree` succeeds and prints false: that is proof.
    expect(await failureOf(bare)).toBe("not-a-repository");

    const repo = await makeRepo("https://github.com/acme/widgets.git");
    expect(await failureOf(path.join(repo, ".git"))).toBe("not-a-repository");
  });
});

describe("origin rules", () => {
  it("fails closed when there is no origin", async () => {
    const dir = await makeRepo();
    expect(await failureOf(dir)).toBe("no-origin");
  });

  it("does not fall back to another remote", async () => {
    const dir = await makeRepo();
    git(dir, "remote", "add", "upstream", "https://github.com/acme/widgets.git");
    // `upstream` names a perfectly supported repository. Using it would be a
    // guess about which remote the sender meant.
    expect(await failureOf(dir)).toBe("no-origin");
  });

  it("fails closed on an unsupported host or transport", async () => {
    for (const url of [
      "https://git.internal.example/team/service.git",
      "http://github.com/acme/widgets.git",
      "git://github.com/acme/widgets.git",
      "ssh://git@github.com:2222/acme/widgets.git",
      "alice@github.com:acme/widgets.git",
      "/srv/git/widgets.git",
      "not-a-url",
    ]) {
      const dir = await makeRepo(url);
      expect(await failureOf(dir)).toBe("unsupported-origin");
    }
  });

  it("fails closed on an empty origin URL", async () => {
    const dir = await makeRepo();
    git(dir, "config", "remote.origin.url", "");
    expect(await failureOf(dir)).toBe("unsupported-origin");
  });
});

describe("origin URL cardinality", () => {
  it("accepts exactly one configured URL", async () => {
    const dir = await makeRepo("https://github.com/acme/widgets.git");
    expect(await identityOf(dir)).toBe("github.com/acme/widgets");
  });

  it("fails closed on more than one configured URL", async () => {
    const dir = await makeRepo("https://github.com/acme/widgets.git");
    git(dir, "remote", "set-url", "--add", "origin", "git@github.com:acme/widgets.git");
    // Even though both spellings name the same repository, v0.1 supports one
    // configured URL. `git remote get-url` without `--all` would silently
    // return only the first, so reconciling here would mean trusting an
    // order nobody chose.
    expect(await failureOf(dir)).toBe("multiple-origin-urls");
  });

  it("fails closed when two configured URLs name different repositories", async () => {
    const dir = await makeRepo("https://github.com/acme/widgets.git");
    git(dir, "remote", "set-url", "--add", "origin", "https://github.com/acme/gadgets.git");
    expect(await failureOf(dir)).toBe("multiple-origin-urls");
  });

  it("counts a URL containing a newline as one value, then rejects it", async () => {
    const dir = await makeRepo();
    // Git accepts this. Newline-separated output would read it as two URLs;
    // NUL framing sees the one value it really is, and the embedded line
    // break then fails the effective-URL check.
    git(
      dir,
      "config",
      "remote.origin.url",
      "https://github.com/acme/widgets.git\nhttps://github.com/evil/takeover.git",
    );
    expect(await failureOf(dir)).toBe("malformed-origin-url");
  });
});

describe("insteadOf rewriting", () => {
  it("honours Git's rewriting rather than the stored URL", async () => {
    const dir = await makeRepo("https://github.com/acme/widgets.git");
    git(dir, "config", "url.git@github.com:.insteadOf", "https://github.com/");
    // RepoBD implements no rewriting of its own: Git expands this in
    // `remote get-url`, and RepoBD consumes the effective URL. Both spellings
    // name the same hosted repository, so the identity is unchanged.
    expect(await identityOf(dir)).toBe("github.com/acme/widgets");
    // The stored URL is not what was read.
    expect(git(dir, "config", "--get", "remote.origin.url").trim()).toBe(
      "https://github.com/acme/widgets.git",
    );
  });

  it("fails closed when rewriting produces an unsupported URL", async () => {
    const dir = await makeRepo("https://github.com/acme/widgets.git");
    git(
      dir,
      "config",
      "url.https://git.internal.example/.insteadOf",
      "https://github.com/",
    );
    // Intended: the rewritten URL is where Git would actually go, so the
    // stored spelling does not earn the delivery.
    expect(await failureOf(dir)).toBe("unsupported-origin");
  });
});

describe("the raw origin URL never leaves the resolver", () => {
  const SENSITIVE = "ghp_sensitive_value";

  it("keeps userinfo out of a successful result", async () => {
    const dir = await makeRepo(
      `https://${SENSITIVE}@github.com/acme/widgets.git`,
    );
    const result = await resolveCurrentRepoIdentity(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // A remote URL can carry a token in its userinfo, so the success object
    // carries the identity and nothing else.
    expect(JSON.stringify(result)).not.toContain(SENSITIVE);
    expect(Object.keys(result).sort()).toEqual(["ok", "repo"]);
    expect(result.repo.canonical).toBe("github.com/acme/widgets");
  });

  it("keeps the URL out of a failure detail", async () => {
    const dir = await makeRepo(
      `https://${SENSITIVE}@git.internal.example/acme/widgets.git`,
    );
    const result = await resolveCurrentRepoIdentity(dir);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(JSON.stringify(result)).not.toContain(SENSITIVE);
  });
});

describe("command safety", () => {
  const source = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/repo/git.ts",
    ),
    "utf8",
  );

  it("pins the complete Git command allowlist", () => {
    // Asserted exactly, not by absence of known-bad verbs: a fourth command,
    // or a changed argument, fails here until it is deliberately approved.
    expect(GIT_COMMANDS).toEqual({
      isInsideWorkTree: ["rev-parse", "--is-inside-work-tree"],
      configuredOriginUrls: [
        "config",
        "-z",
        "--get-all",
        "remote.origin.url",
      ],
      effectiveOriginUrl: ["remote", "get-url", "origin"],
    });
    expect(Object.keys(GIT_COMMANDS)).toHaveLength(3);
  });

  it("reads origin config with NUL framing and reads one effective URL", () => {
    // `-z` is what tells one URL containing a newline from two URLs.
    expect(GIT_COMMANDS.configuredOriginUrls).toContain("-z");
    // `--all` would turn the effective read back into an ambiguous list.
    expect(GIT_COMMANDS.effectiveOriginUrl).not.toContain("--all");
  });

  it("strips only repository-selection environment variables", () => {
    expect([...REPOSITORY_SELECTION_ENV]).toEqual([
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    ]);
    for (const name of REPOSITORY_SELECTION_ENV) {
      expect(source).toContain(name);
    }
    // Configuration variables must survive, or Git-native insteadOf breaks.
    expect(source).not.toMatch(/delete\s+env\["GIT_CONFIG/);
    // GIT_CEILING_DIRECTORIES only narrows discovery, so it stays.
    expect([...REPOSITORY_SELECTION_ENV]).not.toContain(
      "GIT_CEILING_DIRECTORIES",
    );
  });

  it("uses no shell and no other process API", () => {
    // execFile with a fixed argv is the whole point: there is no shell for a
    // remote URL or a path to be interpreted by.
    expect(source).not.toMatch(/\bshell\s*:/);
    expect(source).not.toMatch(/\bexec\(/);
    expect(source).not.toMatch(/\bspawn\(/);
    expect(source).not.toMatch(/\bexecSync\b/);
    expect(source).not.toMatch(/\bspawnSync\b/);
    expect(source).not.toMatch(/\bexecFileSync\b/);
  });

  it("keeps its subprocess bounds", () => {
    expect(source).toMatch(/timeout:/);
    expect(source).toMatch(/maxBuffer:/);
  });

  it("opens no network and calls no provider API", () => {
    expect(source).not.toMatch(/node:net|node:http|node:dns/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/api\.github\.com|gitlab\.com\/api/);
  });

  it("reports git-unavailable when git cannot be run", async () => {
    const dir = await makeRepo("https://github.com/acme/widgets.git");
    await withEnv({ PATH: path.join(root, "no-such-bin") }, async () => {
      const result = await resolveCurrentRepoIdentity(dir);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toBe("git-unavailable");
    });
  });
});
