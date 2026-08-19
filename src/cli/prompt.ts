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
