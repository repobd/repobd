// RepoBD Worker API — Phase 2B: create and claim.
//
// The server stores ciphertext and non-secret metadata only. It never
// receives a decryption key, never decrypts, and never logs envelope
// contents. See docs/SECURITY_INVARIANTS.md.
//
// Consume and release are Phase 2C and are deliberately absent.

import { canonicalizeEnvelope, claimSecret, createSecret } from "./secrets.js";
import {
  MAX_REQUEST_BODY_BYTES,
  isCapability,
  isTtlSeconds,
  readBoundedText,
} from "./validate.js";

interface Env {
  DB: D1Database;
}

const CLAIM_PATH = /^\/api\/secrets\/([^/]+)\/claim$/;

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

async function handleClaim(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  // Reject a malformed capability before touching the database.
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

  const result = await claimSecret(env.DB, id, claimId, Date.now());
  if (result.ok) {
    return json(
      { envelope: result.envelope, claim_expires_at: result.claimExpiresAt },
      200,
    );
  }

  switch (result.reason) {
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

    const claimMatch = CLAIM_PATH.exec(pathname);
    if (claimMatch !== null) {
      if (request.method !== "POST") {
        return new Response("method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      return handleClaim(request, env, claimMatch[1] as string);
    }

    return new Response("not found", { status: 404 });
  },
};
