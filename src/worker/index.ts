// RepoBD Worker API — the remote secret lifecycle: create, claim, consume,
// release.
//
// The server stores ciphertext and non-secret metadata only. It never
// receives a decryption key, never decrypts, and never logs envelope
// contents. See docs/SECURITY_INVARIANTS.md.
//
// Claiming takes a lease and returns the envelope, along with how much of
// that lease remains on the server's clock; it does not consume.
// Consume marks a secret used, but does not prove the receiver applied it —
// that guarantee belongs to the later local apply flow, which calls consume
// only after verifying its own write. Release hands an unused claim back.
//
// Phase 5B: a Cloudflare Workers Rate Limiting admission check (see
// `checkRateLimit`) runs ahead of create and ahead of claim/consume/release,
// on two separate namespaces (`CREATE_LIMITER`, `LIFECYCLE_LIMITER`) so
// retry/renewal traffic on one route can never exhaust the other's budget.
// The threshold each namespace enforces is set per Wrangler config, not
// here — `wrangler.jsonc` (local dev/shared tests) uses a generous
// local-only ceiling, `wrangler.production.jsonc` carries the real fixed
// production policy, and `wrangler.ratelimit-test.jsonc` mirrors production
// for an isolated test. It is a coarse, IP-keyed abuse throttle, not
// authentication, and never touches state — a rejection returns 429 before
// any handler below runs.

import {
  canonicalizeEnvelope,
  claimSecret,
  consumeSecret,
  createSecret,
  releaseSecret,
  type ClaimFailure,
} from "./secrets.js";
import {
  MAX_REQUEST_BODY_BYTES,
  isCapability,
  isTtlSeconds,
  readBoundedText,
} from "./validate.js";

interface Env {
  DB: D1Database;
  // Phase 5B: Cloudflare Workers Rate Limiting. Two separate namespaces —
  // see wrangler.jsonc, wrangler.production.jsonc, and
  // wrangler.ratelimit-test.jsonc for each config's own threshold — so
  // create traffic and lifecycle (claim/consume/release) retry traffic can
  // never share one budget. A binding alone enforces nothing;
  // `checkRateLimit` below is what actually calls it.
  CREATE_LIMITER: RateLimit;
  LIFECYCLE_LIMITER: RateLimit;
}

const SECRET_ACTION_PATH = /^\/api\/secrets\/([^/]+)\/(claim|consume|release)$/;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fixed, non-revealing error shapes. No internal state is disclosed. */
function fail(error: string, status: number): Response {
  return json({ error }, status);
}

const badRequest = () => fail("bad_request", 400);
const notFound = () => fail("not_found", 404);
const rateLimited = () => fail("rate_limited", 429);

/**
 * Coarse per-request rate-limit key. `CF-Connecting-IP` is the header
 * Cloudflare's edge sets on every request it forwards to a Worker; it is
 * absent when running locally without that edge (`wrangler dev`, Vitest),
 * where every request then shares one bucket. This is an abuse throttle,
 * not identity or authentication — RepoBD v0.1 has no account or API key to
 * key on instead, and a shared IP (NAT, corporate egress) can be coarsely
 * over-throttled by it. See docs/SECURITY_INVARIANTS.md and the Phase 5B
 * plan. Never a secret, key, repository identity, or delivery fragment.
 */
function rateLimitKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * Request-admission guard: asks `limiter` whether this request may proceed,
 * before the caller's route handler runs. Returns a 429 response when the
 * limiter rejects, `null` when it permits — the caller's existing behavior
 * is otherwise untouched. Never inspects or logs the request body, the
 * secret id, or the claim id.
 */
async function checkRateLimit(
  limiter: RateLimit,
  request: Request,
): Promise<Response | null> {
  const { success } = await limiter.limit({ key: rateLimitKey(request) });
  return success ? null : rateLimited();
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await readBoundedText(request, MAX_REQUEST_BODY_BYTES);
  if (text === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

async function handleCreate(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (body === null) {
    return badRequest();
  }

  const ttlSeconds = body["ttl_seconds"];
  // Store the validated projection, never the submitted string.
  const envelope = canonicalizeEnvelope(body["envelope"]);
  if (!isTtlSeconds(ttlSeconds) || envelope === null) {
    return badRequest();
  }

  const id = await createSecret(env.DB, envelope, ttlSeconds, Date.now());
  return json({ id }, 201);
}

function lifecycleFailure(reason: ClaimFailure): Response {
  switch (reason) {
    case "not_found":
      return notFound();
    case "expired":
      return fail("expired", 410);
    case "consumed":
      return fail("consumed", 410);
    case "conflict":
      return fail("claim_conflict", 409);
  }
}

/**
 * Every secret action takes the same shape: a capability in the path and a
 * claim token in the body, both validated before the database is touched.
 */
async function readAction(
  request: Request,
  id: string,
): Promise<{ claimId: string } | Response> {
  if (!isCapability(id)) {
    return notFound();
  }
  const body = await readJsonBody(request);
  if (body === null) {
    return badRequest();
  }
  const claimId = body["claim_id"];
  if (!isCapability(claimId)) {
    return badRequest();
  }
  return { claimId };
}

async function handleClaim(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const action = await readAction(request, id);
  if (action instanceof Response) {
    return action;
  }

  const result = await claimSecret(env.DB, id, action.claimId, Date.now());
  if (result.ok) {
    return json(
      {
        envelope: result.envelope,
        claim_expires_at: result.claimExpiresAt,
        // Additive. The state machine is untouched: this is the same claim
        // result, saying how much of the lease is left on the server's clock
        // so a receiver never has to compare timestamps with its own.
        lease_remaining_ms: result.leaseRemainingMs,
      },
      200,
    );
  }
  return lifecycleFailure(result.reason);
}

async function handleConsume(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const action = await readAction(request, id);
  if (action instanceof Response) {
    return action;
  }

  const result = await consumeSecret(env.DB, id, action.claimId, Date.now());
  // 204 whether this call performed the transition or found its own earlier
  // one already recorded — the caller cannot tell the two apart.
  return result.ok ? new Response(null, { status: 204 }) : lifecycleFailure(result.reason);
}

async function handleRelease(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const action = await readAction(request, id);
  if (action instanceof Response) {
    return action;
  }

  const result = await releaseSecret(env.DB, id, action.claimId);
  return result.ok ? new Response(null, { status: 204 }) : lifecycleFailure(result.reason);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/health") {
      if (request.method === "GET") {
        return new Response("ok", { status: 200 });
      }
      if (request.method === "HEAD") {
        return new Response(null, { status: 200 });
      }
      return new Response("method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    if (pathname === "/api/secrets") {
      if (request.method !== "POST") {
        return new Response("method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      // Admission check before any state mutation. A rejected request never
      // reaches handleCreate, so no row is written on a 429.
      const limited = await checkRateLimit(env.CREATE_LIMITER, request);
      if (limited !== null) {
        return limited;
      }
      return handleCreate(request, env);
    }

    const action = SECRET_ACTION_PATH.exec(pathname);
    if (action !== null) {
      if (request.method !== "POST") {
        return new Response("method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      // Same admission check, on the lifecycle namespace — deliberately a
      // separate, more generous budget from create's, so legitimate claim
      // renewal and idempotent retry/recovery are not the traffic that
      // exhausts it. Still strictly before any of claim/consume/release
      // touches D1.
      const limited = await checkRateLimit(env.LIFECYCLE_LIMITER, request);
      if (limited !== null) {
        return limited;
      }
      const id = action[1] as string;
      switch (action[2]) {
        case "claim":
          return handleClaim(request, env, id);
        case "consume":
          return handleConsume(request, env, id);
        case "release":
          return handleRelease(request, env, id);
      }
    }

    return new Response("not found", { status: 404 });
  },
};
