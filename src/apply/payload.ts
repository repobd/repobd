// RepoBD apply payload — what one delivery is allowed to contain.
//
// The v0.1 contract is deliberately one line:
//
//   KEY=value
//
// One delivery carries exactly one assignment. That is not a parser
// limitation, it is the product contract: one secret, one delivery, one
// consume, one overwrite question. A payload carrying two assignments is
// refused outright rather than resolved — taking the first, taking the last,
// or applying both are all ways of writing something nobody chose, and this is
// the one place a guess ends up in a developer's `.env`.
//
// Pure: no I/O, no filesystem, no Git, no network, no crypto. The input is
// already-decrypted UTF-8 whose size the crypto layer has bounded, so nothing
// here re-checks the 64 KiB limit.
//
// The secret value lives in the success result because a later phase has to
// write it. It must never go anywhere else. Every failure `detail` in this
// file is a fixed string with nothing interpolated into it — deliberately,
// because the *candidate* key of a malformed payload can itself be secret
// material: a payload of `sk-live-abc=` yields the candidate key `sk-live-abc`.
// A key name is only safe to repeat once it has matched the strict grammar
// below, which is to say only on success.

/** The variable name a payload may assign. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Printable ASCII, excluding the space at 0x20 and DEL at 0x7F. Control
 * characters, tabs, and every non-ASCII code point fall outside it.
 */
const VALUE_PRINTABLE_ASCII = /^[!-~]+$/;

/**
 * Characters excluded from a v0.1 value even though they are printable ASCII.
 *
 * Two groups, excluded for two different reasons. Neither reason is "some
 * shell would do something else with it" — see the compatibility boundary
 * below.
 *
 *   quote, apostrophe, backslash, `#`, `$`, backtick
 *     These change what a *dotenv-style parser* reads: quotes and backslash
 *     start quoting and escaping, `#` starts a comment, and `$` and a
 *     backtick invite interpolation in the loaders that implement it.
 *     RepoBD writes values verbatim with no quoting, so a value that would
 *     not survive verbatim is refused rather than escaped — escaping is not
 *     portable (a double-quoted value is unquoted by most dotenv loaders and
 *     kept literally by Docker Compose `env_file`), and a silently
 *     reinterpreted secret is worse than a delivery that fails closed.
 *
 *   `;` `&` `|` `<` `>`
 *     These are excluded to keep a *product* promise, not a parsing one.
 *     RepoBD's supported subset refuses a line carrying more than one
 *     assignment, and `;` and `&&` are how developers actually write those.
 *     Were they legal value characters, `OTHER=x;API_KEY=OLD` would read as
 *     one ordinary assignment whose value happens to contain them — RepoBD
 *     would see the target as absent and append a duplicate of a key that is
 *     already set. Excluding them from the value alphabet is what makes that
 *     whole class refusable without guessing. The same set backs the
 *     existing-file grammar in `env-file.ts`, so the two cannot drift.
 *
 * COMPATIBILITY BOUNDARY. RepoBD writes dotenv-style assignments. Within its
 * documented conservative subset, a canonical `KEY=value` written by RepoBD
 * reads back through RepoBD's own scanner with the same key and the same
 * literal value. RepoBD does NOT guarantee identical semantics when a `.env`
 * file is executed or sourced as a shell script, and shell behaviour is not a
 * reason to narrow this alphabet further. `API_KEY=~` and `API_KEY=(x)` are
 * accepted values that round-trip exactly; that a shell would expand or
 * reject them when sourcing is outside the v0.1 contract, not a defect.
 *
 * KNOWN COST, deliberate: values that legitimately contain `;` or `&` — a SQL
 * Server connection string, a database URL with query parameters — cannot be
 * delivered in v0.1. That is a product boundary, not an oversight.
 */
const VALUE_FORBIDDEN = /["'#$\\`;&|<>]/;

/**
 * Whether a string is a value RepoBD may write verbatim after `KEY=`.
 *
 * The single authority for that character set, shared with the existing-file
 * scanner so the two cannot drift apart.
 */
export function isCanonicalValue(value: string): boolean {
  return VALUE_PRINTABLE_ASCII.test(value) && !VALUE_FORBIDDEN.test(value);
}

/** The one assignment a delivery carries. */
export interface ApplyAssignment {
  /** Matched `KEY_PATTERN`, so it is a variable name and safe to display. */
  readonly key: string;
  /** The secret. Never log it, never interpolate it, never display it. */
  readonly value: string;
}

/** The grammar failures an assignment's two halves can have on their own. */
export type AssignmentGrammarFailure =
  | "invalid-key"
  | "empty-value"
  | "unsupported-value";

export type AssignmentValidation =
  | { readonly ok: true; readonly assignment: ApplyAssignment }
  | { readonly ok: false; readonly reason: AssignmentGrammarFailure };

/**
 * Checks a key and value against the settled v0.1 grammar.
 *
 * The single authority for that grammar. `parseApplyPayload` uses it after
 * splitting a payload, and the filesystem writer uses it again immediately
 * before it mutates anything — because `ApplyAssignment` is an ordinary
 * interface, and any caller can construct one that never passed through a
 * parser. A type is a claim; this is the check.
 *
 * Takes `unknown` deliberately: a runtime boundary that only accepts `string`
 * would be trusting the same type system it exists to backstop.
 */
export function validateAssignment(
  key: unknown,
  value: unknown,
): AssignmentValidation {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    return { ok: false, reason: "invalid-key" };
  }
  if (typeof value !== "string") {
    return { ok: false, reason: "unsupported-value" };
  }
  if (value === "") {
    return { ok: false, reason: "empty-value" };
  }
  if (!isCanonicalValue(value)) {
    return { ok: false, reason: "unsupported-value" };
  }
  return { ok: true, assignment: { key, value } };
}

export type PayloadFailureReason =
  /** Nothing but an optional terminal newline. */
  | "empty-payload"
  /** More than one line remained. Two assignments land here. */
  | "multiple-lines"
  /** No `=` at all — a bare value, or prose. */
  | "missing-assignment"
  /** The text before the first `=` is not a variable name. */
  | "invalid-key"
  /** `KEY=` with nothing after it. */
  | "empty-value"
  /** Outside the conservative v0.1 value grammar. */
  | "unsupported-value";

export type PayloadParseResult =
  | { readonly ok: true; readonly assignment: ApplyAssignment }
  | {
      readonly ok: false;
      readonly reason: PayloadFailureReason;
      /** Fixed text. Never derived from the payload. */
      readonly detail: string;
    };

function fail(
  reason: PayloadFailureReason,
  detail: string,
): PayloadParseResult {
  return { ok: false, reason, detail };
}

/** Removes the single line ending a sender's editor may have appended. */
function stripTerminalNewline(text: string): string {
  if (text.endsWith("\r\n")) {
    return text.slice(0, -2);
  }
  if (text.endsWith("\n")) {
    return text.slice(0, -1);
  }
  return text;
}

/**
 * Parses a delivery payload.
 *
 * The exact accepted grammar, and nothing wider:
 *
 *   - the whole payload, minus at most one terminal `\n` or `\r\n`
 *   - which must then be exactly one line: `KEY=value`
 *   - key: `[A-Za-z_][A-Za-z0-9_]*`
 *   - value: one or more printable-ASCII characters, none of them whitespace
 *     and none of the characters `isCanonicalValue` rejects, which is the
 *     single authority for that set: double and single quote, backslash,
 *     `#`, `$`, backtick, `;`, `&`, `|`, `<`, `>`
 *
 * Everything else is refused, including things a `.env` *file* would allow:
 * comments, blank lines, several assignments, an `export` prefix, quoted or
 * spaced values. This is a delivery payload, not a `.env` file, and the
 * narrower grammar is the point — there is no line for RepoBD to choose
 * between, and no quoting for a downstream loader to reinterpret.
 *
 * Splitting happens at the *first* `=`, so a value may contain further ones —
 * base64 padding is ordinary in an API key.
 *
 * Known v0.1 limitation, intentional: PEM blocks, values containing spaces or
 * `#`, quoted values, and multi-line values cannot be delivered. They fail
 * closed with `unsupported-value` rather than being escaped into something
 * that means a different thing on the other side.
 */
export function parseApplyPayload(text: string): PayloadParseResult {
  const body = stripTerminalNewline(text);

  if (body === "") {
    return fail("empty-payload", "payload contains no assignment");
  }
  // One remaining line break means the payload is not one assignment. Two
  // valid assignments arrive here, and are refused without either being read.
  if (/[\r\n]/.test(body)) {
    return fail(
      "multiple-lines",
      "payload must contain exactly one KEY=value assignment",
    );
  }

  const separator = body.indexOf("=");
  if (separator === -1) {
    return fail("missing-assignment", "payload is not a KEY=value assignment");
  }

  // One grammar, one implementation — see `validateAssignment`.
  const validated = validateAssignment(
    body.slice(0, separator),
    body.slice(separator + 1),
  );
  if (!validated.ok) {
    switch (validated.reason) {
      case "invalid-key":
        return fail("invalid-key", "payload key is not a valid variable name");
      case "empty-value":
        return fail("empty-value", "payload assigns an empty value");
      case "unsupported-value":
        return fail(
          "unsupported-value",
          "payload value is not supported by RepoBD v0.1",
        );
    }
  }

  return { ok: true, assignment: validated.assignment };
}
