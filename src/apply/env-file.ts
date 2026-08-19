// RepoBD `.env` inspection — what the existing file says about one key, and
// whether it is safe to act on it.
//
// THE PRODUCT BOUNDARY THIS MODULE IMPLEMENTS
//
//   RepoBD v0.1 supports automatic `.env` modification only for a conservative
//   single-line assignment subset. Files using syntax RepoBD cannot interpret
//   unambiguously are left unchanged.
//
//   RepoBD never guesses how loader-dependent or compound `.env` syntax should
//   be interpreted.
//
// This is an allowlist, and that is the whole design. An earlier version tried
// the opposite — recognize an assignment loosely, then hunt for evidence that
// the line held a *second* one. That approach has no end: whitespace, then
// quotes, then `;`, then `&&`, each found only after someone thought of it,
// and each fix another special case on the way to an accidental shell parser.
// So the question this module answers is not
//
//   "can I find a way this line might be dangerous?"
//
// but
//
//   "is this line one of the few shapes RepoBD is willing to auto-process?"
//
// Anything else is unsupported, and unsupported means refused with no change.
//
// THE SUPPORTED SUBSET, exactly
//
//   - a blank line
//   - a full-line comment (`#` after optional space/tab); commented-out keys
//     such as `# API_KEY=old` are historical text, never active assignments,
//     and are never deleted or rewritten
//   - one assignment, entirely on one physical line:
//
//       [space/tab] [export space/tab] KEY [space/tab] = VALUE [space/tab] [# comment]
//
//     with KEY a variable name and VALUE one of:
//       * empty
//       * a run of canonical value characters — the same set `payload.ts`
//         permits, shared through `isCanonicalValue`
//       * a simple double- or single-quoted run containing no quote of its own
//         kind and no backslash
//
// Sharing the value character set with `payload.ts` is what makes the round
// trip a property of one shared definition rather than of two grammars kept in
// step by hand:
//
//   Within RepoBD's documented conservative `.env` subset, a canonical
//   `KEY=value` assignment written by RepoBD can be read back unambiguously by
//   RepoBD with the same key and literal value.
//
// A canonical `KEY=value` line is by construction a supported line, so a
// create, append or replace can never produce a file that a later retry calls
// ambiguous.
//
// That guarantee is about RepoBD's own reader, and deliberately no wider.
// RepoBD writes dotenv-style assignments; it does not guarantee identical
// semantics when a `.env` file is executed or sourced as a shell script, and
// shell behaviour is not a reason to narrow the value alphabet. A value a
// shell would expand — `~`, `(x)` — is an accepted value that round-trips
// exactly here, and a shell doing something else with it is outside the v0.1
// contract rather than a defect. RELEASE REQUIREMENT: public v0.1
// documentation must say so plainly — RepoBD writes dotenv-style assignments
// and does not guarantee shell `source` compatibility.
//
// WHAT FALLS OUTSIDE, and therefore refuses
//
// Multiline values, duplicate active target keys, several assignments on one
// physical line, shell-style compound syntax, loader-dependent syntax, exotic
// whitespace in a syntactic position, and malformed target-looking lines. Note
// that none of these needs its own detector: a multiline value's opening line
// is not a supported line, and neither is its continuation; `A=1;B=2` is not a
// supported line because `;` is not a canonical value character. They are
// refused for being outside the grammar, not for matching a list of suspicious
// shapes.
//
// Pure: no I/O, no filesystem, no Git, no network, no crypto.
//
// No secret value — neither the one being applied nor one already in the file
// — appears in any returned string. The target key does: it matched the
// variable-name grammar before reaching here, and naming it is what makes a
// later confirmation prompt meaningful.

import { isCanonicalValue } from "./payload.js";

/** Same grammar `payload.ts` accepts. Re-checked here so this module's own
 * promise — that the key it echoes into a `detail` is a variable name and not
 * secret material — holds for any caller, not just the expected one. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The structural shape of an assignment line: ASCII spacing only, everywhere
 * it is significant.
 *
 * Only space and tab, deliberately. A loader whose indent-strip is `\s`-based
 * reads a non-breaking space or a vertical tab as spacing where RepoBD does
 * not, and a line those two would read differently is a line RepoBD refuses
 * rather than adjudicates.
 *
 * The value region is captured raw and checked separately by
 * `readSupportedValue`, so the character set lives in one place.
 */
const ASSIGNMENT_SHAPE =
  /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/;

const BLANK = /^[ \t]*$/;
const COMMENT = /^[ \t]*#/;

/**
 * A supported quoted value: opens and closes on this line, contains no quote
 * of its own kind and no backslash.
 *
 * Excluding the backslash is what keeps this unambiguous — `"a\"b"` is where
 * loaders disagree about whether the quote closed, so it is simply not a
 * supported shape.
 *
 * A trailing comment is allowed, but only when at least one space or tab
 * separates it from the closing quote. An immediately adjacent `#` is not a
 * supported inline comment:
 *
 *   OTHER="x" # comment      supported
 *   OTHER="x"#comment        not supported
 *   OTHER="x"#;API_KEY=OLD   not supported — and this is why
 *
 * Reading the third as a comment would make an active `API_KEY` assignment
 * invisible. RepoBD does not decide what any particular loader makes of the
 * adjacent form; it is simply outside the supported subset.
 */
const DOUBLE_QUOTED = /^"([^"\\]*)"(?:[ \t]*|[ \t]+#.*)$/;
const SINGLE_QUOTED = /^'([^'\\]*)'(?:[ \t]*|[ \t]+#.*)$/;

/**
 * A bare value: one run with no spacing, then optional spacing and comment.
 *
 * The separator rule holds here too, for a different reason and without a
 * special case: `#` is not a canonical value character, so `KEY=abc#comment`
 * reads as the single run `abc#comment`, which fails `isCanonicalValue` and
 * is unsupported. Only a run followed by real spacing can be followed by a
 * comment.
 */
const BARE_VALUE = /^([^ \t]*)[ \t]*(?:#.*)?$/;

/** What a later write should use to terminate a line it adds. */
export type NewlineStyle = "lf" | "crlf";

/**
 * Enough about the file's shape for a later write to preserve it. RepoBD does
 * not convert line endings and does not add or remove a trailing newline
 * beyond the one its own line needs.
 */
export interface EnvFileStyle {
  /** Zero-length file. There is no evidence of a style, so `newline` is the
   * default rather than an observation. */
  readonly empty: boolean;
  readonly newline: NewlineStyle;
  readonly endsWithNewline: boolean;
}

/**
 * What the writer should do.
 *
 * - `append` — no active assignment for the key exists.
 * - `noop-success` — the key already holds exactly this value. Nothing to
 *   write, and the apply counts as **successful**: a run that wrote the file
 *   and then failed before consume has to be able to retry and reach consume,
 *   so this state must converge rather than block.
 * - `replace-requires-confirmation` — the key holds a different value. The
 *   later flow must ask before replacing, and neither value may be shown.
 */
export type EnvFileAction =
  | "append"
  | "noop-success"
  | "replace-requires-confirmation";

export type EnvFileFailureReason =
  /** The caller's key is not a variable name. */
  | "invalid-key"
  /** The key is assigned more than once; RepoBD will not guess which governs. */
  | "duplicate-key"
  /** A line falls outside the supported subset described at the top of this
   * file. Multiline values, compound lines, quoting RepoBD does not read, and
   * exotic whitespace all arrive here. */
  | "unsupported-syntax"
  /** Both LF and CRLF line endings, so no single style could be preserved. */
  | "mixed-line-endings"
  /** A carriage return that does not terminate a line. */
  | "stray-carriage-return";

export type EnvFileInspection =
  | {
      readonly ok: true;
      readonly action: EnvFileAction;
      readonly style: EnvFileStyle;
      /**
       * Zero-based index of the line holding the key's assignment, for the
       * `replace-requires-confirmation` and `noop-success` cases; `null` when
       * the key is absent. A later replace changes this line and no other.
       */
      readonly lineIndex: number | null;
    }
  | {
      readonly ok: false;
      readonly reason: EnvFileFailureReason;
      /** Names the file and, where relevant, the target key. Never a value. */
      readonly detail: string;
    };

function fail(reason: EnvFileFailureReason, detail: string): EnvFileInspection {
  return { ok: false, reason, detail };
}

/**
 * The value a supported assignment line holds, or `null` if the line's value
 * region is outside the supported subset.
 *
 * A discriminated absence rather than a sentinel string: any string this
 * returns could equally be a secret, so `"ambiguous"` — or any other reason
 * name — must never double as control state. `API_KEY=ambiguous` is an
 * ordinary assignment and is treated as one.
 *
 * The value is returned verbatim, quotes included when the line quoted it.
 * RepoBD does not unquote, does not trim, and does not expand: a file holding
 * `KEY="abc"` does not "equal" a payload value of `abc`, so the user is asked.
 * Erring toward asking is correct — the alternative is deciding, on someone
 * else's behalf, that two spellings of a secret are the same secret. RepoBD
 * writes only the plain form, so its own writes always compare equal on a
 * retry.
 */
function readSupportedValue(region: string): string | null {
  const double = DOUBLE_QUOTED.exec(region);
  if (double !== null) {
    return `"${double[1] as string}"`;
  }
  const single = SINGLE_QUOTED.exec(region);
  if (single !== null) {
    return `'${single[1] as string}'`;
  }
  const bare = BARE_VALUE.exec(region);
  if (bare === null) {
    // Something follows the value that is neither spacing nor a comment: a
    // second assignment, a stray quote, further syntax. Unsupported.
    return null;
  }
  const value = bare[1] as string;
  if (value !== "" && !isCanonicalValue(value)) {
    return null;
  }
  return value;
}

/** One physical line, classified against the supported subset. */
type ClassifiedLine =
  /** Blank or a full-line comment: carried across untouched. */
  | { readonly kind: "ignorable" }
  | { readonly kind: "assignment"; readonly key: string; readonly value: string }
  | { readonly kind: "unsupported" };

function classifyLine(line: string): ClassifiedLine {
  if (BLANK.test(line) || COMMENT.test(line)) {
    return { kind: "ignorable" };
  }
  const shape = ASSIGNMENT_SHAPE.exec(line);
  if (shape === null) {
    return { kind: "unsupported" };
  }
  const value = readSupportedValue(shape[2] as string);
  if (value === null) {
    return { kind: "unsupported" };
  }
  return { kind: "assignment", key: shape[1] as string, value };
}

/**
 * Classifies the file's line endings, or refuses when no single style could be
 * preserved.
 *
 * Mixed endings fail closed rather than being resolved: appending either style
 * to a file that uses both means choosing one on the user's behalf, and
 * rewriting the file to be consistent would modify lines RepoBD was never
 * asked to touch.
 */
function readStyle(text: string): EnvFileStyle | EnvFileInspection {
  if (text === "") {
    return { empty: true, newline: "lf", endsWithNewline: false };
  }
  if (/\r(?!\n)/.test(text)) {
    return fail(
      "stray-carriage-return",
      ".env contains a carriage return that does not end a line",
    );
  }
  const hasCrlf = text.includes("\r\n");
  const hasLoneLf = /(?<!\r)\n/.test(text);
  if (hasCrlf && hasLoneLf) {
    return fail("mixed-line-endings", ".env mixes LF and CRLF line endings");
  }
  return {
    empty: false,
    newline: hasCrlf ? "crlf" : "lf",
    endsWithNewline: text.endsWith("\n"),
  };
}

/**
 * Inspects `.env` text for one key.
 *
 * Every line must be inside the supported subset, not merely the target's:
 * a line RepoBD cannot read may itself be where the target is set — that is
 * how `OTHER=x API_KEY=OLD` hides an active assignment — so one unsupported
 * line makes the whole file unsafe to modify.
 *
 * `value` is used for one thing: an exact literal comparison against what the
 * file already assigns. It is never returned, never echoed, never interpreted.
 */
export function inspectEnvFile(
  text: string,
  key: string,
  value: string,
): EnvFileInspection {
  if (!KEY_PATTERN.test(key)) {
    return fail("invalid-key", "target key is not a valid variable name");
  }

  const style = readStyle(text);
  if ("ok" in style) {
    return style;
  }
  if (style.empty) {
    return { ok: true, action: "append", style, lineIndex: null };
  }

  const lines = text.split(/\r\n|\n/);
  if (style.endsWithNewline) {
    // Splitting terminated text leaves one empty trailing element that is not
    // a line of the file.
    lines.pop();
  }

  let matchIndex: number | null = null;
  let matchValue: string | null = null;

  for (const [index, line] of lines.entries()) {
    const classified = classifyLine(line);
    if (classified.kind === "unsupported") {
      return fail(
        "unsupported-syntax",
        ".env has a line outside the simple assignment syntax RepoBD v0.1 edits; it was left unchanged",
      );
    }
    if (classified.kind === "ignorable" || classified.key !== key) {
      continue;
    }
    if (matchIndex !== null) {
      return fail(
        "duplicate-key",
        `.env assigns ${key} more than once; RepoBD will not choose between them`,
      );
    }
    matchIndex = index;
    matchValue = classified.value;
  }

  if (matchIndex === null) {
    return { ok: true, action: "append", style, lineIndex: null };
  }
  return {
    ok: true,
    action:
      matchValue === value ? "noop-success" : "replace-requires-confirmation",
    style,
    lineIndex: matchIndex,
  };
}
