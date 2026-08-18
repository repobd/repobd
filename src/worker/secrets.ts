// Secret lifecycle against D1.
//
// The envelope's contents are opaque here: it arrives already encrypted and
// is handed back unchanged. Nothing in this file decrypts, and no decryption
// key exists on the server. See docs/SECURITY_INVARIANTS.md.

import {
  parseEnvelope,
  serializeEnvelope,
} from "../crypto/envelope-format.js";
import { generateCapability } from "./validate.js";

/** Claim lease length. Always clamped to the secret's own expiry. */
export const CLAIM_LEASE_MS = 5 * 60 * 1000;

export type ClaimFailure = "not_found" | "expired" | "consumed" | "conflict";

export type ClaimResult =
  | { ok: true; envelope: string; claimExpiresAt: number }
  | { ok: false; reason: ClaimFailure };

/**
 * Validates a submitted envelope and returns its canonical form, or null if
 * it is not a well-formed envelope.
 *
 * The return value — not the submitted string — is what gets stored. The
 * parser projects exactly `v`, `alg`, `iv`, `ct`, so re-serializing that
 * projection drops any additional properties the sender smuggled inside the
 * envelope JSON. Persisting the original string would let an attacker park
 * arbitrary fields, including something named `key` or `plaintext`, in the
 * database and get them back out again.
 *
 * This uses the shared wire-format module rather than restating its rules, so
 * canonical base64url validation has one implementation. That module carries
 * no cryptographic runtime, so validating an envelope here never gives the
 * Worker the ability to decrypt one.
 */
export function canonicalizeEnvelope(envelope: unknown): string | null {
  if (typeof envelope !== "string") {
    return null;
  }
  try {
    return serializeEnvelope(parseEnvelope(envelope));
  } catch {
    return null;
  }
}

/** Stores an encrypted envelope and returns its bearer capability id. */
export async function createSecret(
  db: D1Database,
  envelope: string,
  ttlSeconds: number,
  now: number,
): Promise<string> {
  const id = generateCapability();
  await db
    .prepare(
      `INSERT INTO secrets (id, envelope, created_at, expires_at, state)
       VALUES (?, ?, ?, ?, 'available')`,
    )
    .bind(id, envelope, now, now + ttlSeconds * 1000)
    .run();
  return id;
}

/**
 * Takes or renews a claim lease.
 *
 * Ownership is decided by one conditional UPDATE whose affected-row count is
 * the authority, so two racing claimants cannot both win. The WHERE clause
 * admits exactly three situations: the secret is unclaimed, the caller
 * already holds it (a lost-response retry), or the previous lease has
 * lapsed. A live lease held by a different token matches nothing.
 *
 * The follow-up SELECT only reads back what the caller now owns; it re-checks
 * ownership so it cannot hand the envelope to a caller who does not hold the
 * lease. The UPDATE and SELECT run in one batch, which D1 executes
 * sequentially as a transaction.
 */
export async function claimSecret(
  db: D1Database,
  id: string,
  claimId: string,
  now: number,
): Promise<ClaimResult> {
  const leaseEnd = now + CLAIM_LEASE_MS;

  const [claim, read] = await db.batch<{
    envelope: string;
    claim_expires_at: number;
  }>([
    db
      .prepare(
        `UPDATE secrets
            SET state = 'claimed',
                claim_id = ?1,
                claim_expires_at = MIN(?2, expires_at)
          WHERE id = ?3
            AND expires_at > ?4
            AND state <> 'consumed'
            AND (state = 'available'
                 OR claim_id = ?1
                 OR claim_expires_at <= ?4)`,
      )
      .bind(claimId, leaseEnd, id, now),
    db
      .prepare(
        `SELECT envelope, claim_expires_at
           FROM secrets
          WHERE id = ?1 AND state = 'claimed' AND claim_id = ?2`,
      )
      .bind(id, claimId),
  ]);

  if (claim?.meta.changes === 1) {
    const row = read?.results[0];
    if (row !== undefined) {
      return {
        ok: true,
        envelope: row.envelope,
        claimExpiresAt: row.claim_expires_at,
      };
    }
    // The lease was taken but is already gone. Treat as a conflict rather
    // than releasing an envelope we can no longer prove we hold.
    return { ok: false, reason: "conflict" };
  }

  return { ok: false, reason: await classifyClaimFailure(db, id, now) };
}

/**
 * Explains a failed claim for the error response only. This is diagnostic:
 * the UPDATE above already decided the outcome. It deliberately reads no
 * other caller's claim token.
 */
async function classifyClaimFailure(
  db: D1Database,
  id: string,
  now: number,
): Promise<ClaimFailure> {
  const row = await db
    .prepare(`SELECT state, expires_at FROM secrets WHERE id = ?`)
    .bind(id)
    .first<{ state: string; expires_at: number }>();

  if (row === null) {
    return "not_found";
  }
  if (row.state === "consumed") {
    return "consumed";
  }
  if (row.expires_at <= now) {
    return "expired";
  }
  return "conflict";
}
