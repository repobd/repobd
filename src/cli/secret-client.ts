// RepoBD secret transport client — the only code in the CLI that reaches the
// network, and the seam the guard is proven to run in front of.
//
// It speaks the Phase 2 Worker contract unchanged: claim takes a lease and
// returns the envelope, release hands an unused claim back, and consume
// belongs to the later apply flow. Nothing here alters claim idempotency,
// lease rules, TTL, or envelope semantics.
//
// What a request carries is exactly a claim token. Repository identity is not
// a parameter of any function in this file, is not part of any request body,
// and is not part of any URL: the server has no field for it and must never
// learn it. Neither the decryption key nor the delivery fragment is reachable
// from here — the caller passes an origin and a secret id, and nothing else.
//
// Nothing here logs. Response bodies, envelopes, and error text are returned
// to the caller, never printed.

import { generateCapability } from "./capability.js";

/** Network calls are bounded so a stalled service cannot hang the CLI. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Generates a fresh claim token, in the same capability format the Worker
 * validates. See `capability.ts` for why that rule lives there.
 */
export function generateClaimToken(): string {
  return generateCapability();
}

export type SecretClientFailure =
  | "not-found"
  | "expired"
  | "consumed"
  | "claim-conflict"
  | "rejected"
  | "unreachable"
  | "malformed-response";

export type ClaimOutcome =
  | {
      readonly ok: true;
      /** The encrypted envelope, opaque here. Never logged. */
      readonly envelope: string;
      readonly claimExpiresAt: number;
    }
  | { readonly ok: false; readonly reason: SecretClientFailure };

export type ReleaseOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SecretClientFailure };

/**
 * The network seam.
 *
 * An interface rather than a direct call so a test can supply an
 * implementation that counts invocations, which is how "a mismatch never
 * reaches the network" is asserted as behavior rather than read off the
 * source order.
 */
export interface SecretClient {
  claim(secretId: string, claimToken: string): Promise<ClaimOutcome>;
  release(secretId: string, claimToken: string): Promise<ReleaseOutcome>;
}

/** Injectable for the same reason. Defaults to the platform's fetch. */
export type FetchLike = typeof fetch;

function actionUrl(origin: string, secretId: string, action: string): string {
  // The id is already restricted to a URL-safe token by the link parser; it is
  // encoded again here so this function is safe on its own terms.
  return `${origin.replace(/\/+$/, "")}/api/secrets/${encodeURIComponent(secretId)}/${action}`;
}

function failureForStatus(status: number, error: unknown): SecretClientFailure {
  if (status === 404) {
    return "not-found";
  }
  if (status === 409) {
    return "claim-conflict";
  }
  if (status === 410) {
    return error === "consumed" ? "consumed" : "expired";
  }
  return "rejected";
}

export function createHttpSecretClient(
  origin: string,
  fetchImpl: FetchLike = fetch,
): SecretClient {
  async function post(
    secretId: string,
    action: string,
    claimToken: string,
  ): Promise<{ status: number; body: unknown } | null> {
    try {
      const response = await fetchImpl(actionUrl(origin, secretId, action), {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The complete request body. There is no repository field, no
        // binding, no key, and no fragment — by construction, not by filter.
        body: JSON.stringify({ claim_id: claimToken }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 204) {
        return { status: 204, body: null };
      }
      const text = await response.text();
      let body: unknown = null;
      if (text !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, body };
    } catch {
      // Transport-level failures are reduced to one reason. The underlying
      // error is not surfaced: it can contain the request URL, and it says
      // nothing a user can act on beyond "it did not reach the service".
      return null;
    }
  }

  return {
    async claim(secretId, claimToken) {
      const result = await post(secretId, "claim", claimToken);
      if (result === null) {
        return { ok: false, reason: "unreachable" };
      }
      const body = result.body as Record<string, unknown> | null;
      if (result.status !== 200) {
        return {
          ok: false,
          reason: failureForStatus(result.status, body?.["error"]),
        };
      }
      const envelope = body?.["envelope"];
      const claimExpiresAt = body?.["claim_expires_at"];
      if (typeof envelope !== "string" || typeof claimExpiresAt !== "number") {
        return { ok: false, reason: "malformed-response" };
      }
      return { ok: true, envelope, claimExpiresAt };
    },

    async release(secretId, claimToken) {
      const result = await post(secretId, "release", claimToken);
      if (result === null) {
        return { ok: false, reason: "unreachable" };
      }
      if (result.status !== 204) {
        const body = result.body as Record<string, unknown> | null;
        return {
          ok: false,
          reason: failureForStatus(result.status, body?.["error"]),
        };
      }
      return { ok: true };
    },
  };
}
