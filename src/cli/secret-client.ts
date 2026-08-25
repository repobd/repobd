// RepoBD secret transport client — the only code in the CLI that reaches the
// network, and the seam the guard is proven to run in front of.
//
// It speaks the Phase 2 Worker contract unchanged: create stores a ciphertext
// envelope, claim takes a lease and returns the envelope, release hands an
// unused claim back, and consume marks a delivery used. Nothing here alters
// claim idempotency, lease rules, TTL, or envelope semantics, and no endpoint
// was added for Phase 4 or Phase 5A — create and consume are both endpoints
// the Worker has always exposed and this is simply the first CLI caller of
// create.
//
// Claim doubles as lease renewal. The Worker's claim admits a caller that
// already holds the lease and one whose lease has lapsed, both keyed on the
// same token, so re-issuing a claim with the token already held renews it and
// returns `claim-conflict` if someone else has taken it in the meantime. That
// is why there is no separate renew method: renewing is claiming again.
//
// What a request carries is exactly a claim token. Repository identity is not
// a parameter of any function in this file, is not part of any request body,
// and is not part of any URL: the server has no field for it and must never
// learn it. Neither the decryption key nor the delivery fragment is reachable
// from here — the caller passes an origin and a secret id, and nothing else.
//
// Nothing here logs. Response bodies, envelopes, and error text are returned
// to the caller, never printed.

import { generateCapability, isCapability } from "./capability.js";
import {
  parseServiceOrigin,
  type ServiceOriginFailureReason,
} from "./link.js";

/** Network calls are bounded so a stalled service cannot hang the CLI. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Environment variable naming the RepoBD service this CLI talks to. */
export const SERVER_ORIGIN_ENV = "REPOBD_SERVER_URL";

/** Where a development Wrangler run serves the Worker. Loopback, so http. */
export const DEFAULT_SERVER_ORIGIN = "http://localhost:8787";

export type ServerOriginResolution =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly reason: ServiceOriginFailureReason };

/**
 * The origin the CLI addresses its own requests to.
 *
 * Deliberately the smallest mechanism that works: one environment variable,
 * one local-development default, and no configuration file, flag, or lookup
 * order beyond those two. v0.1 has no deployed service, so there is nothing
 * else to select between yet.
 *
 * Whatever the environment supplies is validated by `parseServiceOrigin` — the
 * same policy the delivery-link builder and parser share — and returned
 * normalized. A configured value that is not a usable origin fails here, at
 * the point of resolution, so a caller resolves before it prompts and nothing
 * is typed or sent against an origin RepoBD would not address.
 *
 * The value is not a secret and is never printed — an origin can be mistyped
 * into something that looks like a hostname and is not, and echoing it back is
 * how a mistyped host ends up quoted in a terminal alongside a link. The
 * failure carries a reason, never the value.
 */
export function resolveServerOrigin(
  env: Record<string, string | undefined> = process.env,
): ServerOriginResolution {
  const configured = env[SERVER_ORIGIN_ENV];
  const raw =
    typeof configured === "string" && configured.trim() !== ""
      ? configured
      : DEFAULT_SERVER_ORIGIN;
  const parsed = parseServiceOrigin(raw);
  return parsed.ok
    ? { ok: true, origin: parsed.origin }
    : { ok: false, reason: parsed.reason };
}

/**
 * The longest lease the Phase 2 contract can grant.
 *
 * Mirrors `CLAIM_LEASE_MS` in `src/worker/secrets.ts`. It is restated rather
 * than imported because the CLI does not take a dependency on Worker code, and
 * a test pins the two to the same value so they cannot drift apart quietly.
 *
 * It is used as a validity bound, not as a timer: a response claiming more
 * lease than the service can issue is not a generous lease, it is a response
 * this client should not act on.
 */
export const MAX_CLAIM_LEASE_MS = 5 * 60_000;

/**
 * Whether a value is lease evidence this client may act on.
 *
 * `typeof x === "number"` is not enough, and that gap was real: JSON has no
 * bound on numeric literals, so a body containing `1e400` parses to
 * `Infinity` in Node — a value that satisfies every naive `>= minimum` check
 * ever written. `NaN` fails such checks by accident rather than by design.
 * Both are excluded here explicitly, along with negatives and anything beyond
 * what the protocol can actually grant.
 */
function isValidLease(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_CLAIM_LEASE_MS
  );
}

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
      /**
       * How long the lease still has, measured by the server.
       *
       * This is the only lease figure a caller should make decisions from. The
       * absolute `claimExpiresAt` is a server timestamp, and comparing it with
       * a local clock silently assumes the two agree — which is exactly the
       * assumption that lets a receiver write against a lease the server
       * already considers expired.
       */
      readonly leaseRemainingMs: number;
    }
  | { readonly ok: false; readonly reason: SecretClientFailure };

export type CreateOutcome =
  | {
      readonly ok: true;
      /** The server-minted secret id. Validated as a canonical capability. */
      readonly id: string;
    }
  | { readonly ok: false; readonly reason: SecretClientFailure };

export type ReleaseOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SecretClientFailure };

/** Consume reports the same shape as release: it either happened or did not. */
export type ConsumeOutcome = ReleaseOutcome;

/**
 * The network seam.
 *
 * An interface rather than a direct call so a test can supply an
 * implementation that counts invocations, which is how "a mismatch never
 * reaches the network" is asserted as behavior rather than read off the
 * source order.
 */
export interface SecretClient {
  /**
   * Stores an already-encrypted envelope and returns the id it was stored
   * under.
   *
   * The complete request is the ciphertext and a lifetime. There is no claim
   * token — nothing has been claimed yet — and, as everywhere else in this
   * file, no repository identity and no key.
   */
  create(envelope: string, ttlSeconds: number): Promise<CreateOutcome>;
  /** Takes the lease and returns the envelope; also renews a lease already
   * held by this same token. */
  claim(secretId: string, claimToken: string): Promise<ClaimOutcome>;
  /** Hands an unused claim back, leaving the delivery available. */
  release(secretId: string, claimToken: string): Promise<ReleaseOutcome>;
  /**
   * Marks the delivery used. Called only after a local apply has been written
   * and read back — the Worker cannot know whether that happened, so the
   * ordering guarantee lives entirely on this side.
   */
  consume(secretId: string, claimToken: string): Promise<ConsumeOutcome>;
}

/** Injectable for the same reason. Defaults to the platform's fetch. */
export type FetchLike = typeof fetch;

function secretsUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/secrets`;
}

function actionUrl(origin: string, secretId: string, action: string): string {
  // The id is already restricted to a URL-safe token by the link parser; it is
  // encoded again here so this function is safe on its own terms.
  return `${secretsUrl(origin)}/${encodeURIComponent(secretId)}/${action}`;
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
  async function postJson(
    url: string,
    requestBody: string,
  ): Promise<{ status: number; body: unknown } | null> {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The complete request body, composed by the caller as an exact
        // projection. There is no repository field, no binding, no key, and no
        // fragment in any of them — by construction, not by filter.
        body: requestBody,
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

  const post = async (
    secretId: string,
    action: string,
    claimToken: string,
  ): Promise<{ status: number; body: unknown } | null> =>
    postJson(
      actionUrl(origin, secretId, action),
      JSON.stringify({ claim_id: claimToken }),
    );

  return {
    async create(envelope, ttlSeconds) {
      const result = await postJson(
        secretsUrl(origin),
        // The whole request: ciphertext and a lifetime. The plaintext never
        // existed in this module and the key never reaches it.
        JSON.stringify({ envelope, ttl_seconds: ttlSeconds }),
      );
      if (result === null) {
        return { ok: false, reason: "unreachable" };
      }
      const body = result.body as Record<string, unknown> | null;
      if (result.status !== 201) {
        // Create has no claim token and no delivery to be expired, consumed or
        // conflicted over, so in practice this is `rejected` or `not-found`;
        // the shared mapping is used anyway so one status table serves the
        // whole client.
        return {
          ok: false,
          reason: failureForStatus(result.status, body?.["error"]),
        };
      }
      const id = body?.["id"];
      // Checked here, before it is ever put in a URL or a link. An id that is
      // not a canonical capability is one `parseDeliveryLink` would refuse on
      // the receiving side, so accepting it would only produce a link that
      // cannot be pulled.
      if (typeof id !== "string" || !isCapability(id)) {
        return { ok: false, reason: "malformed-response" };
      }
      return { ok: true, id };
    },

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
      const leaseRemainingMs = body?.["lease_remaining_ms"];
      if (
        typeof envelope !== "string" ||
        typeof claimExpiresAt !== "number" ||
        !isValidLease(leaseRemainingMs)
      ) {
        // Required, not optional, and required to be a real duration. A
        // response without server-measured lease evidence is one this client
        // cannot decide from, and guessing from the local clock instead is the
        // failure mode the field exists to remove.
        return { ok: false, reason: "malformed-response" };
      }
      return { ok: true, envelope, claimExpiresAt, leaseRemainingMs };
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

    async consume(secretId, claimToken) {
      const result = await post(secretId, "consume", claimToken);
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
      // The Worker answers 204 both for the transition this call performed and
      // for one this same token already performed, so a lost response followed
      // by a retry is indistinguishable from a first success — which is what
      // makes retrying it safe.
      return { ok: true };
    },
  };
}
