// Reading the delivery link from the terminal.
//
// The link carries the decryption key in its fragment, so it must not be a
// command-line argument: argv is visible in shell history, in `ps` output, and
// in any process listing on the machine. It is read from stdin instead, which
// none of those retain.
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
