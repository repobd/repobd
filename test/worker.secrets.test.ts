import { SELF, env } from "cloudflare:test";
import {
  claimSecret,
  consumeSecret,
  releaseSecret,
} from "../src/worker/secrets.js";
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

function consume(id: string, claimId: string): Promise<Response> {
  return post(`/api/secrets/${id}/consume`, { claim_id: claimId });
}

function release(id: string, claimId: string): Promise<Response> {
  return post(`/api/secrets/${id}/release`, { claim_id: claimId });
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

describe("POST /api/secrets/:id/consume", () => {
  async function claimed(): Promise<{
    id: string;
    token: string;
    envelope: string;
  }> {
    const envelope = await makeEnvelope();
    const id = await createSecret(envelope);
    const token = capability();
    expect((await claim(id, token)).status).toBe(200);
    return { id, token, envelope };
  }

  it("consumes a claimed secret held by the matching token", async () => {
    const { id, token, envelope } = await claimed();

    const response = await consume(id, token);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");

    const stored = await row(id);
    expect(stored?.["state"]).toBe("consumed");
    expect(stored?.["consumed_at"]).toEqual(expect.any(Number));
    // The winning token stays so a retry can be recognised.
    expect(stored?.["claim_id"]).toBe(token);
    expect(stored?.["claim_expires_at"]).toBeNull();
    expect(stored?.["envelope"]).toBe(envelope);
  });

  it("treats a same-token retry after a lost response as success", async () => {
    const { id, token } = await claimed();

    expect((await consume(id, token)).status).toBe(204);
    const consumedAt = (await row(id))?.["consumed_at"];

    // The client never saw the first response and repeats the request.
    expect((await consume(id, token)).status).toBe(204);
    // The transition already happened; the retry only learns about it.
    expect((await row(id))?.["consumed_at"]).toBe(consumedAt);
  });

  it("refuses a different token on the idempotency path", async () => {
    const { id, token } = await claimed();
    expect((await consume(id, token)).status).toBe(204);

    const response = await consume(id, capability());
    expect(response.status).toBe(410);
    expect((await response.json()) as unknown).toEqual({ error: "consumed" });
    expect((await row(id))?.["claim_id"]).toBe(token);
  });

  it("refuses a token that never held the claim", async () => {
    const { id, token } = await claimed();

    const response = await consume(id, capability());
    expect(response.status).toBe(409);
    expect((await row(id))?.["state"]).toBe("claimed");
    expect((await row(id))?.["claim_id"]).toBe(token);
  });

  it("refuses an unclaimed secret", async () => {
    const id = await createSecret(await makeEnvelope());
    expect((await consume(id, capability())).status).toBe(409);
    expect((await row(id))?.["state"]).toBe("available");
  });

  it("refuses an expired secret", async () => {
    const { id, token } = await claimed();
    await env.DB.prepare("UPDATE secrets SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, id)
      .run();

    expect((await consume(id, token)).status).toBe(410);
    expect((await row(id))?.["state"]).toBe("claimed");
  });

  it("refuses an expired lease", async () => {
    const { id, token } = await claimed();
    await env.DB.prepare("UPDATE secrets SET claim_expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, id)
      .run();

    expect((await consume(id, token)).status).toBe(409);
    expect((await row(id))?.["state"]).toBe("claimed");
  });

  it("returns not_found for an unknown id", async () => {
    expect((await consume(capability(), capability())).status).toBe(404);
  });

  it.each(["short", "A".repeat(23)])(
    "rejects the malformed id %s",
    async (id) => {
      expect((await consume(encodeURIComponent(id), capability())).status).toBe(
        404,
      );
    },
  );

  it("rejects a malformed claim token", async () => {
    const { id } = await claimed();
    expect((await consume(id, "short")).status).toBe(400);
    expect((await row(id))?.["state"]).toBe("claimed");
  });
});

describe("POST /api/secrets/:id/release", () => {
  it("returns a claimed secret to the available pool", async () => {
    const envelope = await makeEnvelope();
    const id = await createSecret(envelope);
    const token = capability();
    expect((await claim(id, token)).status).toBe(200);

    const response = await release(id, token);
    expect(response.status).toBe(204);

    const stored = await row(id);
    expect(stored?.["state"]).toBe("available");
    expect(stored?.["claim_id"]).toBeNull();
    expect(stored?.["claim_expires_at"]).toBeNull();
    expect(stored?.["consumed_at"]).toBeNull();
    expect(stored?.["envelope"]).toBe(envelope);
  });

  it("makes the secret claimable by a new token", async () => {
    const id = await createSecret(await makeEnvelope());
    const first = capability();
    const second = capability();

    expect((await claim(id, first)).status).toBe(200);
    expect((await release(id, first)).status).toBe(204);
    expect((await claim(id, second)).status).toBe(200);
    expect((await row(id))?.["claim_id"]).toBe(second);
  });

  it("refuses a token that does not hold the claim", async () => {
    const id = await createSecret(await makeEnvelope());
    const holder = capability();
    expect((await claim(id, holder)).status).toBe(200);

    expect((await release(id, capability())).status).toBe(409);
    expect((await row(id))?.["claim_id"]).toBe(holder);
  });

  // A released token must not keep power over the secret it let go.
  it("does not let a stale token release a later claim", async () => {
    const id = await createSecret(await makeEnvelope());
    const first = capability();
    const second = capability();

    expect((await claim(id, first)).status).toBe(200);
    expect((await release(id, first)).status).toBe(204);
    expect((await claim(id, second)).status).toBe(200);

    const stale = await release(id, first);
    expect(stale.status).toBe(409);

    const stored = await row(id);
    expect(stored?.["state"]).toBe("claimed");
    expect(stored?.["claim_id"]).toBe(second);
  });

  it("treats a repeated release as success without changing anything", async () => {
    const id = await createSecret(await makeEnvelope());
    const token = capability();
    expect((await claim(id, token)).status).toBe(200);

    expect((await release(id, token)).status).toBe(204);
    expect((await release(id, token)).status).toBe(204);
    expect((await row(id))?.["state"]).toBe("available");
  });

  it("does not resurrect a consumed secret", async () => {
    const id = await createSecret(await makeEnvelope());
    const token = capability();
    expect((await claim(id, token)).status).toBe(200);
    expect((await consume(id, token)).status).toBe(204);

    const response = await release(id, token);
    expect(response.status).toBe(410);
    expect((await response.json()) as unknown).toEqual({ error: "consumed" });
    expect((await row(id))?.["state"]).toBe("consumed");
  });

  it("does not make an expired secret usable again", async () => {
    const id = await createSecret(await makeEnvelope());
    const token = capability();
    expect((await claim(id, token)).status).toBe(200);
    await env.DB.prepare("UPDATE secrets SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, id)
      .run();

    await release(id, token);
    // Whatever release reported, expiry still dominates.
    expect((await claim(id, capability())).status).toBe(410);
    expect((await consume(id, token)).status).toBe(410);
  });

  it("returns not_found for an unknown id", async () => {
    expect((await release(capability(), capability())).status).toBe(404);
  });
});

describe("consumed is terminal", () => {
  async function consumedSecret(): Promise<{ id: string; token: string }> {
    const id = await createSecret(await makeEnvelope());
    const token = capability();
    expect((await claim(id, token)).status).toBe(200);
    expect((await consume(id, token)).status).toBe(204);
    return { id, token };
  }

  it("refuses a further claim and returns no envelope", async () => {
    const { id } = await consumedSecret();

    const response = await claim(id, capability());
    expect(response.status).toBe(410);
    expect(await response.text()).toBe(JSON.stringify({ error: "consumed" }));
  });

  it("refuses a claim even from the consuming token", async () => {
    const { id, token } = await consumedSecret();
    expect((await claim(id, token)).status).toBe(410);
    expect((await row(id))?.["state"]).toBe("consumed");
  });

  it("never leaves the consumed state", async () => {
    const { id, token } = await consumedSecret();

    await claim(id, token);
    await claim(id, capability());
    await release(id, token);
    await release(id, capability());
    await consume(id, capability());

    expect((await row(id))?.["state"]).toBe("consumed");
  });
});

describe("remote lifecycle", () => {
  it("runs create -> claim -> release -> claim -> consume -> retry", async () => {
    const envelope = await makeEnvelope();
    const id = await createSecret(envelope);
    const a = capability();
    const b = capability();

    // A takes it, then gives it back without consuming.
    expect((await claim(id, a)).status).toBe(200);
    expect((await release(id, a)).status).toBe(204);
    expect((await row(id))?.["state"]).toBe("available");

    // B takes it and consumes.
    const claimed = await claim(id, b);
    expect(claimed.status).toBe(200);
    expect(((await claimed.json()) as { envelope: string }).envelope).toBe(
      envelope,
    );
    expect((await consume(id, b)).status).toBe(204);

    // Nothing further can obtain it, but B's retry is still safe.
    expect((await claim(id, capability())).status).toBe(410);
    expect((await consume(id, b)).status).toBe(204);
    expect((await release(id, b)).status).toBe(410);
    expect((await row(id))?.["state"]).toBe("consumed");
  });

  // The remote states the later apply flow depends on: a claim that is never
  // consumed must leave the secret recoverable.
  it("does not consume when the claimant simply stops", async () => {
    const id = await createSecret(await makeEnvelope());
    expect((await claim(id, capability())).status).toBe(200);

    const stored = await row(id);
    expect(stored?.["state"]).toBe("claimed");
    expect(stored?.["consumed_at"]).toBeNull();
  });

  it("makes an abandoned claim reclaimable once the lease lapses", async () => {
    const id = await createSecret(await makeEnvelope());
    const abandoned = capability();
    expect((await claim(id, abandoned)).status).toBe(200);

    await env.DB.prepare("UPDATE secrets SET claim_expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, id)
      .run();

    const next = capability();
    expect((await claim(id, next)).status).toBe(200);
    expect((await row(id))?.["claim_id"]).toBe(next);
    expect((await row(id))?.["consumed_at"]).toBeNull();
  });
});

describe("diagnostic reads fetch no unnecessary token", () => {
  /**
   * Records the SQL each statement is prepared with, then delegates to the
   * real database — no behaviour is stubbed, so these tests observe the
   * genuine queries rather than a mock's idea of them.
   */
  function recording(db: D1Database, queries: string[]): D1Database {
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            queries.push(query);
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /**
   * The selected columns of each SELECT, normalised, ignoring any WHERE that
   * compares our own token. Asserting on the exact projection rather than
   * searching for a substring is what makes these tests fail for `SELECT *`
   * or for a differently-cased `CLAIM_ID`.
   */
  function selectedColumns(queries: string[]): string[] {
    return queries
      .map((query) => /\bselect\s+([^]*?)\s+from\b/i.exec(query)?.[1])
      .filter((projection): projection is string => projection !== undefined)
      .map((projection) =>
        projection.replace(/\s+/g, " ").trim().toLowerCase(),
      );
  }

  /** Fails for a wildcard projection or for `claim_id` in any letter case. */
  function expectNoBearerToken(projections: string[]): void {
    expect(projections.length).toBeGreaterThan(0);
    for (const projection of projections) {
      expect(projection).not.toBe("*");
      expect(projection.split(",").map((column) => column.trim())).not.toContain(
        "claim_id",
      );
    }
  }

  async function heldByAnother(): Promise<string> {
    const id = await createSecret(await makeEnvelope());
    expect((await claim(id, capability())).status).toBe(200);
    return id;
  }

  it("does not select claim_id when a competing claim fails", async () => {
    const id = await heldByAnother();
    const queries: string[] = [];

    const result = await claimSecret(
      recording(env.DB, queries),
      id,
      capability(),
      Date.now(),
    );
    expect(result.ok).toBe(false);

    const projections = selectedColumns(queries);
    expectNoBearerToken(projections);
    // The batched read of what the caller now owns, then the diagnostic.
    expect(projections).toEqual(["envelope, claim_expires_at", "state, expires_at"]);
  });

  it("does not select claim_id when a release fails", async () => {
    const id = await heldByAnother();
    const queries: string[] = [];

    const result = await releaseSecret(
      recording(env.DB, queries),
      id,
      capability(),
    );
    expect(result.ok).toBe(false);

    const projections = selectedColumns(queries);
    expectNoBearerToken(projections);
    expect(projections).toEqual(["state"]);
  });

  it("does select claim_id when recognising a consume retry", async () => {
    const id = await createSecret(await makeEnvelope());
    const token = capability();
    expect((await claim(id, token)).status).toBe(200);
    expect((await consume(id, token)).status).toBe(204);

    const queries: string[] = [];
    const result = await consumeSecret(
      recording(env.DB, queries),
      id,
      token,
      Date.now(),
    );

    // The retry can only be recognised by comparing against the stored token.
    expect(result.ok).toBe(true);
    expect(selectedColumns(queries)).toEqual(["state, expires_at, claim_id"]);
  });
});

// Boundaries the HTTP layer cannot pin down, driven directly so `now` is exact.
describe("consume boundaries (deterministic)", () => {
  async function seed(
    expiresAt: number,
    claimExpiresAt: number,
  ): Promise<{ id: string; token: string }> {
    const id = await createSecret(await makeEnvelope());
    const token = capability();
    await env.DB.prepare(
      `UPDATE secrets SET state='claimed', claim_id=?, claim_expires_at=?, expires_at=? WHERE id=?`,
    )
      .bind(token, claimExpiresAt, expiresAt, id)
      .run();
    return { id, token };
  }

  // The lease deliberately outlives the secret here. A lease capped at expiry
  // would hit both guards at once, so this is the only way to prove the
  // secret-expiry guard on its own — and it is the invariant that matters:
  // expiry dominates lease state.
  it("treats now === expires_at as expired even with a live lease", async () => {
    const { id, token } = await seed(1_000_000, 2_000_000);
    const result = await consumeSecret(env.DB, id, token, 1_000_000);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("expired");
    expect((await row(id))?.["state"]).toBe("claimed");
  });

  it("treats now === claim_expires_at as a lapsed lease", async () => {
    const { id, token } = await seed(2_000_000, 1_000_000);
    const result = await consumeSecret(env.DB, id, token, 1_000_000);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("conflict");
    expect((await row(id))?.["state"]).toBe("claimed");
  });

  it("allows the instant before both boundaries", async () => {
    const { id, token } = await seed(2_000_000, 1_000_000);
    const result = await consumeSecret(env.DB, id, token, 999_999);

    expect(result.ok).toBe(true);
    expect((await row(id))?.["state"]).toBe("consumed");
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
