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
 * Consume and release report success without saying whether they changed
 * anything, so a caller cannot learn from the response whether its earlier
 * attempt had already landed.
 */
export type LifecycleResult =
  | { ok: true }
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
 * Marks a secret consumed.
 *
 * Phase 2 cannot know whether the receiver's local apply actually succeeded;
 * this is only the remote primitive the later apply flow calls once it has
 * verified its own write. Nothing here proves delivery.
 *
 * The first transition is one conditional UPDATE. The follow-up read exists
 * only to tell a lost-response retry apart from a genuine conflict, and
 * never performs the transition itself.
 */
export async function consumeSecret(
  db: D1Database,
  id: string,
  claimId: string,
  now: number,
): Promise<LifecycleResult> {
  const consumed = await db
    .prepare(
      `UPDATE secrets
          SET state = 'consumed',
              consumed_at = ?1,
              claim_expires_at = NULL
        WHERE id = ?2
          AND state = 'claimed'
          AND claim_id = ?3
          AND expires_at > ?1
          AND claim_expires_at > ?1`,
    )
    .bind(now, id, claimId)
    .run();

  if (consumed.meta.changes === 1) {
    return { ok: true };
  }

  const row = await readConsumeDiagnostics(db, id);
  if (row === null) {
    return { ok: false, reason: "not_found" };
  }

  if (row.state === "consumed") {
    // The winning token is kept on the row precisely so this retry can be
    // recognised. consumed_at keeps its original value: the transition
    // already happened, and this call is only learning about it.
    return row.claim_id === claimId
      ? { ok: true }
      : { ok: false, reason: "consumed" };
  }

  if (row.expires_at <= now) {
    return { ok: false, reason: "expired" };
  }
  // Not claimed by this caller, or the lease has lapsed. Both are reported
  // the same way so a caller learns nothing about the current holder.
  return { ok: false, reason: "conflict" };
}

/**
 * Returns a claimed secret to the available pool.
 *
 * The token must match the *current* holder. A stale token from an earlier,
 * already-released claim therefore cannot clear whoever holds the lease now.
 *
 * Expiry is deliberately not part of the condition: an expired secret stays
 * unusable because claim and consume both require `expires_at > now`, so
 * releasing one changes nothing rather than resurrecting it.
 */
export async function releaseSecret(
  db: D1Database,
  id: string,
  claimId: string,
): Promise<LifecycleResult> {
  const released = await db
    .prepare(
      `UPDATE secrets
          SET state = 'available',
              claim_id = NULL,
              claim_expires_at = NULL
        WHERE id = ?1
          AND state = 'claimed'
          AND claim_id = ?2`,
    )
    .bind(id, claimId)
    .run();

  if (released.meta.changes === 1) {
    return { ok: true };
  }

  const row = await readReleaseDiagnostics(db, id);
  if (row === null) {
    return { ok: false, reason: "not_found" };
  }
  if (row.state === "consumed") {
    // Terminal. Releasing must never restore availability.
    return { ok: false, reason: "consumed" };
  }
  if (row.state === "available") {
    // Already not held by this caller — the requested end state. Reporting
    // success keeps a lost-response retry safe without recording any
    // release history.
    return { ok: true };
  }
  return { ok: false, reason: "conflict" };
}

// Diagnostic reads. Each selects only what its caller needs to shape an
// error, and none of them decides a transition. They are kept separate so
// that the current holder's bearer token is fetched only on the one path
// that must compare against it: recognising a consume retry. A failed claim
// or release never loads someone else's token into memory.

/** For claim failures: enough to tell expired from consumed from conflict. */
async function readClaimDiagnostics(
  db: D1Database,
  id: string,
): Promise<{ state: string; expires_at: number } | null> {
  return db
    .prepare(`SELECT state, expires_at FROM secrets WHERE id = ?`)
    .bind(id)
    .first<{ state: string; expires_at: number }>();
}

/** For release failures: only the state distinguishes the outcomes. */
async function readReleaseDiagnostics(
  db: D1Database,
  id: string,
): Promise<{ state: string } | null> {
  return db
    .prepare(`SELECT state FROM secrets WHERE id = ?`)
    .bind(id)
    .first<{ state: string }>();
}

/**
 * For consume failures. This is the one diagnostic that legitimately needs
 * the stored token: an idempotent retry is exactly the case where the
 * caller's token equals the one that won.
 */
async function readConsumeDiagnostics(
  db: D1Database,
  id: string,
): Promise<{
  state: string;
  expires_at: number;
  claim_id: string | null;
} | null> {
  return db
    .prepare(`SELECT state, expires_at, claim_id FROM secrets WHERE id = ?`)
    .bind(id)
    .first<{ state: string; expires_at: number; claim_id: string | null }>();
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
  const row = await readClaimDiagnostics(db, id);

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
