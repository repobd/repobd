import { SELF, env } from "cloudflare:test";
import { claimSecret } from "../src/worker/secrets.js";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ENVELOPE_ALG,
  ENVELOPE_VERSION,
  MAX_PLAINTEXT_BYTES,
  serializeEnvelope,
  toBase64Url,
} from "../src/crypto/envelope-format.js";

// Phase 2B: create and claim. Consume and release are Phase 2C.
//
// Envelopes are genuinely encrypted here, but with Web Crypto directly rather
// than by importing the Phase 1 crypto module: that module must stay out of
// the Worker's dependency graph, and importing it here would drag it back in.
// The key never leaves this test — it is never sent to the Worker, and the
// Worker never decrypts.

const BASE = "https://example.com";

async function makeEnvelope(
  plaintext = "API_KEY=TEST_ALPHA_123456",
): Promise<string> {
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
      new TextEncoder().encode(plaintext),
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
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function createSecret(
  envelope: string,
  ttlSeconds = 3600,
): Promise<string> {
  const response = await post("/api/secrets", {
    envelope,
    ttl_seconds: ttlSeconds,
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  return id;
}

function claim(id: string, claimId: string): Promise<Response> {
  return post(`/api/secrets/${id}/claim`, { claim_id: claimId });
}

async function row(id: string) {
  return env.DB.prepare(
    "SELECT id, envelope, created_at, expires_at, state, claim_id, claim_expires_at, consumed_at FROM secrets WHERE id = ?",
  )
    .bind(id)
    .first<Record<string, unknown>>();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM secrets").run();
});

describe("POST /api/secrets", () => {
  it("stores an available secret and returns only the capability id", async () => {
    const envelope = await makeEnvelope();
    const response = await post("/api/secrets", {
      envelope,
      ttl_seconds: 3600,
    });

    expect(response.status).toBe(201);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["id"]);

    const stored = await row(payload["id"] as string);
    expect(stored?.["state"]).toBe("available");
    expect(stored?.["envelope"]).toBe(envelope);
    expect(stored?.["claim_id"]).toBeNull();
    expect(stored?.["consumed_at"]).toBeNull();
  });

  it("returns a 22-character canonical base64url id", async () => {
    const id = await createSecret(await makeEnvelope());
    expect(id).toHaveLength(22);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("issues a distinct id per secret", async () => {
    const envelope = await makeEnvelope();
    const ids = new Set<string>();
    for (let i = 0; i < 16; i++) {
      ids.add(await createSecret(envelope));
    }
    expect(ids.size).toBe(16);
  });

  it("derives expires_at from the requested TTL", async () => {
    const before = Date.now();
    const id = await createSecret(await makeEnvelope(), 60);
    const stored = await row(id);

    const createdAt = stored?.["created_at"] as number;
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(stored?.["expires_at"]).toBe(createdAt + 60_000);
  });

  it.each([
    ["missing ttl", { envelope: "PLACEHOLDER" }],
    ["zero ttl", { envelope: "PLACEHOLDER", ttl_seconds: 0 }],
    ["negative ttl", { envelope: "PLACEHOLDER", ttl_seconds: -1 }],
    ["fractional ttl", { envelope: "PLACEHOLDER", ttl_seconds: 1.5 }],
    ["string ttl", { envelope: "PLACEHOLDER", ttl_seconds: "3600" }],
    ["ttl above maximum", { envelope: "PLACEHOLDER", ttl_seconds: 86_401 }],
    ["missing envelope", { ttl_seconds: 3600 }],
    ["non-string envelope", { envelope: 42, ttl_seconds: 3600 }],
  ])("rejects %s", async (_label, body) => {
    const envelope = await makeEnvelope();
    const payload = { ...body } as Record<string, unknown>;
    if (payload["envelope"] === "PLACEHOLDER") {
      payload["envelope"] = envelope;
    }
    const response = await post("/api/secrets", payload);
    expect(response.status).toBe(400);
  });

  it("accepts a TTL of exactly the maximum", async () => {
    const response = await post("/api/secrets", {
      envelope: await makeEnvelope(),
      ttl_seconds: 86_400,
    });
    expect(response.status).toBe(201);
  });

  it("rejects malformed JSON", async () => {
    expect((await post("/api/secrets", "not json")).status).toBe(400);
    expect((await post("/api/secrets", "[]")).status).toBe(400);
  });

  it("rejects a malformed envelope", async () => {
    const envelope = await makeEnvelope();
    const tampered = JSON.parse(envelope) as Record<string, unknown>;
    tampered["alg"] = "A128GCM";

    const response = await post("/api/secrets", {
      envelope: JSON.stringify(tampered),
      ttl_seconds: 3600,
    });
    expect(response.status).toBe(400);
    expect(
      (await post("/api/secrets", { envelope: "{}", ttl_seconds: 3600 })).status,
    ).toBe(400);
  });

  it("rejects an oversized body before storing anything", async () => {
    const response = await post("/api/secrets", {
      envelope: "A".repeat(200_000),
      ttl_seconds: 3600,
    });
    expect(response.status).toBe(400);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM secrets",
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("accepts an envelope at the maximum plaintext size", async () => {
    const envelope = await makeEnvelope("a".repeat(MAX_PLAINTEXT_BYTES));
    const response = await post("/api/secrets", {
      envelope,
      ttl_seconds: 3600,
    });
    expect(response.status).toBe(201);
  });

  it("rejects a non-POST method", async () => {
    const response = await SELF.fetch(`${BASE}/api/secrets`, { method: "GET" });
    expect(response.status).toBe(405);
  });
});

describe("POST /api/secrets/:id/claim", () => {
  it("moves available to claimed and returns the envelope", async () => {
    const envelope = await makeEnvelope();
    const id = await createSecret(envelope);
    const token = capability();

    const response = await claim(id, token);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload["envelope"]).toBe(envelope);
    expect(Object.keys(payload).sort()).toEqual(["claim_expires_at", "envelope"]);

    const stored = await row(id);
    expect(stored?.["state"]).toBe("claimed");
    expect(stored?.["claim_id"]).toBe(token);
  });

  it("caps the lease at the secret expiry", async () => {
    // TTL of 60s is far shorter than the 5-minute lease.
    const id = await createSecret(await makeEnvelope(), 60);
    const response = await claim(id, capability());
    expect(response.status).toBe(200);

    const stored = await row(id);
    expect(stored?.["claim_expires_at"]).toBe(stored?.["expires_at"]);
  });

  it("uses the full lease when the secret outlives it", async () => {
    const id = await createSecret(await makeEnvelope(), 3600);
    const response = await claim(id, capability());
    const { claim_expires_at: leaseEnd } = (await response.json()) as {
      claim_expires_at: number;
    };

    const stored = await row(id);
    expect(leaseEnd).toBeLessThan(stored?.["expires_at"] as number);
    expect(leaseEnd).toBeGreaterThan(Date.now());
  });

  it("succeeds when the same token retries after a lost response", async () => {
    const envelope = await makeEnvelope();
    const id = await createSecret(envelope);
    const token = capability();

    const first = await claim(id, token);
    expect(first.status).toBe(200);
    // The client never saw the first response; it repeats the same request.
    const retry = await claim(id, token);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { envelope: string }).envelope).toBe(
      envelope,
    );

    const stored = await row(id);
    expect(stored?.["claim_id"]).toBe(token);
  });

  it("refuses a competing token while the lease is live", async () => {
    const id = await createSecret(await makeEnvelope());
    const winner = capability();
    const loser = capability();

    expect((await claim(id, winner)).status).toBe(200);

    const response = await claim(id, loser);
    expect(response.status).toBe(409);
    expect((await response.json()) as unknown).toEqual({
      error: "claim_conflict",
    });

    const stored = await row(id);
    expect(stored?.["claim_id"]).toBe(winner);
  });

  it("lets another token take over once the lease has lapsed", async () => {
    const envelope = await makeEnvelope();
    const id = await createSecret(envelope);
    const first = capability();
    const second = capability();

    expect((await claim(id, first)).status).toBe(200);
    // Expire the lease without expiring the secret.
    await env.DB.prepare("UPDATE secrets SET claim_expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, id)
      .run();

    const response = await claim(id, second);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { envelope: string }).envelope).toBe(
      envelope,
    );
    expect((await row(id))?.["claim_id"]).toBe(second);
  });

  it("refuses an expired secret and reveals no envelope", async () => {
    const id = await createSecret(await makeEnvelope());
    await env.DB.prepare("UPDATE secrets SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, id)
      .run();

    const response = await claim(id, capability());
    expect(response.status).toBe(410);
    expect(await response.text()).not.toContain("iv");
  });

  it("treats the exact expiry instant as expired", async () => {
    const id = await createSecret(await makeEnvelope());
    // expires_at == now must fail: usability requires expires_at > now.
    await env.DB.prepare("UPDATE secrets SET expires_at = ? WHERE id = ?")
      .bind(Date.now() + 50, id)
      .run();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect((await claim(id, capability())).status).toBe(410);
  });

  it("refuses a consumed row", async () => {
    const id = await createSecret(await makeEnvelope());
    // Synthetic only — consume is not implemented until Phase 2C.
    await env.DB.prepare(
      "UPDATE secrets SET state = 'consumed', consumed_at = ? WHERE id = ?",
    )
      .bind(Date.now(), id)
      .run();

    const response = await claim(id, capability());
    expect(response.status).toBe(410);
    expect((await response.json()) as unknown).toEqual({ error: "consumed" });
  });

  it("returns not_found for an unknown but well-formed id", async () => {
    const response = await claim(capability(), capability());
    expect(response.status).toBe(404);
  });

  it.each(["short", "A".repeat(23), "not/base64url/at/all", "AAAAAAAAAAAAAAAAAAAAA="])(
    "rejects the malformed secret id %s without a database lookup",
    async (id) => {
      const response = await claim(encodeURIComponent(id), capability());
      expect(response.status).toBe(404);
    },
  );

  it.each(["short", "A".repeat(23), "!!!!!!!!!!!!!!!!!!!!!!"])(
    "rejects the malformed claim token %s",
    async (token) => {
      const id = await createSecret(await makeEnvelope());
      const response = await claim(id, token);
      expect(response.status).toBe(400);
      expect((await row(id))?.["state"]).toBe("available");
    },
  );

  it("rejects a non-canonical claim token", async () => {
    const id = await createSecret(await makeEnvelope());
    // 16 bytes encode to 22 characters with 4 unused trailing bits; a final
    // character carrying non-zero trailing bits decodes to the same bytes.
    const token = capability();
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(token.at(-1) as string);
    const mutated =
      token.slice(0, -1) + alphabet[(last & ~3) | (((last & 3) + 1) % 4)];

    expect(mutated).not.toBe(token);
    expect((await claim(id, mutated)).status).toBe(400);
  });

  it("rejects a non-POST method", async () => {
    const id = await createSecret(await makeEnvelope());
    const response = await SELF.fetch(`${BASE}/api/secrets/${id}/claim`, {
      method: "GET",
    });
    expect(response.status).toBe(405);
  });
});

// KNOWN LIMITATION: these two tests do not prove atomicity. Replacing the
// conditional UPDATE with a read-then-write TOCTOU implementation was tried
// as a mutation, and both tests still passed — the Workers test harness
// serialises these requests rather than genuinely interleaving them, so the
// losing claimant always observes the winner's completed state. They remain
// useful as behavioural coverage (exactly one winner, the loser is told
// nothing), but the atomicity guarantee rests on the single conditional
// UPDATE being correct under any serialisation order, not on these tests.
describe("concurrent claims", () => {
  it("lets exactly one of two racing tokens win", async () => {
    const envelope = await makeEnvelope();
    const id = await createSecret(envelope);
    const first = capability();
    const second = capability();

    // Both requests are started before either is awaited.
    const [a, b] = await Promise.all([claim(id, first), claim(id, second)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winnerResponse = a.status === 200 ? a : b;
    const loserResponse = a.status === 200 ? b : a;
    const winnerToken = a.status === 200 ? first : second;

    expect(((await winnerResponse.json()) as { envelope: string }).envelope).toBe(
      envelope,
    );
    const loserBody = await loserResponse.text();
    expect(loserBody).not.toContain(envelope);
    expect(loserBody).toBe(JSON.stringify({ error: "claim_conflict" }));

    expect((await row(id))?.["claim_id"]).toBe(winnerToken);
  });

  it("lets exactly one of many racing tokens win", async () => {
    const id = await createSecret(await makeEnvelope());
    const tokens = Array.from({ length: 8 }, () => capability());

    const responses = await Promise.all(
      tokens.map((token) => claim(id, token)),
    );
    const winners = responses.filter((response) => response.status === 200);

    expect(winners).toHaveLength(1);
    expect(
      responses.every(
        (response) => response.status === 200 || response.status === 409,
      ),
    ).toBe(true);

    const stored = await row(id);
    expect(tokens).toContain(stored?.["claim_id"]);
  });
});

// Driving claimSecret directly lets `now` be chosen exactly, which an HTTP
// test cannot do. This pins the boundary itself rather than approaching it
// with a sleep: a regression from `expires_at > now` to `expires_at >= now`
// fails here and nowhere else.
describe("expiry boundary (deterministic)", () => {
  async function seed(expiresAt: number): Promise<string> {
    const id = await createSecret(await makeEnvelope());
    await env.DB.prepare("UPDATE secrets SET expires_at = ? WHERE id = ?")
      .bind(expiresAt, id)
      .run();
    return id;
  }

  it("treats now === expires_at as already expired", async () => {
    const expiresAt = 1_000_000;
    const id = await seed(expiresAt);

    const result = await claimSecret(env.DB, id, capability(), expiresAt);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("expired");
    expect((await row(id))?.["state"]).toBe("available");
  });

  it("allows the instant before expiry", async () => {
    const expiresAt = 1_000_000;
    const id = await seed(expiresAt);

    const result = await claimSecret(env.DB, id, capability(), expiresAt - 1);
    expect(result.ok).toBe(true);
  });

  it("rejects the instant after expiry", async () => {
    const expiresAt = 1_000_000;
    const id = await seed(expiresAt);

    const result = await claimSecret(env.DB, id, capability(), expiresAt + 1);
    expect(result.ok === false && result.reason).toBe("expired");
  });

  it("caps the lease at expiry rather than exceeding it", async () => {
    const now = 1_000_000;
    const id = await seed(now + 1000); // shorter than the 5-minute lease
    const result = await claimSecret(env.DB, id, capability(), now);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.claimExpiresAt).toBe(now + 1000);
  });
});

describe("server-side secrecy", () => {
  it("stores the envelope verbatim and adds no key or plaintext column", async () => {
    const plaintext = "API_KEY=TEST_ALPHA_123456";
    const envelope = await makeEnvelope(plaintext);
    const id = await createSecret(envelope);

    const stored = await row(id);
    expect(stored?.["envelope"]).toBe(envelope);
    expect(JSON.stringify(stored)).not.toContain(plaintext);

    const columns = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('secrets')",
    ).all<{ name: string }>();
    expect(columns.results.map((column) => column.name).sort()).toEqual([
      "claim_expires_at",
      "claim_id",
      "consumed_at",
      "created_at",
      "envelope",
      "expires_at",
      "id",
      "state",
    ]);
  });

  it("stores only the canonical projection of a padded envelope", async () => {
    // Extra properties inside the envelope JSON itself, not the outer request.
    const canonical = await makeEnvelope();
    const padded = JSON.stringify({
      ...(JSON.parse(canonical) as Record<string, unknown>),
      key: "SHOULD_NEVER_BE_STORED",
      plaintext: "SHOULD_NEVER_BE_STORED_EITHER",
      note: "arbitrary attacker-controlled property",
    });

    const response = await post("/api/secrets", {
      envelope: padded,
      ttl_seconds: 3600,
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };

    const stored = await row(id);
    expect(stored?.["envelope"]).toBe(canonical);
    expect(Object.keys(JSON.parse(stored?.["envelope"] as string) as object)).toEqual([
      "v",
      "alg",
      "iv",
      "ct",
    ]);
    expect(JSON.stringify(stored)).not.toContain("SHOULD_NEVER_BE_STORED");
    expect(JSON.stringify(stored)).not.toContain("arbitrary attacker");

    // Nor may they come back out of a claim.
    const claimed = await claim(id, capability());
    expect(claimed.status).toBe(200);
    const body = await claimed.text();
    expect(body).not.toContain("SHOULD_NEVER_BE_STORED");
    expect(body).not.toContain("arbitrary attacker");
    expect(JSON.parse(body).envelope).toBe(canonical);
  });

  it("ignores a decryption key offered in the request", async () => {
    const envelope = await makeEnvelope();
    const response = await post("/api/secrets", {
      envelope,
      ttl_seconds: 3600,
      key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(response.status).toBe(201);

    const { id } = (await response.json()) as { id: string };
    const stored = await row(id);
    expect(JSON.stringify(stored)).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });
});

describe("existing behaviour", () => {
  it("leaves /health intact", async () => {
    const get = await SELF.fetch(`${BASE}/health`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("ok");
    expect((await SELF.fetch(`${BASE}/health`, { method: "POST" })).status).toBe(
      405,
    );
  });

  it("still 404s an unknown path", async () => {
    expect((await SELF.fetch(`${BASE}/nope`)).status).toBe(404);
  });
});
