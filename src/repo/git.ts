// RepoBD local repository resolution — reads the current repository's
// identity from Git, read-only.
//
// This is the only module in `src/repo` that performs I/O, and the I/O it
// performs is three Git subprocesses that read. Git is asked rather than
// re-implemented: `.git/config` is never parsed here, `url.<base>.insteadOf`
// is never expanded here, and no global or system configuration is inspected
// by hand. `git remote get-url` already applies that rewriting, so what comes
// back is the URL Git itself would contact.
//
// Read-only is a boundary, not an intention. Every command RepoBD may run is
// listed in `GIT_COMMANDS`, no argument is ever built from untrusted input,
// and no shell is involved: `execFile` takes an executable and a fixed argv,
// so there is nothing for a remote URL or a path to be interpolated into.
//
// What leaves this module is the canonical identity and nothing else. The
// origin URL itself is deliberately not returned: a remote URL can carry a
// token in its userinfo, and there is no product need for the raw string.
//
// Nothing here contacts a network, resolves DNS, calls a provider API, checks
// that a repository exists, or reads a secret. Identity comes from local Git
// configuration alone, which makes it a context guardrail rather than
// authentication — a compromised OS, Git binary, or local configuration
// remains outside the threat model. See docs/THREAT_MODEL.md.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  canonicalizeSupportedRemote,
  type CanonicalRepo,
} from "./identity.js";

const execFileAsync = promisify(execFile);

const GIT_EXECUTABLE = "git";

/**
 * Every Git invocation RepoBD is allowed to make, as complete argument lists.
 *
 * Exported so the read-only boundary is a value a test can assert against
 * rather than a claim in a comment. The tests pin this object exactly, so a
 * fourth command — or a changed argument — fails them until it is
 * deliberately approved. Nothing is appended at call time.
 */
export const GIT_COMMANDS = {
  /** Prints `true` only inside a work tree — not in a bare repository, and
   * not inside a `.git` directory. */
  isInsideWorkTree: ["rev-parse", "--is-inside-work-tree"],
  /**
   * The configured `remote.origin.url` values, NUL-framed.
   *
   * Read only to establish how many URLs are configured. `-z` matters: a
   * configured URL may itself contain a newline, so newline-separated output
   * cannot tell one URL containing a line break from two URLs.
   */
  configuredOriginUrls: ["config", "-z", "--get-all", "remote.origin.url"],
  /** The single effective fetch URL, with Git's own `insteadOf` rewriting
   * applied. Deliberately without `--all`: this reads one value. */
  effectiveOriginUrl: ["remote", "get-url", "origin"],
} as const;

/**
 * Environment variables that select which repository Git operates on,
 * overriding or widening discovery from the working directory.
 *
 * The resolver takes an explicit `cwd` and must answer for *that* directory.
 * An inherited `GIT_DIR` silently redirects the answer to another repository
 * — verified: with `GIT_DIR` pointing at repository A, running in repository
 * B reports A's origin and still reports being inside a work tree.
 * `GIT_DISCOVERY_ACROSS_FILESYSTEM` is here for the same reason in a weaker
 * form: it lets discovery walk past a mount boundary, so a `cwd` that would
 * resolve to no repository can instead resolve to an outer parent one. Both
 * turn "no repository here" into a repository nobody chose, so both are
 * removed from the child environment.
 *
 * Nothing else is stripped. Configuration variables in particular are left
 * alone, because `insteadOf` is Git's job and must keep working; likewise
 * `GIT_CEILING_DIRECTORIES`, which can only narrow discovery and so can only
 * cause a fail-closed result, never a redirect to a different repository.
 *
 * Exported for the same reason as `GIT_COMMANDS`: the boundary should be a
 * value a test can assert against rather than a claim in a comment.
 */
export const REPOSITORY_SELECTION_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const;

/** Long enough for a cold local Git, short enough that a wedged process does
 * not hang a CLI run. A guardrail against malformed local behavior, not
 * against a hostile machine. */
const GIT_TIMEOUT_MS = 5_000;

/** A remote URL is a few hundred bytes. Anything approaching this is not
 * output RepoBD knows how to read. */
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * `git config --get-all` exits 1 when the key is not set. This is the one
 * exit status attributed to a specific meaning, because it is documented for
 * this command and carries no other reading here. Fatal statuses such as 128
 * are deliberately *not* interpreted — Git uses them for many failures, and
 * claiming one of them means "not a repository" would assert something Git
 * did not say.
 */
const GIT_EXIT_CONFIG_KEY_ABSENT = 1;

export type RepoResolutionFailureReason =
  | "not-a-repository"
  | "no-origin"
  | "multiple-origin-urls"
  | "malformed-origin-url"
  | "unsupported-origin"
  | "git-unavailable"
  | "git-timeout"
  | "git-output-too-large"
  | "git-failed";

export type RepoResolution =
  | { readonly ok: true; readonly repo: CanonicalRepo }
  | {
      readonly ok: false;
      readonly reason: RepoResolutionFailureReason;
      readonly detail: string;
    };

function fail(
  reason: RepoResolutionFailureReason,
  detail: string,
): RepoResolution {
  return { ok: false, reason, detail };
}

/**
 * How a Git invocation failed, reduced to the cases RepoBD distinguishes.
 * The child-process error object itself never crosses this boundary.
 */
type GitFailure =
  | { readonly kind: "unavailable" }
  | { readonly kind: "timeout" }
  | { readonly kind: "output-too-large" }
  | { readonly kind: "exit"; readonly code: number | null };

type GitRun =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly failure: GitFailure };

/**
 * Reduces a child-process rejection to a `GitFailure`.
 *
 * Node reports spawn problems as a string `code` and a process exit as a
 * numeric one, so the two are told apart by type rather than by value.
 * `stderr` is deliberately dropped: it is subprocess detail, and the caller
 * composes its own message.
 */
function classifyGitFailure(error: unknown): GitFailure {
  const details = error as {
    code?: unknown;
    killed?: unknown;
  };
  if (details.code === "ENOENT") {
    return { kind: "unavailable" };
  }
  if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { kind: "output-too-large" };
  }
  // execFile kills the child when the timeout elapses.
  if (details.killed === true) {
    return { kind: "timeout" };
  }
  return {
    kind: "exit",
    code: typeof details.code === "number" ? details.code : null,
  };
}

/**
 * The child's environment: the current one, minus the variables that would
 * let it answer for a repository other than `cwd`.
 *
 * Exported so a test can inspect the environment Git is actually handed,
 * including for cases whose effect on Git depends on a mount boundary and so
 * cannot be reproduced in an ordinary temporary directory.
 */
export function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of REPOSITORY_SELECTION_ENV) {
    delete env[name];
  }
  return env;
}

/**
 * Runs one allowlisted Git command.
 *
 * `execFile` is used rather than `exec`, and no `shell` option is passed, so
 * the argument list reaches Git as-is and no shell metacharacter can be
 * interpreted. `args` comes only from `GIT_COMMANDS`; `cwd` is the child's
 * working directory, never an argument.
 */
async function runGit(cwd: string, args: readonly string[]): Promise<GitRun> {
  try {
    const { stdout } = await execFileAsync(GIT_EXECUTABLE, [...args], {
      cwd,
      env: childEnvironment(),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
      encoding: "utf8",
      windowsHide: true,
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, failure: classifyGitFailure(error) };
  }
}

/**
 * Reports a Git invocation failure without inferring meaning from a fatal
 * exit status. An exit RepoBD has no documented reading for is reported as
 * what it is: Git failed.
 */
function gitFailure(failure: GitFailure): RepoResolution {
  switch (failure.kind) {
    case "unavailable":
      return fail("git-unavailable", "git could not be run");
    case "timeout":
      return fail("git-timeout", "git did not finish within the time limit");
    case "output-too-large":
      return fail(
        "git-output-too-large",
        "git produced more output than RepoBD will read",
      );
    case "exit":
      return fail("git-failed", `git exited with status ${String(failure.code)}`);
  }
}

/**
 * Splits NUL-framed `git config -z` output. Each value is terminated — not
 * separated — by a NUL, so well-formed non-empty output always ends with one.
 * Returns null if it does not, rather than guessing at the framing.
 */
function parseNulFramed(output: string): string[] | null {
  if (output === "") {
    return [];
  }
  if (!output.endsWith("\0")) {
    return null;
  }
  return output.slice(0, -1).split("\0");
}

/** Removes the single line ending Git appends, and nothing else. */
function stripTerminalNewline(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  if (value.endsWith("\n")) {
    return value.slice(0, -1);
  }
  return value;
}

/**
 * Resolves the supported hosted-repository identity of the repository
 * containing `cwd`.
 *
 * Repository discovery is Git's own, so an ordinary clone and a linked
 * worktree both resolve, and the filesystem path is never the identity. The
 * checked-out branch, a detached HEAD, and the current commit are all
 * irrelevant — none of them is read.
 *
 * `origin` is authoritative. There is no fallback to `upstream`, to the first
 * remote, or to any other guess: a repository without `origin` fails closed,
 * because continuing without a binding is exactly the accident RepoBD exists
 * to prevent.
 *
 * v0.1 supports exactly one configured fetch URL for `origin`. Two URLs are
 * refused rather than reconciled — `git remote get-url` without `--all` would
 * silently return only the first, so an origin naming two repositories would
 * otherwise resolve to whichever came first. That is a guess, and this is the
 * one place a guess would deliver a secret somewhere nobody chose.
 */
export async function resolveCurrentRepoIdentity(
  cwd: string,
): Promise<RepoResolution> {
  const workTree = await runGit(cwd, GIT_COMMANDS.isInsideWorkTree);
  if (!workTree.ok) {
    return gitFailure(workTree.failure);
  }
  // Only a successful `false` proves the absence of a work tree. That covers
  // a bare repository and a directory inside `.git`; neither has a work tree
  // to apply a secret to.
  if (workTree.stdout.trim() !== "true") {
    return fail("not-a-repository", "the current directory has no Git work tree");
  }

  const configured = await runGit(cwd, GIT_COMMANDS.configuredOriginUrls);
  if (!configured.ok) {
    if (
      configured.failure.kind === "exit" &&
      configured.failure.code === GIT_EXIT_CONFIG_KEY_ABSENT
    ) {
      return fail("no-origin", "the repository has no origin remote");
    }
    return gitFailure(configured.failure);
  }
  const configuredUrls = parseNulFramed(configured.stdout);
  if (configuredUrls === null) {
    return fail("malformed-origin-url", "git produced unframed config output");
  }
  if (configuredUrls.length === 0) {
    return fail("no-origin", "the repository has no origin remote");
  }
  if (configuredUrls.length > 1) {
    return fail(
      "multiple-origin-urls",
      "origin has more than one configured fetch URL",
    );
  }

  // Read the effective URL separately: the configured value is not the
  // identity, because `insteadOf` rewriting is Git's to apply and RepoBD
  // implements none of its own.
  const effective = await runGit(cwd, GIT_COMMANDS.effectiveOriginUrl);
  if (!effective.ok) {
    return gitFailure(effective.failure);
  }
  const originUrl = stripTerminalNewline(effective.stdout);
  // Exactly one line ending was Git's. A line break still present belongs to
  // the value itself, which no supported remote has and which would make the
  // output ambiguous to read.
  if (/[\r\n]/.test(originUrl)) {
    return fail(
      "malformed-origin-url",
      "origin URL contains an embedded line break",
    );
  }
  // Beyond that one line ending, the effective URL must be exactly what Git
  // returned. `canonicalizeSupportedRemote` trims its input because it also
  // serves paste-oriented parsing, and that leniency must not be borrowed
  // here: a configured origin of ` https://github.com/acme/alpha.git` is a
  // malformed remote, not the same remote with a space. Trimming it into
  // validity would let one repository have more than one accepted spelling
  // in local configuration, so it fails closed instead.
  if (originUrl !== originUrl.trim()) {
    return fail(
      "malformed-origin-url",
      "origin URL has leading or trailing whitespace",
    );
  }

  const canonical = canonicalizeSupportedRemote(originUrl);
  if (!canonical.ok) {
    // Includes the case where Git's own `insteadOf` rewriting produced an
    // effective URL outside the supported hosted profile. Failing closed
    // there is intended: the rewritten URL is where Git would actually go.
    // The URL itself is not repeated here — it may carry credentials.
    return fail(
      "unsupported-origin",
      `origin is not a supported hosted remote (${canonical.reason})`,
    );
  }

  return { ok: true, repo: canonical.repo };
}
