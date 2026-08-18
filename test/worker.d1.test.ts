import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// Phase 2A proves persistence only: the migration applies, the Worker test
// environment has the D1 binding, and a row round trips. Lifecycle behaviour
// (claim / consume / release / TTL enforcement) is Phase 2B onward.

// Synthetic, obviously fake stand-in for an encrypted envelope. No real
// secret, and nothing here is decrypted.
const FAKE_ENVELOPE = JSON.stringify({
  v: 1,
  alg: "A256GCM",
  iv: "AAAAAAAAAAAAAAAA",
  ct: "ZmFrZS1jaXBoZXJ0ZXh0LWZvci10ZXN0cw",
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM secrets").run();
});

describe("local D1 harness", () => {
  it("exposes the D1 binding to the test environment", () => {
    expect(env.DB).toBeDefined();
    expect(typeof env.DB.prepare).toBe("function");
  });

  it("has applied the migration, creating the secrets table", async () => {
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'secrets'",
    ).first<{ name: string }>();
    expect(table?.name).toBe("secrets");
  });

  it("has created the expiry index", async () => {
    const index = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_secrets_expires_at'",
    ).first<{ name: string }>();
    expect(index?.name).toBe("idx_secrets_expires_at");
  });

  it("round trips a row", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO secrets (id, envelope, created_at, expires_at, state)
       VALUES (?, ?, ?, ?, 'available')`,
    )
      .bind("test-id-0001", FAKE_ENVELOPE, now, now + 3_600_000)
      .run();

    const row = await env.DB.prepare(
      "SELECT id, envelope, created_at, expires_at, state, claim_id, claim_expires_at, consumed_at FROM secrets WHERE id = ?",
    )
      .bind("test-id-0001")
      .first<Record<string, unknown>>();

    expect(row).not.toBeNull();
    expect(row?.["envelope"]).toBe(FAKE_ENVELOPE);
    expect(row?.["state"]).toBe("available");
    expect(row?.["created_at"]).toBe(now);
    expect(row?.["expires_at"]).toBe(now + 3_600_000);
    expect(row?.["claim_id"]).toBeNull();
    expect(row?.["claim_expires_at"]).toBeNull();
    expect(row?.["consumed_at"]).toBeNull();
  });

  it("enforces a unique id", async () => {
    const now = Date.now();
    const insert = () =>
      env.DB.prepare(
        `INSERT INTO secrets (id, envelope, created_at, expires_at, state)
         VALUES (?, ?, ?, ?, 'available')`,
      )
        .bind("duplicate-id", FAKE_ENVELOPE, now, now + 1000)
        .run();

    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it("rejects a state outside the allowed set", async () => {
    const now = Date.now();
    await expect(
      env.DB.prepare(
        `INSERT INTO secrets (id, envelope, created_at, expires_at, state)
         VALUES (?, ?, ?, ?, 'nonsense')`,
      )
        .bind("bad-state", FAKE_ENVELOPE, now, now + 1000)
        .run(),
    ).rejects.toThrow();
  });

  it("stores no plaintext or key column", async () => {
    const columns = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('secrets')",
    ).all<{ name: string }>();
    const names = columns.results.map((column) => column.name).sort();

    expect(names).toEqual([
      "claim_expires_at",
      "claim_id",
      "consumed_at",
      "created_at",
      "envelope",
      "expires_at",
      "id",
      "state",
    ]);
    expect(names.some((name) => /plaintext|secret_text|key/.test(name))).toBe(
      false,
    );
  });
});
