// RepoBD repository binding descriptor — the value that travels with a
// delivery and names the repository the secret was prepared for.
//
// The descriptor is a context guardrail, not authentication. It is not signed,
// not bound to the ciphertext, and not tamper-proof: whoever holds the
// delivery URL can rewrite or delete it, and that person already holds the
// decryption key. What the descriptor prevents is the accident — applying a
// valid secret to the wrong repository — which is why a missing or unreadable
// descriptor blocks rather than passing through.
//
// What it carries is a hosted repository locator, not the original Git
// transport. Two developers who clone the same GitHub repository over HTTPS
// and over SSH hold the same binding.
//
// Pure, like `identity.ts`: no I/O, no Git, no network, no crypto. Nothing
// here reads or emits secret material, and no error message carries any.

import {
  validateCanonicalRepoIdentity,
  type CanonicalRepo,
} from "./identity.js";

/** Incremented only when the descriptor's meaning changes. An unrecognized
 * version blocks: an older client cannot know what a newer rule intended. */
export const BINDING_VERSION = 1;

export interface RepoBinding {
  readonly bv: number;
  /** Canonical repository identity, exactly as `identity.ts` defines it. */
  readonly repo: string;
}

export type BindingParseFailureReason =
  | "not-json"
  | "not-an-object"
  | "invalid-version"
  | "unsupported-version"
  | "invalid-repo";

export type BindingParseResult =
  | {
      readonly ok: true;
      readonly binding: RepoBinding;
      /** The validated identity, so callers need not re-parse it. */
      readonly repo: CanonicalRepo;
    }
  | {
      readonly ok: false;
      readonly reason: BindingParseFailureReason;
      readonly detail: string;
    };

function fail(
  reason: BindingParseFailureReason,
  detail: string,
): BindingParseResult {
  return { ok: false, reason, detail };
}

/**
 * Serializes an exact projection of the two approved fields.
 *
 * Taking a `CanonicalRepo` rather than a string means an uncanonicalized value
 * cannot be bound in the first place, and projecting the fields explicitly
 * means no extra property a runtime object happens to carry can ride along
 * into the descriptor.
 */
export function serializeBinding(repo: CanonicalRepo): string {
  return JSON.stringify({ bv: BINDING_VERSION, repo: repo.canonical });
}

/**
 * Parses and fully validates a descriptor.
 *
 * The `repo` field must already be a canonical identity naming a supported
 * host. A raw clone URL is rejected rather than canonicalized on the
 * receiver's behalf, so both sides agree on one spelling and a sender cannot
 * shift the comparison by choosing a different one.
 */
export function parseBinding(json: string): BindingParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail("not-json", "descriptor is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("not-an-object", "descriptor is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const bv = record["bv"];
  const repo = record["repo"];
  if (typeof bv !== "number") {
    return fail("invalid-version", "bv is not a number");
  }
  if (bv !== BINDING_VERSION) {
    return fail("unsupported-version", `binding version ${String(bv)}`);
  }
  if (typeof repo !== "string") {
    return fail("invalid-repo", "repo is not a string");
  }
  const canonical = validateCanonicalRepoIdentity(repo);
  if (!canonical.ok) {
    return fail("invalid-repo", `repo is not canonical: ${canonical.reason}`);
  }
  // Only the approved fields survive; anything else the input carried is
  // dropped here rather than propagated to callers.
  return {
    ok: true,
    binding: { bv: BINDING_VERSION, repo: canonical.repo.canonical },
    repo: canonical.repo,
  };
}

/**
 * Why two identities differ. Purely diagnostic — every value other than `none`
 * blocks. It exists so the receiver can tell a person the difference is only
 * letter case, which is the kind of mismatch a person can resolve and a
 * machine must not resolve for them.
 */
export type BindingDifference = "none" | "case-only" | "other";

export type BindingVerification =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly expected: string;
      readonly actual: string;
      readonly difference: BindingDifference;
    };

/**
 * Compares the bound identity against the current repository's identity.
 *
 * Exact, case-sensitive string equality. No prefix, suffix, alias, or fuzzy
 * matching: a false positive here applies a secret to the wrong repository,
 * while a false negative only asks a person to look.
 */
export function verifyBinding(
  expected: CanonicalRepo,
  actual: CanonicalRepo,
): BindingVerification {
  if (expected.canonical === actual.canonical) {
    return { ok: true };
  }
  // Hosts are drawn from a lowercase allowlist, so a case-insensitive match
  // can only mean the paths differ in case — the exact collision that keeping
  // path case significant is there to prevent.
  const difference: BindingDifference =
    expected.canonical.toLowerCase() === actual.canonical.toLowerCase()
      ? "case-only"
      : "other";
  return {
    ok: false,
    expected: expected.canonical,
    actual: actual.canonical,
    difference,
  };
}
