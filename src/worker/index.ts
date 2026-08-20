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
