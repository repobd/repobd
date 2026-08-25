import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ENVELOPE_ALG,
  ENVELOPE_VERSION,
  serializeEnvelope,
  toBase64Url,
} from "../src/crypto/envelope-format.js";

// Phase 5B: the Cloudflare Workers Rate Limiting admission guard —
// wrangler.ratelimit-test.jsonc's exact fixed thresholds, the same values
// wrangler.production.jsonc deploys with (CREATE_LIMITER: 20/60s,
// LIFECYCLE_LIMITER: 120/60s), are exercised for real here, not mocked, via
// Miniflare's local simulation of the binding, in a Worker instance
// isolated from every other test file — see
// test/vitest.worker-ratelimit.config.ts. wrangler.jsonc (local dev and the
// shared worker test suite) uses a much more generous 1000/60s on both
// namespaces instead; it is not exercised by this file. See
// docs/SECURITY_INVARIANTS.md and the Phase 5B plan for the policy this
// enforces.

const BASE = "https://example.com";
const CREATE_LIMIT = 20;
const LIFECYCLE_LIMIT = 120;

interface SecretRow {
  id: string;
  state: string;
  claim_id: string | null;
  claim_expires_at: number | null;
  consumed_at: number | null;
}

async function makeEnvelope(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKey;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      new TextEncoder().encode("API_KEY=TEST_ALPHA_123456"),
    ),
  );
  return serializeEnvelope({
    v: ENVELOPE_VERSION,
    alg: ENVELOPE_ALG,
    iv: toBase64Url(iv),
    ct: toBase64Url(ciphertext),
  });
}

function capability(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function create(envelope: string): Promise<Response> {
  return post("/api/secrets", { envelope, ttl_seconds: 3600 });
}

function claim(id: string, claimId: string): Promise<Response> {
  return post(`/api/secrets/${id}/claim`, { claim_id: claimId });
}

function consume(id: string, claimId: string): Promise<Response> {
  return post(`/api/secrets/${id}/consume`, { claim_id: claimId });
}

function release(id: string, claimId: string): Promise<Response> {
  return post(`/api/secrets/${id}/release`, { claim_id: claimId });
}

async function expectNonSensitive429(response: Response): Promise<void> {
  expect(response.status).toBe(429);
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body["error"]).toBe("rate_limited");
}

async function rowCount(): Promise<number> {
  const result = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM secrets",
  ).first<{ n: number }>();
  return result?.n ?? 0;
}

async function fetchRow(id: string): Promise<SecretRow | null> {
  return env.DB.prepare(
    "SELECT id, state, claim_id, claim_expires_at, consumed_at FROM secrets WHERE id = ?",
  )
    .bind(id)
    .first<SecretRow>();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM secrets").run();
});

describe("rate limiting", () => {
  it(
    "enforces the create and lifecycle budgets independently, exempts " +
      "/health, and rejects with a non-sensitive 429 before any state mutation",
    async () => {
      // A single shared instance of this test file's Miniflare Worker keeps
      // one rate-limit counter per namespace across every request below, so
      // this is deliberately one long scenario rather than several small
      // tests whose ordering/isolation this suite must not depend on.
      const envelope = await makeEnvelope();

      // --- create limiter: exactly 20/60s ---
      const createdIds: string[] = [];
      for (let i = 0; i < CREATE_LIMIT; i++) {
        const response = await create(envelope);
        expect(response.status).toBe(201);
        const { id } = (await response.json()) as { id: string };
        createdIds.push(id);
      }
      expect(await rowCount()).toBe(CREATE_LIMIT);

      // The 21st create in this window is rejected before any row is
      // written — existing behavior for the first 20 is otherwise
      // untouched.
      await expectNonSensitive429(await create(envelope));
      expect(await rowCount()).toBe(CREATE_LIMIT);

      // --- route separation: lifecycle traffic is unaffected by an
      // exhausted create budget, because it is a different binding/namespace ---
      const routeSeparationId = createdIds[0] as string;
      const routeSeparationClaimId = capability();
      const claimResponse = await claim(
        routeSeparationId,
        routeSeparationClaimId,
      );
      expect(claimResponse.status).toBe(200);
      const consumeResponse = await consume(
        routeSeparationId,
        routeSeparationClaimId,
      );
      expect(consumeResponse.status).toBe(204);

      // --- /health is exempt from both budgets regardless of volume ---
      for (let i = 0; i < CREATE_LIMIT + 5; i++) {
        const health = await SELF.fetch(`${BASE}/health`);
        expect(health.status).toBe(200);
      }

      // --- lifecycle limiter: exactly 120/60s, a separate budget from
      // create's. A `liveTarget` row is reserved untouched, in its original
      // available state, throughout budget exhaustion, so the eventual
      // rejection is tested against a row a permitted request genuinely
      // could still have mutated — not one already terminal. Budget is
      // spent instead against a separate `spender` row: the two calls
      // already made above (claim + consume of routeSeparationId) count
      // against the same lifecycle budget, so spend the remaining
      // (120 - 2) admissions against spender before touching liveTarget at
      // all.
      const liveTargetId = createdIds[1] as string;
      const spenderId = createdIds[2] as string;
      const spenderClaimId = capability();

      const alreadySpent = 2; // claim + consume of routeSeparationId, above
      for (let i = alreadySpent; i < LIFECYCLE_LIMIT; i++) {
        // Claiming is idempotent for the same token and doubles as lease
        // renewal (ARCHITECTURE.md), so each of these repeats succeeds
        // (200) against spender — the point is only that the admission
        // check runs, and therefore spends one unit of lifecycle budget,
        // on every one of these calls, never on liveTarget.
        const response = await claim(spenderId, spenderClaimId);
        expect(response.status).toBe(200);
      }

      const beforeRejection = await fetchRow(liveTargetId);
      expect(beforeRejection).toEqual({
        id: liveTargetId,
        state: "available",
        claim_id: null,
        claim_expires_at: null,
        consumed_at: null,
      });

      // The 121st lifecycle call in this window is rejected — against a row
      // that was still genuinely mutable a moment before, proving the
      // admission guard runs strictly before the claim handler, not merely
      // before an already-terminal one.
      const rejectedClaimId = capability();
      await expectNonSensitive429(await claim(liveTargetId, rejectedClaimId));

      const afterRejection = await fetchRow(liveTargetId);
      expect(afterRejection).toEqual(beforeRejection);

      // The same holds for consume and release on the same still-rejected
      // window: neither reaches its handler either.
      await expectNonSensitive429(
        await consume(liveTargetId, rejectedClaimId),
      );
      await expectNonSensitive429(
        await release(liveTargetId, rejectedClaimId),
      );
      expect(await fetchRow(liveTargetId)).toEqual(beforeRejection);
    },
  );
});
