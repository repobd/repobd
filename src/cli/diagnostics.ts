// The CLI's diagnostic safety boundary.
//
// A user may paste a RepoBD delivery link anywhere on the command line — as an
// operand, after `--`, as `--link=<url>`, glued to a command name, or into a
// command that does not exist. An argument parser reports what it could not
// understand by quoting it, so every one of those shapes ends with the parser
// offering to print the decryption key to the terminal.
//
// Enumerating those shapes is a losing game: the set is the parser's whole
// grammar, and it grows whenever a command or option is added. So nothing here
// tries to recognize argv shapes at all. Instead every diagnostic the parser
// emits passes through one funnel on its way to the terminal, and any text in
// it that came from the user is replaced.
//
//   raw argv -> parser -> redact() -> stderr/stdout
//
// The rule is an allowlist, which is what makes it safe for malformed input:
// tokens RepoBD itself defines pass through, and **everything else the user
// typed is redacted**, without being parsed, validated, or interpreted. A
// malformed link redacts exactly as well as a well-formed one, because nothing
// here ever asks what the token is.
//
// SCOPE. This stops RepoBD from reflecting argv back at the terminal. It does
// nothing about the shell's own record of what was typed: a delivery link
// given as an argument is already in shell history and process listings before
// RepoBD runs. That is why the supported flow is `repobd pull` followed by a
// prompt, and why this boundary is a backstop rather than a reason to accept
// links on the command line.

/** What replaces user-supplied text in a diagnostic. */
export const REDACTED = "<redacted>";

/**
 * Tokens RepoBD defines itself, which are therefore safe to echo. Everything
 * else in argv is treated as potentially secret-bearing.
 *
 * Keeping this list to RepoBD's own vocabulary is deliberate: a diagnostic
 * such as `unknown command '<redacted>'` still tells the user what went wrong,
 * while a list that tried to guess which *user* tokens look harmless would be
 * the same enumeration problem in a new place.
 */
const SELF_TOKENS: ReadonlySet<string> = new Set([
  "repobd",
  "pull",
  "send",
  "help",
  "--help",
  "-h",
  "--version",
  "-V",
]);

/**
 * The exact strings to remove from diagnostics, longest first.
 *
 * Each argv token contributes itself. A token containing `=` also contributes
 * the part after the first `=`, because a parser reporting `--link=<url>` may
 * quote the whole token or only its value. Longest-first ordering means the
 * whole token is replaced before its own suffix can be.
 */
export function redactionTargets(argv: readonly string[]): string[] {
  const targets = new Set<string>();
  for (const token of argv) {
    if (token === "" || SELF_TOKENS.has(token)) {
      continue;
    }
    targets.add(token);
    const separator = token.indexOf("=");
    if (separator !== -1) {
      const value = token.slice(separator + 1);
      if (value !== "" && !SELF_TOKENS.has(value)) {
        targets.add(value);
      }
    }
  }
  return [...targets].sort((a, b) => b.length - a.length);
}

/**
 * Replaces every occurrence of every target.
 *
 * Plain string splitting, not a regular expression: a delivery link is full of
 * characters that are regex metacharacters, and building a pattern out of
 * untrusted input is how a redactor stops redacting.
 */
export function redact(text: string, targets: readonly string[]): string {
  let output = text;
  for (const target of targets) {
    if (output.includes(target)) {
      output = output.split(target).join(REDACTED);
    }
  }
  return output;
}

/**
 * Builds the writer pair for the parser's centralized output configuration.
 *
 * Both streams are covered. Help text goes to stdout and errors to stderr, and
 * either can quote an argument.
 */
export function redactingOutput(
  argv: readonly string[],
  streams: {
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
  },
): {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
} {
  const targets = redactionTargets(argv);
  return {
    writeOut: (text) => streams.out(redact(text, targets)),
    writeErr: (text) => streams.err(redact(text, targets)),
  };
}
