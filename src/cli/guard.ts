// RepoBD repository guard — the check that runs before any secret is fetched.
//
// The invariant this file exists to hold:
//
//   Local repository identity is resolved and matched against the delivery
//   binding BEFORE any network claim or fetch occurs.
//
// It is enforced structurally, not by comment: this module has no network
// client, takes none, and cannot construct one. `authorizeDelivery` returns a
// value, and only its `ok: true` case carries the origin and secret id a
// request could be addressed to. A caller that skips the guard has nothing to
// address a request with.
//
// What this is: a context guardrail for the accident of pulling a secret in
// the wrong terminal. What it is not: authentication. The binding is not
// signed and the local identity comes from local Git configuration, so anyone
// who can edit either can defeat it — and anyone holding the link already
// holds the decryption key. See docs/THREAT_MODEL.md.
//
// The rules themselves live in `src/repo`: canonicalization and comparison in
// `identity.ts` and `binding.ts`, local resolution in `git.ts`. Nothing here
// restates them.

import { verifyBinding, type BindingDifference } from "../repo/binding.js";
import {
  resolveCurrentRepoIdentity,
  type RepoResolution,
  type RepoResolutionFailureReason,
} from "../repo/git.js";
import type { CanonicalRepo } from "../repo/identity.js";
import {
  parseDeliveryLink,
  type DeliveryLink,
  type LinkParseFailureReason,
} from "./link.js";

/**
 * The local-resolution seam.
 *
 * Injectable so a test can drive resolution outcomes that a temporary
 * directory cannot reproduce. The default is the real Phase 3B resolver, and
 * no caller in the product passes anything else.
 */
export type RepoResolver = (cwd: string) => Promise<RepoResolution>;

export type GuardBlock =
  | { readonly kind: "link"; readonly reason: LinkParseFailureReason }
  | { readonly kind: "repo"; readonly reason: RepoResolutionFailureReason }
  | {
      readonly kind: "mismatch";
      readonly difference: Exclude<BindingDifference, "none">;
      readonly expected: string;
      readonly actual: string;
    };

export type GuardResult =
  | {
      readonly ok: true;
      /** Present only here: what a request may be addressed to. */
      readonly link: DeliveryLink;
      readonly repo: CanonicalRepo;
      /**
       * Absolute path of the work tree whose identity was just matched.
       *
       * Carried out of the guard rather than resolved again later, so the
       * directory a secret is written to is the same one the binding was
       * checked against. Re-deriving a root from the process's working
       * directory afterwards would be a second answer to a question already
       * answered, and the two could differ.
       */
      readonly root: string;
    }
  | { readonly ok: false; readonly block: GuardBlock };

/**
 * Runs the receiver-side guard in the required order:
 *
 *   1. parse the delivery link locally
 *   2. extract and validate the binding locally
 *   3. resolve the current local repository identity
 *   4. compare the two exactly
 *
 * Every step is local. Nothing in this function performs, schedules, or
 * enables a network request, and any failure ends in a block — never in a
 * fallback, a prompt to continue, or an unbound mode.
 */
export async function authorizeDelivery(
  rawLink: string,
  cwd: string,
  resolveRepo: RepoResolver = resolveCurrentRepoIdentity,
): Promise<GuardResult> {
  // Steps 1 and 2. Parsing the link also validates the binding; a link with a
  // missing, malformed, or future-versioned binding never reaches step 3.
  const parsed = parseDeliveryLink(rawLink);
  if (!parsed.ok) {
    return { ok: false, block: { kind: "link", reason: parsed.reason } };
  }

  // Step 3. Read-only Git, no network, no raw origin URL returned.
  const local = await resolveRepo(cwd);
  if (!local.ok) {
    // An unresolvable repository is not reported as a mismatch: RepoBD does
    // not know whether it matches, and saying otherwise would describe a
    // comparison that never happened.
    return { ok: false, block: { kind: "repo", reason: local.reason } };
  }

  // Step 4. Exact, case-sensitive comparison, from `binding.ts`.
  const verified = verifyBinding(parsed.link.repo, local.repo);
  if (!verified.ok) {
    return {
      ok: false,
      block: {
        kind: "mismatch",
        // `verifyBinding` returns `none` only when it succeeded.
        difference: verified.difference as Exclude<BindingDifference, "none">,
        expected: verified.expected,
        actual: verified.actual,
      },
    };
  }

  return { ok: true, link: parsed.link, repo: local.repo, root: local.root };
}

/**
 * Resolves the repository a sender's link would be bound to.
 *
 * Same resolver, same rules, same fail-closed behavior as the receiver. v0.1
 * has no free-text repository entry: a link is bound to the repository the
 * sender is actually standing in, or it is not produced at all.
 */
export async function resolveSenderBinding(
  cwd: string,
  resolveRepo: RepoResolver = resolveCurrentRepoIdentity,
): Promise<RepoResolution> {
  return resolveRepo(cwd);
}

const UNSUPPORTED_SETUP = "This repository setup is not supported by RepoBD v0.1.";
const UNREADABLE = "Could not read this repository's identity from Git.";

/**
 * The user-facing sentence for a local-resolution failure.
 *
 * Short, and never carrying subprocess output, a remote URL, or a filesystem
 * path — a remote URL can embed a token, and `git.ts` does not return one in
 * the first place. Where a more accurate safe wording exists it is used, so
 * "unsupported" is not reported as though it were a mismatch.
 */
export function describeRepoFailure(
  reason: RepoResolutionFailureReason,
): string {
  switch (reason) {
    case "not-a-repository":
      return "Not inside a Git repository.";
    case "no-origin":
      return "No supported origin repository was found.";
    case "multiple-origin-urls":
    case "unsupported-origin":
    case "malformed-origin-url":
      return UNSUPPORTED_SETUP;
    case "git-unavailable":
      return "Git is required by RepoBD and could not be run.";
    case "git-timeout":
    case "git-output-too-large":
    case "git-failed":
      return UNREADABLE;
  }
}

/** The user-facing sentence for an unreadable delivery link. */
export function describeLinkFailure(reason: LinkParseFailureReason): string {
  if (reason === "unsupported-binding-version") {
    return "This delivery link needs a newer version of RepoBD.";
  }
  // Every other reason gets one wording on purpose. Telling a holder of a
  // malformed link exactly which field failed helps nobody legitimate, and
  // the alternative invites echoing part of the link back into output.
  return "Invalid RepoBD delivery link.";
}

/**
 * The user-facing text for a block, as lines.
 *
 * Mismatch diagnostics carry the two canonical identities and nothing else.
 * Both are non-secret: one came from the link the user just pasted, the other
 * names the repository they are standing in. Neither is a remote URL, so
 * neither can carry a credential.
 */
export function describeBlock(block: GuardBlock): string[] {
  switch (block.kind) {
    case "link":
      return [describeLinkFailure(block.reason)];
    case "repo":
      return [describeRepoFailure(block.reason)];
    case "mismatch": {
      const lines = [
        "Repository mismatch. Secret was not retrieved.",
        `  bound to: ${block.expected}`,
        `  current:  ${block.actual}`,
      ];
      if (block.difference === "case-only") {
        // Worth saying: it is the one mismatch a person can resolve, and the
        // one a machine must not resolve for them.
        lines.push("  These differ only by letter case.");
      }
      return lines;
    }
  }
}
