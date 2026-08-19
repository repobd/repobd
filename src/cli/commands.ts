// RepoBD CLI command bodies.
//
// Separated from `index.ts` so the flows are ordinary functions a test can
// call: the guard, the network seam, and the output channels are all
// parameters. `index.ts` supplies the real ones and does nothing else.
//
// The ordering rule this file must not break: `authorizeDelivery` runs first
// and a network client is not even constructed until it returns `ok`. The
// client factory is a separate parameter from the guard for that reason —
// "was the network reached" is a question a test can answer by counting.
//
// No secret value, envelope, decryption key, delivery fragment, or raw origin
// URL is written to either output channel.

import {
  authorizeDelivery,
  describeBlock,
  describeRepoFailure,
  resolveSenderBinding,
  type RepoResolver,
} from "./guard.js";
import {
  createHttpSecretClient,
  generateClaimToken,
  type SecretClient,
  type SecretClientFailure,
} from "./secret-client.js";

export type Write = (line: string) => void;

export interface CommandIo {
  readonly cwd: string;
  readonly out: Write;
  readonly err: Write;
  /** Defaults to the real Phase 3B resolver. */
  readonly resolveRepo?: RepoResolver;
}

export interface PullOptions extends CommandIo {
  /**
   * Supplies the delivery link. A function, not a string, because the link
   * carries the decryption key and must never arrive as a command-line
   * argument — it is read from stdin at the point of use.
   */
  readonly readLink: () => Promise<string>;
  /** Defaults to the real HTTP client. Constructed only after a match. */
  readonly createClient?: (origin: string) => SecretClient;
}

/** Exit codes. Any block is a failure; none of them is a partial success. */
export const EXIT_OK = 0;
export const EXIT_BLOCKED = 1;

/**
 * The only thing said when someone runs `repobd pull <link>`.
 *
 * Fixed text. It names no argument and quotes nothing, because the value that
 * would be quoted is the secret-bearing link itself.
 */
export const PULL_TAKES_NO_ARGUMENT =
  "repobd pull does not accept a link argument. Run repobd pull and paste the link when prompted.";

/**
 * True when a `pull` invocation carries a positional argument.
 *
 * This runs **before** the argument parser sees `argv`, which is the point: an
 * argument parser that rejects an unexpected operand reports what it rejected,
 * and here that would print the decryption key to the terminal. The value is
 * therefore never handed to a parser, never read, and never echoed — its mere
 * presence is the whole decision.
 *
 * Anything starting with `-` is left alone so `--help` and future options keep
 * working; every other token after the subcommand is an operand `pull` does
 * not take.
 */
export function hasUnexpectedPullOperand(argv: readonly string[]): boolean {
  if (argv[0] !== "pull") {
    return false;
  }
  return argv.slice(1).some((token) => !token.startsWith("-"));
}

function describeClientFailure(reason: SecretClientFailure): string {
  switch (reason) {
    case "not-found":
      return "This delivery is no longer available.";
    case "expired":
      return "This delivery has expired.";
    case "consumed":
      return "This delivery has already been used.";
    case "claim-conflict":
      return "This delivery is currently claimed by another pull.";
    case "unreachable":
      return "Could not reach the RepoBD service.";
    case "rejected":
    case "malformed-response":
      return "The RepoBD service returned an unexpected response.";
  }
}

/**
 * `repobd pull` — retrieve a secret bound to this repository.
 *
 * Order, and the whole Phase 3 guarantee: parse the link, validate the
 * binding, resolve this repository, compare exactly — all locally — and only
 * then contact the service. A mismatch or any resolution failure returns
 * before a client exists, so no claim token is submitted, no ciphertext is
 * fetched, and nothing is consumed. Nothing needs releasing either, because
 * no claim was ever taken.
 */
export async function runPull(options: PullOptions): Promise<number> {
  // Held in a local for exactly as long as the guard needs it, and never
  // written to either output channel.
  const link = await options.readLink();
  const authorized = await authorizeDelivery(
    link,
    options.cwd,
    options.resolveRepo,
  );
  if (!authorized.ok) {
    for (const line of describeBlock(authorized.block)) {
      options.err(line);
    }
    return EXIT_BLOCKED;
  }

  // Past this point, and only past it, the network is in play.
  const createClient = options.createClient ?? createHttpSecretClient;
  const client = createClient(authorized.link.origin);
  const claimToken = generateClaimToken();

  const claimed = await client.claim(authorized.link.secretId, claimToken);
  if (!claimed.ok) {
    options.err(describeClientFailure(claimed.reason));
    return EXIT_BLOCKED;
  }

  options.out(`Repository verified: ${authorized.repo.canonical}`);

  // Phase 4 owns decrypting and writing the payload, and consume happens only
  // after a verified local write. Until that exists, the correct thing to do
  // with an unusable claim is hand it back: the delivery stays valid, and it
  // is emphatically not consumed here.
  const released = await client.release(authorized.link.secretId, claimToken);
  if (!released.ok) {
    options.err(
      "Retrieved, but the claim could not be released; it expires on its own.",
    );
    return EXIT_BLOCKED;
  }
  options.out(
    "Secret retrieved. Applying it locally is not implemented yet, so the delivery was released unused.",
  );
  return EXIT_OK;
}

/**
 * `repobd send` — Phase 3 scope only: report the repository a delivery link
 * created here would be bound to.
 *
 * The binding comes from the sender's own repository through the same
 * resolver the receiver uses, so both sides agree by construction. There is
 * no free-text repository entry in v0.1, and an unresolvable repository
 * produces no link at all rather than an unbound one.
 *
 * Encrypting and creating the delivery is not part of this phase.
 */
export async function runSend(options: CommandIo): Promise<number> {
  const local = await resolveSenderBinding(options.cwd, options.resolveRepo);
  if (!local.ok) {
    options.err(describeRepoFailure(local.reason));
    options.err("No delivery link was created.");
    return EXIT_BLOCKED;
  }
  options.out(`This repository: ${local.repo.canonical}`);
  options.out(
    "A delivery link created here would be bound to that repository. Sending is not implemented yet.",
  );
  return EXIT_OK;
}
