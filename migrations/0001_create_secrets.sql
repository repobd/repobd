-- RepoBD Phase 2: encrypted-envelope transport storage.
--
-- Stores the already-encrypted Phase 1 envelope and the non-secret metadata
-- needed to enforce TTL and one-time consumption. The server never receives
-- plaintext or the decryption key, so neither is represented here.
-- See docs/SECURITY_INVARIANTS.md.

CREATE TABLE secrets (
  -- 128-bit random base64url bearer capability.
  id               TEXT PRIMARY KEY,
  -- The Phase 1 encrypted envelope, stored opaquely. Never decrypted here.
  envelope         TEXT NOT NULL,
  -- Epoch milliseconds.
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  -- Expiry is derived from expires_at rather than being a state, so an
  -- expired row is unusable whether or not it has been cleaned up.
  state            TEXT NOT NULL CHECK (state IN ('available', 'claimed', 'consumed')),
  -- Set while a claim lease is held, and retained after consume so a retry
  -- with the same token can be recognised.
  claim_id         TEXT,
  claim_expires_at INTEGER,
  consumed_at      INTEGER
);

-- Supports expiry scans. Lifecycle transitions look rows up by primary key.
CREATE INDEX idx_secrets_expires_at ON secrets(expires_at);
