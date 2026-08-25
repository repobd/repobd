// Reading secret-bearing input from the terminal — the delivery link on the
// receiving side, the `KEY=value` on the sending side.
//
// The link carries the decryption key in its fragment, and the sender's value
// *is* the secret, so neither must be a command-line argument: argv is visible
// in shell history, in `ps` output, and in any process listing on the machine.
// Both are read from stdin instead, which none of those retain.
//
// The prompt is written to stderr so stdout stays free of anything but the
// command's own result. What the user types is echoed by the terminal itself —
// Node's readline has no masked-input mode, and hand-rolling one over raw mode
// would mean re-implementing line editing for no gain here, since a pasted
// link is already visible on the screen it was pasted from. The exposure this
// closes is the durable one: history and process arguments.
//
// Nothing here logs, stores, or echoes the value back.

import { createInterface } from "node:readline/promises";
import type { Readable } from "node:stream";

const PROMPT = "Paste RepoBD link: ";

/**
 * Reads one line from stdin. Works both interactively and with piped input,
 * so scripted use does not need the link on the command line either.
 */
export async function promptForDeliveryLink(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY === true,
  });
  try {
    return await rl.question(PROMPT);
  } finally {
    rl.close();
  }
}

/** The two lines a sender types. Neither is echoed back or logged. */
export interface SecretInput {
  readonly key: string;
  readonly value: string;
}

const KEY_PROMPT = "Secret name (KEY): ";
const VALUE_PROMPT = "Secret value: ";

/**
 * Reads one `KEY` line and one value line from stdin, in that order.
 *
 * Two questions rather than one `KEY=value` line, because the split is then
 * made by the terminal rather than by RepoBD guessing where a value with an
 * `=` in it begins. Both prompts are written to stderr, so stdout carries the
 * delivery link and nothing else.
 *
 * Plain stdin, not masked input: Node's readline has no masked mode, and
 * hand-rolling one over raw mode would mean re-implementing line editing to
 * close terminal echo — which is not the exposure the invariants name.
 * Invariant 21 is about argv and shell history, and reading from stdin is what
 * closes that. See the v0.1 decision recorded in the Phase 5A plan.
 *
 * The key is trimmed and the value is not. Surrounding whitespace on a
 * variable name is never meaningful and removing it cannot change which secret
 * is delivered; the value, by contrast, is the secret itself, and RepoBD must
 * not quietly deliver something other than what was typed. A value with
 * surrounding spaces therefore fails the grammar rather than being repaired.
 */
export async function promptForSecret(
  /** The stream to read from. A parameter only so a test can supply one. */
  input: Readable & { readonly isTTY?: boolean } = process.stdin,
): Promise<SecretInput> {
  const rl = createInterface({
    input,
    output: process.stderr,
    terminal: input.isTTY === true,
  });
  // One reader over the stream, rather than two `rl.question` calls.
  //
  // This is not a style choice. `rl.question` twice in a row can lose the
  // second line when stdin is a pipe: the whole input may arrive in one chunk
  // and readline emit both lines before the second question has been
  // registered, in which case the value is dropped. What happens next depends
  // on stream and EOF timing — the second read may hang waiting for input that
  // has already been delivered, or fail at end of input. An async iterator
  // queues the lines instead, so
  // `printf 'KEY\nvalue\n' | repobd send` behaves the same as typing them.
  //
  // End of input yields an empty string rather than an error, and an empty key
  // or value is refused by the grammar. There is no path here that proceeds
  // with input nobody supplied.
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string): Promise<string> => {
    process.stderr.write(prompt);
    const line = await lines.next();
    return line.done === true ? "" : line.value;
  };
  try {
    const key = await ask(KEY_PROMPT);
    const value = await ask(VALUE_PROMPT);
    return { key: key.trim(), value };
  } finally {
    rl.close();
  }
}

/**
 * What the user said about replacing an existing value.
 *
 * `unavailable` is distinct from `no` on purpose: it means the question could
 * not be put to a person at all, which the caller must report differently from
 * a person declining.
 */
export type ReplacementAnswer = "yes" | "no" | "unavailable";

/** Only an explicit yes is a yes. */
const AFFIRMATIVE: ReadonlySet<string> = new Set(["y", "yes"]);

/**
 * Asks whether to replace an existing value.
 *
 * Requires a TTY, and this is the security-relevant part rather than a
 * convenience: the delivery link arrives on stdin, so a piped invocation has
 * already sent one line down that channel and may well have more. Reading an
 * approval from the same pipe would let `printf 'link\ny\n' | repobd pull`
 * approve the destruction of an existing secret without a person ever seeing
 * the question. Without a terminal there is no one to ask, so the answer is
 * `unavailable` and no byte of stdin is consumed.
 *
 * Anything that is not an explicit yes — a bare newline, "n", a stray word,
 * end of input — is `no`. The default is the safe one, and the prompt says so.
 */
export async function promptForReplacement(
  key: string,
): Promise<ReplacementAnswer> {
  if (process.stdin.isTTY !== true) {
    return "unavailable";
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  try {
    const answer = await rl.question(`Replace ${key} in .env? [y/N] `);
    return AFFIRMATIVE.has(answer.trim().toLowerCase()) ? "yes" : "no";
  } catch {
    // Input ended, or the read was interrupted. Neither is consent.
    return "no";
  } finally {
    rl.close();
  }
}
