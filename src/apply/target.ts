// RepoBD safe local apply — the filesystem trust boundary.
//
// This is the first Phase 4 module allowed to touch the filesystem, and the
// only place in RepoBD that writes a secret anywhere. Everything it may write
// is one path:
//
//   <verified work tree root>/.env
//
// The precondition, stated as a precondition rather than as a proof: this
// module is given a work tree root and composes the target itself, and there
// is no CLI option, argument, payload field, or other user surface anywhere in
// RepoBD that supplies a path. Phase 4C must pass the root straight from the
// successful repository resolution that cleared the Phase 3 guard. This module
// cannot verify that it did — `VerifiedWorkTree` is a shape, not evidence —
// and it does not claim traversal is impossible on its own account. What it
// does claim is narrower and true: it never joins a caller-supplied path
// fragment onto the target, so nothing it does can widen the target beyond the
// `.env` of the root it was handed.
//
// What this module refuses, before writing anything:
//
//   - a `.env` that is a symlink, of any kind, pointing anywhere        (25)
//   - a `.env` that is a directory, FIFO, socket, or device
//   - an existing `.env` whose state for this key cannot be read confidently
//   - an assignment that does not satisfy the v0.1 grammar at this boundary
//   - a `.env` owned by someone else, when replacement is requested
//   - a replacement the caller has not explicitly approved              (27)
//   - a replacement whose metadata or bytes changed since it was planned
//
// What it does not attempt: resistance to a local attacker racing the
// filesystem. The `O_NOFOLLOW`, identity, metadata and byte re-checks below
// close the window on an *accident* — a symlink appearing where a regular file
// was, an editor saving in place, a `chmod` from another terminal. A malicious
// local user, a compromised OS, and a modified Git or RepoBD binary remain
// outside the v0.1 threat model. See docs/THREAT_MODEL.md.
//
// Deciding *whether* to replace is not this module's job. It performs a
// replacement only when the caller passes an already-granted approval, and
// otherwise reports that confirmation is required. The prompt belongs to a
// later slice.
//
// The settled v0.1 product rule, which the refusals above implement:
//
//   RepoBD v0.1 supports automatic `.env` modification only for a
//   conservative single-line assignment subset. Files using syntax RepoBD
//   cannot interpret unambiguously are left unchanged.
//
//   RepoBD never guesses how loader-dependent or compound `.env` syntax
//   should be interpreted.
//
// The subset itself is defined, and enforced as an allowlist, in
// `env-file.ts`. It is deliberately small: blank lines, full-line comments,
// and one assignment per physical line, whose value is either a bare run of
// the characters `payload.ts` permits or a simple single-line quoted run —
// the quoted form being readable but not something RepoBD ever writes.
//
// What the round trip rests on is narrower than the whole subset: the *bare*
// form uses exactly the payload alphabet, so a canonical `KEY=value` RepoBD
// writes is by construction a line RepoBD reads back with the same key and
// literal value, and a successful apply can never leave a file that its own
// retry refuses.
//
// This is an intentional product boundary, not a gap. RepoBD does not promise
// generic dotenv-loader compatibility, and refusing costs a developer one
// manual edit while guessing costs them a corrupted `.env` or a secret in the
// wrong place. A commented-out historical key is left exactly where it is.
//
// RELEASE REQUIREMENT, recorded here so it is not lost: public v0.1
// documentation must state this boundary plainly — that RepoBD handles one
// secret at a time as one `KEY=value` assignment, auto-updates an existing
// `.env` only when exactly one active single-line target assignment can be
// identified unambiguously, and otherwise refuses without modifying the file
// or consuming the delivery. That documentation is not written in this slice.
//
// The metadata guarantee, stated narrowly because it is worth not overclaiming:
//
//   RepoBD v0.1 supports ordinary developer-owned regular `.env` files. Within
//   that boundary a replacement preserves uid, gid and the POSIX permission
//   mode, and fails closed if it cannot. It does not guarantee preservation of
//   arbitrary ACLs, extended attributes, or exotic filesystem metadata.
//
// A replace is a rename over the original, so the result carries whatever
// metadata RepoBD put on the temp file. Mode, uid and gid are therefore set on
// the temp file explicitly and then *verified by reading them back* — nothing
// is renamed into place on the strength of a syscall having been issued. No
// privileged operation is attempted: the ordinary case is a file the developer
// already owns, where this succeeds.
//
// No secret value — the one being applied or one already in the file — appears
// in any returned string, and no `.env` content is ever returned. The only
// filesystem artifact that may briefly hold the secret besides `.env` itself is
// the replacement temp file, which lives beside `.env`, carries the target's
// own metadata, and either becomes `.env` through rename or is removed.
// Nothing is written to /tmp, to `.git`, to a backup file, or to a log.

import { constants, type Stats } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { inspectEnvFile, type EnvFileStyle } from "./env-file.js";
import { validateAssignment, type ApplyAssignment } from "./payload.js";

/** The one filename RepoBD v0.1 may write. */
export const ENV_FILENAME = ".env";

/**
 * Where RepoBD is allowed to write, as produced by repository resolution.
 *
 * An object rather than a bare path string, so Phase 4C passes the resolver's
 * own successful result straight through instead of assembling a root from
 * somewhere else. This is a shape, not a proof — TypeScript's structural
 * typing is not authentication, and this module cannot verify where a root
 * came from. The invariant it depends on is upstream and stays there:
 *
 *   The root comes from the successful local repository resolution that
 *   passed the Phase 3 guard, and from nowhere else.
 */
export interface VerifiedWorkTree {
  /** Absolute path of the verified work tree root. */
  readonly root: string;
}

/**
 * `O_NOFOLLOW` where the platform defines it, and nothing where it does not.
 * The `lstat`/`fstat` identity check below does not depend on it, so a
 * platform without it is a weaker accident guard rather than an open door.
 */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Mode requested for a `.env` RepoBD creates. Never applied to a file that
 * already exists — an existing file keeps the permissions it has. */
const CREATE_MODE = 0o600;

/** Permission bits RepoBD preserves: the ordinary POSIX ones, including the
 * setuid/setgid/sticky bits, so a replacement cannot silently drop them. */
const MODE_MASK = 0o7777;

/**
 * The path RepoBD may write, for a verified work tree root.
 *
 * Exported so a test can assert the construction rather than infer it, and so
 * there is exactly one expression in the codebase that names a write target.
 */
export function envTargetPath(root: string): string {
  return path.join(root, ENV_FILENAME);
}

/** What acting on the target would do. */
export type TargetAction =
  /** No `.env` exists; create one. */
  | "create"
  /** `.env` exists and does not set the key; append one line. */
  | "append"
  /** `.env` already sets the key to exactly this value; write nothing. */
  | "noop-success"
  /** `.env` sets the key to something else; replacing needs approval. */
  | "replace";

export type TargetFailureReason =
  /** The assignment did not satisfy the v0.1 grammar at the write boundary. */
  | "invalid-assignment"
  /** Not a regular file: symlink, directory, FIFO, socket, device. */
  | "unsafe-target"
  /** `.env` is not owned by the user running RepoBD. */
  | "foreign-owner"
  /** `.env` exists but its state for this key cannot be read confidently. */
  | "ambiguous-existing-file"
  /** `.env`'s bytes or metadata changed between being read and being written. */
  | "target-changed"
  /** The replacement could not be given the original's uid, gid, or mode. */
  | "metadata-not-preserved"
  /** `.env` could not be read. */
  | "read-failed"
  /** The write did not complete. */
  | "write-failed"
  /** The write completed but reading it back did not prove the value. */
  | "verification-failed"
  /** A replacement is required and the caller granted no approval. */
  | "confirmation-required";

export interface TargetInspection {
  readonly path: string;
}

export type InspectResult =
  | (TargetInspection & {
      readonly ok: true;
      readonly action: TargetAction;
      readonly style: EnvFileStyle;
    })
  | (TargetInspection & {
      readonly ok: false;
      readonly reason: TargetFailureReason;
      /** Names the file and the key. Never a value, never file content. */
      readonly detail: string;
    });

export type ApplyResult =
  | (TargetInspection & {
      readonly ok: true;
      readonly action: TargetAction;
      /** `noop-success` is the only success with nothing written. */
      readonly written: boolean;
    })
  | (TargetInspection & {
      readonly ok: false;
      readonly reason: TargetFailureReason;
      readonly detail: string;
      /**
       * True when `.env` may differ from what it held before this call — a
       * partial create, a completed write whose read-back failed, or a
       * rename that landed. Never hidden: a caller reporting a failure has to
       * be able to tell the user the file may have changed anyway.
       */
      readonly targetMayHaveChanged: boolean;
    });

/**
 * Everything about the existing file a later step must find unchanged.
 *
 * Bytes *and* ordinary POSIX metadata. Identity alone is not enough — an
 * editor saving in place keeps the inode while replacing every byte, and a
 * `chmod` or `chgrp` from another terminal changes neither the inode nor the
 * bytes. Renaming over any of those would silently undo it.
 */
interface TargetSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly bytes: Buffer;
}

/** Whether a file carries exactly the ordinary POSIX metadata recorded. */
function metadataMatches(stats: Stats, snapshot: TargetSnapshot): boolean {
  return (
    stats.uid === snapshot.uid &&
    stats.gid === snapshot.gid &&
    (stats.mode & MODE_MASK) === snapshot.mode
  );
}

function snapshotOf(stats: Stats, bytes: Buffer): TargetSnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
    uid: stats.uid,
    gid: stats.gid,
    mode: stats.mode & MODE_MASK,
    bytes,
  };
}

/**
 * The UTF-8 byte-order mark.
 *
 * It matters because `TextDecoder` silently *removes* a leading BOM, so a file
 * that carries one decodes to text that does not, and rebuilding the file from
 * that text would delete three bytes RepoBD was never asked to touch. It is
 * therefore split off before decoding and put back byte-for-byte on
 * replacement. A file without one never gains one.
 *
 * This is not encoding detection: RepoBD v0.1 is UTF-8 only, and a BOM is the
 * one byte sequence a UTF-8 file may legitimately carry that does not survive
 * a decode/encode round trip.
 */
const UTF8_BOM = "﻿";

function hasUtf8Bom(bytes: Buffer): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  );
}

function newlineOf(style: EnvFileStyle): string {
  return style.newline === "crlf" ? "\r\n" : "\n";
}

function assignmentLine(key: string, value: string): string {
  return `${key}=${value}`;
}

/**
 * `lstat`, which never follows a symlink, so a symlinked `.env` is seen as the
 * symlink it is rather than as whatever it points at.
 */
async function lstatTarget(target: string): Promise<Stats | null | "error"> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return "error";
  }
}

/** Names the kind of non-regular file found, without dumping a stat object. */
function describeUnsafe(stats: Stats): string {
  if (stats.isSymbolicLink()) {
    return `${ENV_FILENAME} is a symlink; RepoBD will not write through it`;
  }
  if (stats.isDirectory()) {
    return `${ENV_FILENAME} is a directory`;
  }
  if (stats.isFIFO()) {
    return `${ENV_FILENAME} is a FIFO`;
  }
  if (stats.isSocket()) {
    return `${ENV_FILENAME} is a socket`;
  }
  if (stats.isBlockDevice() || stats.isCharacterDevice()) {
    return `${ENV_FILENAME} is a device file`;
  }
  return `${ENV_FILENAME} is not a regular file`;
}

/**
 * Decodes `.env` strictly.
 *
 * Fatal decoding, not replacement characters: a replace rewrites the whole
 * file, and rewriting bytes that were silently turned into U+FFFD would
 * corrupt content RepoBD was never asked to touch. A file RepoBD cannot decode
 * is a file whose key state it cannot honestly report.
 */
function decodeEnv(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Serializes a parsed `.env` back to bytes, BOM included. */
function rebuildEnv(
  bom: boolean,
  lines: readonly string[],
  newline: string,
  endsWithNewline: boolean,
): Buffer {
  return Buffer.from(
    (bom ? UTF8_BOM : "") +
      lines.join(newline) +
      (endsWithNewline ? newline : ""),
    "utf8",
  );
}

interface ExistingEnv {
  readonly lines: string[];
  readonly style: EnvFileStyle;
  readonly action: Exclude<TargetAction, "create">;
  readonly lineIndex: number | null;
  readonly bom: boolean;
  readonly snapshot: TargetSnapshot;
}

type ExistingResult =
  | { readonly ok: true; readonly existing: ExistingEnv }
  | {
      readonly ok: false;
      readonly reason: TargetFailureReason;
      readonly detail: string;
    };

/**
 * The state of the existing file, or a refusal.
 *
 * Splitting the file into lines is done once here and reused by the replace
 * path, together with a byte-level round-trip check: the lines rejoined with
 * the detected ending, BOM included, must reproduce the file exactly. If they
 * do not, RepoBD's reading disagrees with the file, and rewriting it would
 * move bytes it was never asked to move.
 */
async function readExisting(
  target: string,
  stats: Stats,
  key: string,
  value: string,
): Promise<ExistingResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch {
    return {
      ok: false,
      reason: "read-failed",
      detail: `${ENV_FILENAME} could not be read`,
    };
  }

  const bom = hasUtf8Bom(bytes);
  const text = decodeEnv(bom ? bytes.subarray(3) : bytes);
  if (text === null) {
    return {
      ok: false,
      reason: "ambiguous-existing-file",
      detail: `${ENV_FILENAME} is not valid UTF-8`,
    };
  }

  const inspection = inspectEnvFile(text, key, value);
  if (!inspection.ok) {
    return {
      ok: false,
      reason: "ambiguous-existing-file",
      // Phase 4A's detail already names only the file and the validated key.
      detail: inspection.detail,
    };
  }

  const style = inspection.style;
  const newline = newlineOf(style);
  const lines = text.split(/\r\n|\n/);
  if (style.endsWithNewline) {
    lines.pop();
  }
  if (!rebuildEnv(bom, lines, newline, style.endsWithNewline).equals(bytes)) {
    return {
      ok: false,
      reason: "ambiguous-existing-file",
      detail: `${ENV_FILENAME} could not be read back exactly as written`,
    };
  }

  return {
    ok: true,
    existing: {
      lines,
      bom,
      style,
      action:
        inspection.action === "append"
          ? "append"
          : inspection.action === "noop-success"
            ? "noop-success"
            : "replace",
      lineIndex: inspection.lineIndex,
      snapshot: snapshotOf(stats, bytes),
    },
  };
}

/** Style used for a file that does not exist yet: LF, nothing to preserve. */
const NEW_FILE_STYLE: EnvFileStyle = {
  empty: true,
  newline: "lf",
  endsWithNewline: false,
};

/**
 * Is the target still exactly the file the plan was made from?
 *
 * Identity, ordinary POSIX metadata, and bytes all have to still match:
 *
 *   - identity, because it must still be the same regular file;
 *   - metadata, because a `chmod` or `chgrp` from another terminal changes
 *     neither the inode nor the bytes, and writing over it would undo it;
 *   - bytes, because an editor saving in place rewrites the file through the
 *     same inode, so a matching dev/ino says nothing about content.
 *
 * Every mutation goes through this, append included: an append decided from a
 * file that has since gained the target key, lost its trailing newline, or
 * been rewritten entirely is an append into a file nobody inspected.
 *
 * A very small window remains between this check and the write that follows
 * it. That is accepted: the threat model is accident, not a local attacker
 * racing the filesystem, and closing it properly would mean locking.
 */
async function gateAgainstSnapshot(
  target: string,
  snapshot: TargetSnapshot,
): Promise<ApplyResult | null> {
  const now = await lstatTarget(target);
  if (
    now === "error" ||
    now === null ||
    now.isSymbolicLink() ||
    !now.isFile() ||
    now.dev !== snapshot.dev ||
    now.ino !== snapshot.ino ||
    now.uid !== snapshot.uid ||
    now.gid !== snapshot.gid ||
    (now.mode & MODE_MASK) !== snapshot.mode
  ) {
    return failure(
      target,
      "target-changed",
      `${ENV_FILENAME} changed on disk since RepoBD read it; it was not modified`,
      false,
    );
  }

  let current: Buffer;
  try {
    current = await readFile(target);
  } catch {
    return failure(
      target,
      "read-failed",
      `${ENV_FILENAME} could not be re-read before writing; it was not modified`,
      false,
    );
  }
  if (!current.equals(snapshot.bytes)) {
    // Deliberately not retried: the plan was built from content that no
    // longer exists, and re-planning silently would apply a decision the user
    // made about a different file.
    return failure(
      target,
      "target-changed",
      `${ENV_FILENAME} changed on disk since RepoBD read it; it was not modified`,
      false,
    );
  }
  return null;
}

/** Fixed text. An invalid assignment is unvalidated input and is never echoed. */
const INVALID_ASSIGNMENT_DETAIL =
  "the assignment does not satisfy the RepoBD v0.1 KEY=value grammar";

/**
 * Whether the target belongs to the user running RepoBD.
 *
 * `process.getuid` exists only on POSIX. Where it does not, the check is
 * skipped rather than guessed at — this is a v0.1 ownership boundary for the
 * supported macOS/Linux environment, not a portable identity system.
 */
function ownedByCurrentUser(stats: Stats): boolean {
  const getuid = process.getuid?.bind(process);
  if (getuid === undefined) {
    return true;
  }
  return stats.uid === getuid();
}

/**
 * Reports what applying this assignment would do, without writing.
 *
 * Read-only in full: it opens nothing for writing and creates nothing. A
 * caller uses it to say what is about to happen — and to learn that a
 * confirmation is needed — before `applyAssignment` is called at all.
 */
export async function inspectApplyTarget(
  worktree: VerifiedWorkTree,
  assignment: ApplyAssignment,
): Promise<InspectResult> {
  const target = envTargetPath(worktree.root);

  const validated = validateAssignment(assignment.key, assignment.value);
  if (!validated.ok) {
    return {
      ok: false,
      path: target,
      reason: "invalid-assignment",
      detail: INVALID_ASSIGNMENT_DETAIL,
    };
  }
  const { key, value } = validated.assignment;

  const stats = await lstatTarget(target);
  if (stats === "error") {
    return {
      ok: false,
      path: target,
      reason: "read-failed",
      detail: `${ENV_FILENAME} could not be inspected`,
    };
  }
  if (stats === null) {
    return { ok: true, path: target, action: "create", style: NEW_FILE_STYLE };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return {
      ok: false,
      path: target,
      reason: "unsafe-target",
      detail: describeUnsafe(stats),
    };
  }

  const existing = await readExisting(target, stats, key, value);
  if (!existing.ok) {
    return {
      ok: false,
      path: target,
      reason: existing.reason,
      detail: existing.detail,
    };
  }
  return {
    ok: true,
    path: target,
    action: existing.existing.action,
    style: existing.existing.style,
  };
}

export interface ApplyOptions {
  /**
   * Whether the caller has already obtained explicit approval to replace an
   * existing different value.
   *
   * This module does not ask and does not infer. Without approval, a replace
   * returns `confirmation-required` and touches nothing.
   */
  readonly approvedReplacement: boolean;
}

/**
 * Applies one assignment to the verified work tree's `.env`.
 *
 * Every input is read exactly once, at entry, into a local primitive — the
 * root, both halves of the assignment, and the replacement approval. The
 * caller's objects are never consulted again. They belong to the caller, they
 * are ordinary mutable JavaScript objects, and everything after the first
 * `await` here is a decision about a file: an object that answered one thing
 * during validation and another thing after a suspension point could otherwise
 * turn a validated assignment into an unvalidated write, or an unapproved
 * replacement into an approved one.
 *
 * The target is re-inspected here rather than trusted from an earlier call, so
 * this is safe to call on its own and a target that changed in between is seen
 * as it is now.
 *
 * Success is never reported on the strength of the write alone: every path
 * that writes reads the file back and re-runs the Phase 4A inspector, and only
 * a file that now resolves the key to exactly this value counts as applied.
 */
export async function applyAssignment(
  worktree: VerifiedWorkTree,
  assignment: ApplyAssignment,
  options: ApplyOptions,
): Promise<ApplyResult> {
  // Snapshot, before anything can suspend.
  const target = envTargetPath(worktree.root);
  const validated = validateAssignment(assignment.key, assignment.value);
  const approvedReplacement = options.approvedReplacement === true;

  if (!validated.ok) {
    return failure(target, "invalid-assignment", INVALID_ASSIGNMENT_DETAIL, false);
  }
  // These are primitives copied out of the validation result, not properties
  // read back off the caller's object. Nothing below reads `assignment` or
  // `options` again.
  const { key, value } = validated.assignment;

  const stats = await lstatTarget(target);
  if (stats === "error") {
    return failure(target, "read-failed", `${ENV_FILENAME} could not be inspected`, false);
  }
  if (stats !== null && (stats.isSymbolicLink() || !stats.isFile())) {
    return failure(target, "unsafe-target", describeUnsafe(stats), false);
  }

  if (stats === null) {
    return createEnv(target, key, value);
  }

  const existing = await readExisting(target, stats, key, value);
  if (!existing.ok) {
    return failure(target, existing.reason, existing.detail, false);
  }

  switch (existing.existing.action) {
    case "noop-success":
      // The inspection just proved the key resolves to this value. Writing
      // identical bytes would only disturb the file's timestamps, and this
      // state has to converge so a run that wrote but failed before consume
      // can retry and finish.
      return { ok: true, path: target, action: "noop-success", written: false };
    case "append":
      return appendEnv(target, existing.existing.snapshot, existing.existing, key, value);
    case "replace":
      if (!approvedReplacement) {
        return failure(
          target,
          "confirmation-required",
          `${ENV_FILENAME} already sets ${key} to a different value`,
          false,
        );
      }
      if (!ownedByCurrentUser(stats)) {
        // A replace renames a file RepoBD created over the original, so the
        // result is owned by whoever ran RepoBD unless the original's
        // ownership can be reproduced. Setting another user's uid needs
        // privilege RepoBD does not take, so this is refused up front rather
        // than discovered after the work is done.
        return failure(
          target,
          "foreign-owner",
          `${ENV_FILENAME} is not owned by the current user; RepoBD will not replace it`,
          false,
        );
      }
      return replaceEnv(target, existing.existing, key, value);
  }
}

function failure(
  target: string,
  reason: TargetFailureReason,
  detail: string,
  targetMayHaveChanged: boolean,
): ApplyResult {
  return { ok: false, path: target, reason, detail, targetMayHaveChanged };
}

/**
 * Creates `.env` exclusively.
 *
 * `wx` is `O_CREAT|O_EXCL|O_WRONLY`: it fails if anything is already at the
 * path — including a symlink, dangling or not — so the create path cannot
 * follow one, and a file that appeared since the inspection is not overwritten.
 *
 * Mode `0600` is what is *requested*; the effective mode is `0600 & ~umask`,
 * which a stricter umask can only narrow. On a filesystem without POSIX modes
 * it is advisory. It is not protection against another local user, who is out
 * of scope regardless.
 */
async function createEnv(
  target: string,
  key: string,
  value: string,
): Promise<ApplyResult> {
  const content = `${assignmentLine(key, value)}\n`;
  try {
    const handle = await open(target, "wx", CREATE_MODE);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // Something arrived at the path between the inspection and here.
      return failure(
        target,
        "unsafe-target",
        `${ENV_FILENAME} appeared while RepoBD was preparing to create it`,
        false,
      );
    }
    // The file may exist with partial content. RepoBD does not delete it:
    // removing a file by path after an unexpected error is itself a
    // destructive act on a path that just behaved unexpectedly, and this
    // module claims no rollback. The caller is told the file may have changed.
    return failure(
      target,
      "write-failed",
      `${ENV_FILENAME} could not be created; it may exist with incomplete content`,
      true,
    );
  }

  // The file's own bytes are durable; the directory entry that names it is a
  // separate write. Best effort, on the same terms as the replacement path.
  await syncDirectory(path.dirname(target));
  return verify(target, key, value, "create", true);
}

/**
 * Appends one assignment.
 *
 * `O_APPEND` means existing bytes are not addressable through this handle, so
 * truncating or overwriting them is impossible by construction rather than by
 * care. The block begins with the newline that terminates the file's current
 * last line when one is missing, so an interrupted write can leave a partial
 * trailing line but cannot damage a line already there.
 *
 * `O_NOFOLLOW`, plus an `fstat` compared against the `lstat` from a moment
 * ago, closes the window in which the inspected file could have become a
 * symlink or a different file. This guards the accident, not an attacker.
 */
async function appendEnv(
  target: string,
  snapshot: TargetSnapshot,
  existing: ExistingEnv,
  key: string,
  value: string,
): Promise<ApplyResult> {
  const newline = newlineOf(existing.style);
  const separator =
    existing.style.empty || existing.style.endsWithNewline ? "" : newline;
  const block = `${separator}${assignmentLine(key, value)}${newline}`;

  // Append is a mutation like any other, and the block it is about to write
  // was decided from a file that may have moved on: the key could have been
  // added, a duplicate introduced, the trailing newline changed, or the mode
  // altered. None of those change the inode, so none are caught by the
  // descriptor check below on its own.
  const changed = await gateAgainstSnapshot(target, snapshot);
  if (changed !== null) {
    return changed;
  }

  try {
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_APPEND | O_NOFOLLOW,
    );
    try {
      const now = await handle.stat();
      if (
        !now.isFile() ||
        now.dev !== snapshot.dev ||
        now.ino !== snapshot.ino
      ) {
        return failure(
          target,
          "unsafe-target",
          `${ENV_FILENAME} changed while RepoBD was preparing to write it`,
          false,
        );
      }
      await handle.write(block, null, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      // O_NOFOLLOW reports a symlink this way.
      return failure(
        target,
        "unsafe-target",
        `${ENV_FILENAME} is a symlink; RepoBD will not write through it`,
        false,
      );
    }
    return failure(
      target,
      "write-failed",
      `${ENV_FILENAME} could not be appended to`,
      true,
    );
  }

  return verify(target, key, value, "append", true);
}

/**
 * Replaces the one line that assigns the key.
 *
 * Only that line changes: every other line is carried across unmodified, and
 * the file's own line ending, trailing-newline shape and BOM are preserved, so
 * the result differs from the original in exactly one line.
 *
 * The original is never opened for writing and never truncated. The new
 * content is built in a temp file beside `.env` — beside it, so the rename is
 * within one directory and therefore atomic, and so the only file that ever
 * holds the secret outside `.env` sits under the same permissions and the same
 * repository. It is created exclusively, given the original's mode, uid and
 * gid, and removed if anything fails before the rename.
 */
async function replaceEnv(
  target: string,
  existing: ExistingEnv,
  key: string,
  value: string,
): Promise<ApplyResult> {
  const { lineIndex, snapshot } = existing;
  if (lineIndex === null) {
    return failure(
      target,
      "ambiguous-existing-file",
      `${ENV_FILENAME} does not locate ${key}`,
      false,
    );
  }

  const newline = newlineOf(existing.style);
  const lines = [...existing.lines];
  lines[lineIndex] = assignmentLine(key, value);
  const content = rebuildEnv(
    existing.bom,
    lines,
    newline,
    existing.style.endsWithNewline,
  );

  const directory = path.dirname(target);
  const temp = path.join(
    directory,
    `${ENV_FILENAME}.repobd-${randomSuffix()}.tmp`,
  );

  let tempCreated = false;
  let renamed = false;
  try {
    try {
      // Exclusive, so this invocation owns the path or does not proceed; the
      // flag records that ownership, because a path that already existed is
      // never this invocation's to delete.
      //
      // Created owner-only and EMPTY. Deliberately not with the original's
      // mode: until the metadata below is established and verified, the file
      // must not be reachable by anyone the finished file would not be
      // reachable by, and the way to guarantee that is to start narrower than
      // the target and widen exactly once. `0600` is where an empty file
      // starts, not the mode this file ends up with.
      const handle = await open(temp, "wx", CREATE_MODE);
      tempCreated = true;
      try {
        // Ownership before permissions: on several systems `chown` clears the
        // setuid/setgid bits, so doing it second would undo the `chmod`.
        //
        // Both are best-effort *calls* and neither is trusted. The mode passed
        // to `open` was filtered by umask, `chmod` can silently drop setgid
        // for a group the caller does not belong to, and `chown` fails without
        // privilege. What decides the outcome is the `fstat` that follows.
        await handle.chown(snapshot.uid, snapshot.gid).catch(() => undefined);
        await handle.chmod(snapshot.mode).catch(() => undefined);
        const tempStats = await handle.stat();

        // Ordering, and the reason for it: the secret is written only after
        // the file's ownership and permissions are known to be the ones the
        // finished file will have. Writing first and fixing metadata
        // afterwards would leave the secret on disk, however briefly, under
        // access RepoBD had not established.
        if (!metadataMatches(tempStats, snapshot)) {
          return failure(
            target,
            "metadata-not-preserved",
            `${ENV_FILENAME} could not be replaced without changing its ownership or permissions; it was not modified`,
            false,
          );
        }

        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      return failure(
        target,
        "write-failed",
        `${ENV_FILENAME} could not be prepared for replacement; it was not modified`,
        false,
      );
    }

    // The target must still be exactly what the replacement was planned from.
    const changed = await gateAgainstSnapshot(target, snapshot);
    if (changed !== null) {
      return changed;
    }

    try {
      await rename(temp, target);
      renamed = true;
    } catch {
      return failure(
        target,
        "write-failed",
        `${ENV_FILENAME} could not be replaced; it was not modified`,
        false,
      );
    }
  } finally {
    if (tempCreated && !renamed) {
      // Best effort, and only for a file this invocation created: the temp
      // holds the secret, so it does not survive a failure if it can be
      // helped. A path that already existed belongs to something else and is
      // never removed. On success there is nothing left to remove — the
      // rename consumed it.
      await unlink(temp).catch(() => undefined);
    }
  }

  await syncDirectory(directory);
  return verify(target, key, value, "replace", true);
}

/** 96 random bits, base36. Only needs to not collide with a concurrent run. */
function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join(
    "",
  );
}

/**
 * Durability for the rename itself. Best effort: not every platform permits
 * opening a directory for fsync, and failing the apply because the directory
 * entry is merely not yet flushed would be worse than the risk it addresses.
 */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Ignored deliberately.
  }
}

/**
 * Reads `.env` back and re-runs the Phase 4A inspector.
 *
 * Success requires `noop-success`: the key is set, once, to exactly this
 * value. Nothing weaker counts — not "the write returned", not "the bytes were
 * flushed" — and the comparison happens in memory, never in output.
 *
 * A failure here reports that the file may already hold the change. There is
 * no automatic rollback: undoing a write that could not be verified means
 * writing again, blind, on the basis of a reading that just proved unreliable.
 */
async function verify(
  target: string,
  key: string,
  value: string,
  action: TargetAction,
  written: boolean,
): Promise<ApplyResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch {
    return failure(
      target,
      "verification-failed",
      `${ENV_FILENAME} could not be read back; it may already hold the change`,
      true,
    );
  }
  const text = decodeEnv(hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes);
  if (text === null) {
    return failure(
      target,
      "verification-failed",
      `${ENV_FILENAME} could not be read back; it may already hold the change`,
      true,
    );
  }
  const inspection = inspectEnvFile(text, key, value);
  if (!inspection.ok || inspection.action !== "noop-success") {
    return failure(
      target,
      "verification-failed",
      `${ENV_FILENAME} does not read back as setting ${key}; it may already hold the change`,
      true,
    );
  }
  return { ok: true, path: target, action, written };
}
