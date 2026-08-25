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
// No secret value, envelope, decryption key, or raw origin URL is written to
// either output channel. `send` prints one delivery link on stdout — that link
// is the command's entire product and is the only place a fragment ever
// appears; nothing else, on either command, prints one.
//
// The lifecycle order below is the security property of this file, and it runs
// one way only:
//
//   guard (local) → claim → decrypt → validate → inspect → confirm?
//     → server-authoritative ownership gate → write → read-back verify
//     → consume
//
// Two rules hold it together. Nothing reaches the network until the guard has
// matched the repository exactly, so a wrong repository never produces a claim
// — that is Phase 3's guarantee and this file must not weaken it. And nothing
// consumes the delivery until a write has been read back and proved, so every
// failure before that point leaves the delivery usable somewhere else.

import {
  authorizeDelivery,
  describeBlock,
  describeRepoFailure,
  resolveSenderBinding,
  type RepoResolver,
} from "./guard.js";
import {
  MAX_CLAIM_LEASE_MS,
  SERVER_ORIGIN_ENV,
  createHttpSecretClient,
  generateClaimToken,
  resolveServerOrigin,
  type SecretClient,
  type SecretClientFailure,
} from "./secret-client.js";
import {
  buildDeliveryLink,
  type ServiceOriginFailureReason,
} from "./link.js";
import {
  promptForReplacement,
  type ReplacementAnswer,
  type SecretInput,
} from "./prompt.js";
import {
  parseApplyPayload,
  validateAssignment,
  type AssignmentGrammarFailure,
} from "../apply/payload.js";
import {
  applyAssignment,
  inspectApplyTarget,
  ENV_FILENAME,
} from "../apply/target.js";
import {
  PlaintextTooLargeError,
  decrypt,
  encrypt,
  exportKey,
  generateKey,
  importKey,
  parseEnvelope,
  serializeEnvelope,
} from "../crypto/envelope.js";

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
  /**
   * Asks whether to replace an existing different value. Defaults to the real
   * terminal prompt, which refuses without a TTY.
   */
  readonly confirmReplacement?: (key: string) => Promise<ReplacementAnswer>;
}

/**
 * How much lease the server must still report before RepoBD will write.
 *
 * Not a claim about how long filesystem I/O takes. Its job is narrower: refuse
 * to start writing against a delivery that is already on the point of expiring,
 * so the run does not apply a secret it then cannot consume.
 *
 * The figure that is compared against this is measured by the server, never
 * here. A receiver's clock may disagree with the service's by any amount, and
 * a lease that looks live locally can already be gone.
 *
 * The comparison also requires the figure to be a finite duration no larger
 * than the protocol can grant — see the gate itself for why a bare `>=` is
 * not enough.
 */
export const MIN_PREWRITE_LEASE_MS = 60_000;

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
 * `repobd pull` — retrieve a secret bound to this repository and apply it.
 *
 * The order below is the whole point of the function, so it is written as one
 * straight line with no early conveniences:
 *
 *   1. read the link, parse it, resolve this repository, compare exactly —
 *      all local. A mismatch returns before a client exists, so no claim token
 *      is submitted and no ciphertext is fetched.
 *   2. claim, which takes a lease and returns the envelope. Not a consume.
 *   3. decrypt locally.
 *   4. validate exactly one KEY=value.
 *   5. inspect the target under the root the guard verified.
 *   6. say what is about to happen, and ask only if an existing different
 *      value would be destroyed.
 *   7. confirm this run still owns the claim, immediately before touching
 *      the filesystem.
 *   8. write, and read it back.
 *   9. only then consume.
 *
 * Most failures before step 9 hand the claim back so the delivery stays
 * usable — but not all of them, and the exception matters. When the ownership
 * refresh at step 7 cannot be completed, this run does not know whether it
 * still holds the claim, and a release issued on that guess could hand back a
 * lease that has already moved to someone else. Those paths report and stop;
 * the lease expiring on its own is the fallback. Nothing is consumed on any
 * path that did not write and verify.
 */
export async function runPull(options: PullOptions): Promise<number> {
  // Every caller-provided input, captured synchronously before the first
  // suspension. `options` is not read again after this block.
  //
  // The reason is the same one that applies inside `applyAssignment`, and it
  // reaches further than it looks: `readLink()` suspends for as long as a
  // person takes to paste a link, and anything reachable from `options` can be
  // changed during that window. The sharpest case is `confirmReplacement` —
  // adding it while the paste is pending would decide, after the fact, whether
  // an existing secret gets replaced. Repository selection, the network client
  // and both output channels are the same kind of switch.
  //
  // Optional defaults are resolved here too. Whether a callback is present is
  // itself a decision, so it is made now rather than at the point of use.
  //
  // References only. Nothing is *invoked* here that the lifecycle would not
  // otherwise invoke, and nothing moves earlier: the link is still read below,
  // the repository still resolves before any network client exists, and the
  // client is still constructed only after the guard matches.
  const readLink = options.readLink;
  const out = options.out;
  const err = options.err;
  const cwd = options.cwd;
  const resolveRepo = options.resolveRepo;
  const createClient = options.createClient ?? createHttpSecretClient;
  const confirmReplacement =
    options.confirmReplacement ?? promptForReplacement;

  // Held in a local for exactly as long as the guard needs it, and never
  // written to either output channel.
  const link = await readLink();
  const authorized = await authorizeDelivery(link, cwd, resolveRepo);
  if (!authorized.ok) {
    for (const line of describeBlock(authorized.block)) {
      err(line);
    }
    return EXIT_BLOCKED;
  }

  // Snapshotted out of the guard result before anything can suspend, and used
  // for the rest of the run. The root is the one whose identity was matched;
  // it is never re-derived from the working directory.
  const { secretId, origin, key: deliveryKey } = authorized.link;
  const root = authorized.root;

  // Past this point, and only past it, the network is in play. The factory
  // was captured at entry; it is called here, and not a moment sooner.
  const client = createClient(origin);
  const claimToken = generateClaimToken();

  const claimed = await client.claim(secretId, claimToken);
  if (!claimed.ok) {
    err(describeClientFailure(claimed.reason));
    return EXIT_BLOCKED;
  }
  out(`Repository verified: ${authorized.repo.canonical}`);

  /**
   * Tries to hand the claim back so the delivery stays usable somewhere else.
   *
   * An attempt, not a guarantee: the request can fail or never arrive, and the
   * lease expiring on its own is the fallback that makes that acceptable. It
   * never replaces the error that caused it, and it is not called once the
   * delivery has been consumed, nor on a path where this run does not know
   * whether it still holds the claim.
   */
  const release = async (): Promise<void> => {
    const released = await client.release(secretId, claimToken);
    if (!released.ok) {
      err(
        "The claim may not have been handed back; it expires on its own.",
      );
    }
  };

  const failAfterClaim = async (message: string): Promise<number> => {
    err(message);
    await release();
    return EXIT_BLOCKED;
  };

  // Step 3. Decrypt locally. The key never left the fragment, and neither the
  // envelope nor the plaintext reaches an output channel.
  let plaintext: string;
  try {
    const cryptoKey = await importKey(deliveryKey);
    plaintext = await decrypt(parseEnvelope(claimed.envelope), cryptoKey);
  } catch {
    // Deliberately one message. Distinguishing a wrong key from tampered
    // ciphertext is a distinction the crypto layer refuses to make, and
    // repeating it here would undo that.
    return failAfterClaim("This delivery could not be decrypted.");
  }

  // Step 4. Exactly one assignment, by the Phase 4A grammar.
  const payload = parseApplyPayload(plaintext);
  if (!payload.ok) {
    // The payload's own reason text never carries the value; see payload.ts.
    return failAfterClaim(
      "This delivery is not a single KEY=value assignment RepoBD can apply.",
    );
  }
  // Primitives, copied once. Nothing below re-reads the parse result, so no
  // later mutation of it could change what gets written.
  const assignmentKey = payload.assignment.key;
  const assignmentValue = payload.assignment.value;

  // Step 5. Inspect the target, read-only, under the verified root.
  const worktree = { root };
  const inspection = await inspectApplyTarget(worktree, {
    key: assignmentKey,
    value: assignmentValue,
  });
  if (!inspection.ok) {
    return failAfterClaim(describeTargetFailure(inspection.reason, inspection.detail));
  }
  // Snapshotted alongside the assignment, and the thing any confirmation below
  // is a confirmation *about*.
  const inspectedState = inspection.state;

  // Step 6. Say what is about to happen, and ask only when an existing
  // different value would be destroyed.
  let approvedReplacement = false;
  switch (inspection.action) {
    case "create":
    case "append":
      out(`Will add ${assignmentKey} to ${ENV_FILENAME}.`);
      break;
    case "noop-success":
      out(
        `${assignmentKey} is already present in ${ENV_FILENAME} with the same value.`,
      );
      break;
    case "replace": {
      out(
        `${assignmentKey} already exists in ${ENV_FILENAME} with a different value.`,
      );
      const answer = await confirmReplacement(assignmentKey);
      if (answer === "unavailable") {
        return failAfterClaim(
          `Replacing an existing value needs a terminal to confirm at. Nothing was written, and the delivery was not used.`,
        );
      }
      if (answer !== "yes") {
        out("Nothing was written. The delivery was not used.");
        await release();
        return EXIT_BLOCKED;
      }
      // Snapshotted as a primitive, before the awaits that follow.
      approvedReplacement = true;
      break;
    }
  }

  // Step 7. The lease ownership gate, and it asks the server every time.
  //
  // Unconditional on purpose. Deciding whether to ask by comparing the earlier
  // `claim_expires_at` against a local clock assumes the two clocks agree; when
  // they do not, the check is skipped precisely when it was needed. The server
  // is the only party that knows whether this token still holds the lease and
  // how much of it is left, so it is asked, once, immediately before the write.
  const ownership = await client.claim(secretId, claimToken);
  if (!ownership.ok) {
    // Ownership could not be confirmed. That is not the same as knowing it was
    // lost — an unreachable service says nothing about who holds the claim —
    // so the wording claims no more than was observed, and no release is
    // attempted against a claim whose state is unknown.
    err(
      `${describeClientFailure(ownership.reason)} RepoBD could not confirm it still holds this delivery, so nothing was written.`,
    );
    return EXIT_BLOCKED;
  }
  // Checked here as well as in the transport, on purpose. This is the line
  // that authorizes a filesystem mutation, and it should not be sound only
  // because something upstream validated for it.
  //
  // Written as a positive requirement rather than as `< MIN`. The negative
  // form is false for a missing or non-numeric value, and `Infinity >= MIN` is
  // true — so the naive spellings both let a malformed response through the
  // one gate that exists to stop the write.
  const lease = ownership.leaseRemainingMs;
  if (
    typeof lease !== "number" ||
    !Number.isFinite(lease) ||
    lease < MIN_PREWRITE_LEASE_MS ||
    lease > MAX_CLAIM_LEASE_MS
  ) {
    // The claim is ours, and the server says it is nearly over — a delivery
    // close to its own expiry reports this even on a fresh claim, because the
    // lease is capped by the secret's TTL. Writing now risks applying a secret
    // that cannot then be consumed, so the run stops before touching anything.
    err(
      "This delivery is too close to expiry to apply safely. Nothing was written; ask for a new one.",
    );
    await release();
    return EXIT_BLOCKED;
  }

  // Step 8. Write, and read it back. `applyAssignment` re-inspects the target
  // itself and will not report success on the strength of a write returning.
  const applied = await applyAssignment(
    worktree,
    { key: assignmentKey, value: assignmentValue },
    // The state the inspection reported — and, when a person was asked, the
    // state they were asked about. If `.env` has moved on since, the write
    // does not happen and the approval is not spent on a different file.
    { approvedReplacement, expectedState: inspectedState },
  );
  if (!applied.ok) {
    if (applied.targetMayHaveChanged) {
      // The one failure the user must not read as "nothing happened" — and
      // equally must not read as "nothing was written". RepoBD does not know
      // which, so it says so rather than picking one.
      err(
        `RepoBD could not confirm that ${assignmentKey} was applied successfully. ${ENV_FILENAME} may have changed. The delivery was not used; check the file before running this again.`,
      );
    } else {
      err(describeTargetFailure(applied.reason, applied.detail));
    }
    await release();
    return EXIT_BLOCKED;
  }

  out(
    applied.written
      ? `Applied ${assignmentKey} to ${ENV_FILENAME}.`
      : `${ENV_FILENAME} already had ${assignmentKey}; nothing was written.`,
  );

  // Step 9. Only now.
  // Two recoveries, each for a different failure, each bounded, and
  // deliberately written as one `if/else if` rather than as a retry helper:
  // the maximum number of requests on either branch should be countable by
  // reading it. Nothing here rewrites `.env` — the file is already correct,
  // and a second write would be a change nobody asked for.
  let consumed = await client.consume(secretId, claimToken);
  if (!consumed.ok && consumed.reason === "unreachable") {
    // Transport ambiguity, not an ownership problem. "Unreachable" covers both
    // "the request never arrived" and "it arrived, worked, and the response was
    // lost" — and consume is idempotent for the same token, so the second call
    // either performs the transition or recognizes the one it already made.
    // No renewal first: nothing suggests the lease is the problem, and a claim
    // here would be a request made on a guess.
    consumed = await client.consume(secretId, claimToken);
  } else if (!consumed.ok && consumed.reason === "claim-conflict") {
    // The lease lapsed between the gate and here. One renewal with the same
    // token, then one retry. Whether to try is decided by what the server just
    // said, not by any local reckoning of time.
    const renewed = await client.claim(secretId, claimToken);
    if (renewed.ok) {
      consumed = await client.consume(secretId, claimToken);
    }
  }
  if (!consumed.ok) {
    // The local change stands and is correct. Undoing it would be a second
    // unrequested write, and claiming the run failed would be untrue.
    err(
      "The delivery could not be marked as used and may still be available. Run this again to finish; nothing further will be written.",
    );
    return EXIT_BLOCKED;
  }

  out("Delivery consumed.");
  return EXIT_OK;
}

/**
 * The user-facing sentence for a refused target.
 *
 * The `detail` from `src/apply` names the file and the validated key and
 * never a value, so it is safe to show and is more useful than a category.
 */
function describeTargetFailure(reason: string, detail: string): string {
  if (reason === "confirmation-required") {
    // Reachable only if the target changed between inspection and write.
    return `${ENV_FILENAME} now needs confirmation to replace. Nothing was written.`;
  }
  return `${detail}. Nothing was written, and the delivery was not used.`;
}

export interface SendOptions extends CommandIo {
  /**
   * Supplies the assignment to deliver. A function, not two strings, because
   * the value is the secret and must never arrive as a command-line argument —
   * it is read from stdin at the point of use.
   */
  readonly readSecret: () => Promise<SecretInput>;
  /** Defaults to the real HTTP client. Constructed only after validation. */
  readonly createClient?: (origin: string) => SecretClient;
}

/**
 * How long a delivery lives. Fifteen minutes, fixed.
 *
 * Not a user-input surface in v0.1: there is no flag, no prompt, and no
 * environment override, so there is no CLI-side range to validate. The Worker
 * enforces its own maximum on whatever it is sent, and this constant is far
 * inside it.
 */
export const SEND_TTL_SECONDS = 900;

/** The one sentence every refused send ends with. */
const NO_LINK = "No delivery link was created.";

/**
 * The user-facing sentence for input that is not a deliverable assignment.
 *
 * Fixed strings with nothing interpolated, for the reason `payload.ts` gives:
 * a rejected key can itself be secret material — someone who pastes their API
 * key at the `KEY` prompt has typed a secret into a field RepoBD is about to
 * complain about.
 */
function describeAssignmentFailure(reason: AssignmentGrammarFailure): string {
  switch (reason) {
    case "invalid-key":
      return "A secret name must be a variable name: a letter or underscore, then letters, digits or underscores.";
    case "empty-value":
      return "A secret value cannot be empty.";
    case "unsupported-value":
      return "That value is outside the character set RepoBD v0.1 can deliver: printable ASCII, no spaces, and none of \" ' \\ # $ ` ; & | < >.";
  }
}

/**
 * The user-facing sentence for a service origin RepoBD will not address.
 *
 * Names the environment variable, never its value: what someone typed into it
 * can be a private hostname, and it can also be a URL with credentials in it,
 * which is the one thing invariant 20 says must not be echoed back. Every
 * sentence therefore says what a valid origin looks like instead of what this
 * one was.
 */
function describeOriginFailure(reason: ServiceOriginFailureReason): string {
  const prefix = `${SERVER_ORIGIN_ENV} is not a usable RepoBD service origin`;
  switch (reason) {
    case "not-a-url":
      return `${prefix}: it is not a URL.`;
    case "unsupported-scheme":
      return `${prefix}: use https, or http only for a local development service on localhost.`;
    case "credentials":
      return `${prefix}: it embeds credentials.`;
    case "unexpected-path":
      return `${prefix}: it has a path. An origin is a scheme, a host and a port.`;
    case "unexpected-query":
      return `${prefix}: it has a query string. An origin is a scheme, a host and a port.`;
    case "unexpected-fragment":
      return `${prefix}: it has a fragment. An origin is a scheme, a host and a port.`;
  }
}

/**
 * `repobd send` — encrypt one `KEY=value` and produce a delivery link bound to
 * this repository.
 *
 * The order, and it runs one way only:
 *
 *   0. resolve and validate the service origin. It is the cheapest thing that
 *      can be wrong and the earliest thing that can be checked, so a
 *      misconfigured `REPOBD_SERVER_URL` stops before Git is read, before a
 *      person is asked to type a secret, and — the point — before anything is
 *      created on a server.
 *   1. resolve this repository. An unresolvable one produces no link at all
 *      rather than an unbound one, and it stops here — before a person has
 *      been asked to type a secret RepoBD could not have delivered.
 *   2. read KEY and value from stdin. Never argv; see `prompt.ts`.
 *   3. validate against the same grammar the receiver will re-apply after
 *      decrypting, so a payload that could not be applied is never created.
 *      Nothing has touched the network at this point.
 *   4. generate a fresh key and encrypt. The 64 KiB bound lives inside
 *      `encrypt`, so an oversized value is refused here, still before any
 *      request.
 *   5. create — the only network call, carrying the ciphertext envelope and a
 *      TTL and nothing else. No repository identity, no key, no plaintext.
 *   6. build the link, whose fragment carries the key and the binding, and
 *      print it. The fragment is never transmitted by any HTTP client, so the
 *      key reaches the receiver only through whatever channel the two people
 *      already use.
 *
 * The binding comes from the sender's own repository through the same resolver
 * the receiver uses, so both sides agree by construction. There is no
 * free-text repository entry in v0.1.
 */
export async function runSend(options: SendOptions): Promise<number> {
  // Captured synchronously before the first suspension, for the reason spelled
  // out in `runPull`: `readSecret()` suspends for as long as a person takes to
  // type, and anything reachable from `options` could otherwise be changed
  // during that window — including which repository the link binds to and
  // where the ciphertext is sent.
  const readSecret = options.readSecret;
  const out = options.out;
  const err = options.err;
  const cwd = options.cwd;
  const resolveRepo = options.resolveRepo;
  const createClient = options.createClient ?? createHttpSecretClient;

  // Step 0. Read once, validated once, and nothing prints it — not on success
  // and not in the failure below, which names the variable rather than quoting
  // what was in it.
  const resolvedOrigin = resolveServerOrigin();
  if (!resolvedOrigin.ok) {
    err(describeOriginFailure(resolvedOrigin.reason));
    err(NO_LINK);
    return EXIT_BLOCKED;
  }
  const origin = resolvedOrigin.origin;

  // Step 1.
  const local = await resolveSenderBinding(cwd, resolveRepo);
  if (!local.ok) {
    err(describeRepoFailure(local.reason));
    err(NO_LINK);
    return EXIT_BLOCKED;
  }
  const repo = local.repo;
  out(`This repository: ${repo.canonical}`);

  // Step 2. Held in locals for exactly as long as the encryption needs them,
  // and never written to either output channel.
  const input = await readSecret();

  // Step 3. The receiver's grammar, applied by the sender, so a delivery that
  // could never be applied is never created — and applied before anything
  // reaches the network.
  const validated = validateAssignment(input.key, input.value);
  if (!validated.ok) {
    err(describeAssignmentFailure(validated.reason));
    err(NO_LINK);
    return EXIT_BLOCKED;
  }
  // The canonical payload, built from the validated halves rather than from
  // the raw input, so the bytes that get encrypted are the bytes that passed.
  const payload = `${validated.assignment.key}=${validated.assignment.value}`;

  // Step 4. Fresh key per delivery, never reused and never stored.
  let envelope: string;
  let keyMaterial: string;
  try {
    const cryptoKey = await generateKey();
    envelope = serializeEnvelope(await encrypt(payload, cryptoKey));
    keyMaterial = await exportKey(cryptoKey);
  } catch (error) {
    // Still no network call. `encrypt` enforces the 64 KiB payload bound
    // itself, which is why nothing above re-checks it.
    err(
      error instanceof PlaintextTooLargeError
        ? "That secret is larger than RepoBD's 64 KiB limit."
        : "RepoBD could not encrypt this secret.",
    );
    err(NO_LINK);
    return EXIT_BLOCKED;
  }

  // Step 5. Past this point, and only past it, the network is in play.
  const client = createClient(origin);
  const created = await client.create(envelope, SEND_TTL_SECONDS);
  if (!created.ok) {
    err(describeClientFailure(created.reason));
    err(NO_LINK);
    return EXIT_BLOCKED;
  }

  // Step 6. The one line that carries a fragment, and the command's product.
  const link = buildDeliveryLink({
    origin,
    secretId: created.id,
    key: keyMaterial,
    repo,
  });
  out(
    "Delivery created. It can be used once, in that repository, within 15 minutes.",
  );
  out(link);
  return EXIT_OK;
}
