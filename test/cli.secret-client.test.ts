import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_ORIGIN,
  MAX_CLAIM_LEASE_MS,
  SERVER_ORIGIN_ENV,
  createHttpSecretClient,
  resolveServerOrigin,
} from "../src/cli/secret-client.js";

// The real HTTP transport, exercised directly against an injected fetch.
//
// The lifecycle tests elsewhere use a service double, which proves how the CLI
// sequences its calls but says nothing about what actually goes on the wire.
// This file pins that: method, path, body, and how each status maps back. No
// network is used and no production endpoint is contacted.

const ORIGIN = "https://repobd.example";
const SECRET_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const CLAIM_TOKEN = "BBBBBBBBBBBBBBBBBBBBBB";
const ENVELOPE = '{"v":1,"alg":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ct":"AAAA"}';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function stub(
  respond: (recorded: Recorded) => Response,
): { calls: Recorded[]; fetch: typeof fetch } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const recorded: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    };
    calls.push(recorded);
    return respond(recorded);
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const noContent = (): Response => new Response(null, { status: 204 });
const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("create transport", () => {
  const created = (id: string): Response => json({ id }, 201);

  it("POSTs the envelope and TTL to the collection endpoint", async () => {
    const { calls, fetch } = stub(() => created(SECRET_ID));
    const client = createHttpSecretClient(ORIGIN, fetch);

    const result = await client.create(ENVELOPE, 900);

    expect(result).toEqual({ ok: true, id: SECRET_ID });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(`${ORIGIN}/api/secrets`);
    expect(call?.headers["content-type"]).toBe("application/json");
    // Exactly two fields. No repository identity, no key, no claim token, no
    // plaintext.
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      envelope: ENVELOPE,
      ttl_seconds: 900,
    });
  });

  it("serializes whatever TTL it is given", async () => {
    const { calls, fetch } = stub(() => created(SECRET_ID));
    const client = createHttpSecretClient(ORIGIN, fetch);
    for (const ttl of [1, 900, 86_400]) {
      await client.create(ENVELOPE, ttl);
    }
    expect(calls.map((c) => JSON.parse(c.body).ttl_seconds)).toEqual([
      1, 900, 86_400,
    ]);
  });

  it("trims a trailing slash off the origin", async () => {
    const { calls, fetch } = stub(() => created(SECRET_ID));
    const client = createHttpSecretClient(`${ORIGIN}/`, fetch);
    await client.create(ENVELOPE, 900);
    expect(calls[0]?.url).toBe(`${ORIGIN}/api/secrets`);
  });

  it.each([
    [200, "the created status is 201 only"],
    [302, "a redirect body is not a create"],
  ])("refuses a %i response (%s)", async (status) => {
    const { fetch } = stub(() => json({ id: SECRET_ID }, status));
    const client = createHttpSecretClient(ORIGIN, fetch);
    await expect(client.create(ENVELOPE, 900)).resolves.toEqual({
      ok: false,
      reason: "rejected",
    });
  });

  it("refuses a 204, which carries no id at all", async () => {
    const { fetch } = stub(noContent);
    const client = createHttpSecretClient(ORIGIN, fetch);
    await expect(client.create(ENVELOPE, 900)).resolves.toEqual({
      ok: false,
      reason: "rejected",
    });
  });

  it.each([
    [400, "bad_request", "rejected"],
    [404, "not_found", "not-found"],
    [409, "claim_conflict", "claim-conflict"],
    [410, "expired", "expired"],
    [413, "too_large", "rejected"],
    [429, "rate_limited", "rejected"],
    [500, "boom", "rejected"],
  ])("maps %i %s to %s", async (status, error, reason) => {
    const { fetch } = stub(() => json({ error }, status));
    const client = createHttpSecretClient(ORIGIN, fetch);
    await expect(client.create(ENVELOPE, 900)).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it.each([
    ["no id at all", {}],
    ["a non-string id", { id: 7 }],
    ["a null id", { id: null }],
    ["a short id", { id: "AAAA" }],
    ["a padded id", { id: "AAAAAAAAAAAAAAAAAAAA==" }],
    ["a path traversal", { id: "../../etc/passwd" }],
    ["an id with a slash", { id: "AAAAAAAAAAA/AAAAAAAAAA" }],
  ])("refuses %s", async (_label, body) => {
    // A 201 is not enough: the id goes straight into a URL and into a link the
    // receiver must be able to parse, so it is held to the same canonical
    // capability grammar on the way in.
    const { fetch } = stub(() => json(body, 201));
    const client = createHttpSecretClient(ORIGIN, fetch);
    await expect(client.create(ENVELOPE, 900)).resolves.toEqual({
      ok: false,
      reason: "malformed-response",
    });
  });

  it("refuses a 201 with no body", async () => {
    const fetchImpl = (async () =>
      new Response("", { status: 201 })) as unknown as typeof fetch;
    const client = createHttpSecretClient(ORIGIN, fetchImpl);
    await expect(client.create(ENVELOPE, 900)).resolves.toEqual({
      ok: false,
      reason: "malformed-response",
    });
  });

  it("reports a transport failure without surfacing the underlying error", async () => {
    const fetchImpl = (async () => {
      throw new Error(`connect ECONNREFUSED ${ORIGIN}/api/secrets`);
    }) as unknown as typeof fetch;
    const client = createHttpSecretClient(ORIGIN, fetchImpl);

    const result = await client.create(ENVELOPE, 900);
    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(result)).not.toContain(ORIGIN);
  });

  it("carries no envelope in a failure result", async () => {
    const { fetch } = stub(() => json({ error: "bad_request" }, 400));
    const client = createHttpSecretClient(ORIGIN, fetch);
    const result = await client.create(ENVELOPE, 900);
    expect(JSON.stringify(result)).not.toContain("A256GCM");
  });
});

describe("server origin resolution", () => {
  it("defaults to the local development Worker", () => {
    expect(resolveServerOrigin({})).toEqual({
      ok: true,
      origin: DEFAULT_SERVER_ORIGIN,
    });
    expect(DEFAULT_SERVER_ORIGIN).toBe("http://localhost:8787");
  });

  it("uses the environment variable when it is set", () => {
    expect(
      resolveServerOrigin({ [SERVER_ORIGIN_ENV]: "https://repobd.example" }),
    ).toEqual({ ok: true, origin: "https://repobd.example" });
  });

  it("trims surrounding whitespace and a trailing slash", () => {
    expect(
      resolveServerOrigin({ [SERVER_ORIGIN_ENV]: "  https://repobd.example/ \n" }),
    ).toEqual({ ok: true, origin: "https://repobd.example" });
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("falls back when the variable is %s", (_label, value) => {
    expect(resolveServerOrigin({ [SERVER_ORIGIN_ENV]: value })).toEqual({
      ok: true,
      origin: DEFAULT_SERVER_ORIGIN,
    });
  });

  it.each([
    ["localhost", "http://localhost:8787"],
    ["the IPv4 loopback address", "http://127.0.0.1:8787"],
    ["the IPv6 loopback address", "http://[::1]:8787"],
  ])("allows plain http on %s for local development", (_label, value) => {
    expect(resolveServerOrigin({ [SERVER_ORIGIN_ENV]: value })).toEqual({
      ok: true,
      origin: value,
    });
  });

  it.each([
    ["http on a remote host", "http://example.com", "unsupported-scheme"],
    ["http on a LAN address", "http://192.168.1.5:8787", "unsupported-scheme"],
    ["a lookalike loopback host", "http://localhost.example.com", "unsupported-scheme"],
    ["a non-http scheme", "ftp://repobd.example", "unsupported-scheme"],
    ["credentials", "http://user:pass@localhost:8787", "credentials"],
    ["https credentials", "https://user:pass@repobd.example", "credentials"],
    ["a path", "http://localhost:8787/api", "unexpected-path"],
    ["a query", "http://localhost:8787/?x=1", "unexpected-query"],
    ["a fragment", "http://localhost:8787/#k=1", "unexpected-fragment"],
    ["a malformed value", "not a url", "not-a-url"],
    ["a bare host", "repobd.example", "not-a-url"],
    // Parses, but as a URL whose scheme is `localhost:` — not an http origin.
    ["a host:port with no scheme", "localhost:8787", "unsupported-scheme"],
  ] as const)("refuses %s", (_label, value, reason) => {
    // Refused, never repaired: dropping the part that does not belong to an
    // origin is how a request ends up addressed somewhere else.
    expect(resolveServerOrigin({ [SERVER_ORIGIN_ENV]: value })).toEqual({
      ok: false,
      reason,
    });
  });

  it("carries no part of the refused value in the failure", () => {
    const result = resolveServerOrigin({
      [SERVER_ORIGIN_ENV]: "http://user:token@internal.example/api",
    });
    expect(JSON.stringify(result)).not.toContain("token");
    expect(JSON.stringify(result)).not.toContain("internal.example");
  });

  it("reads the real environment by default", () => {
    const previous = process.env[SERVER_ORIGIN_ENV];
    try {
      process.env[SERVER_ORIGIN_ENV] = "https://from-the-environment.example";
      expect(resolveServerOrigin()).toEqual({
        ok: true,
        origin: "https://from-the-environment.example",
      });
    } finally {
      if (previous === undefined) {
        delete process.env[SERVER_ORIGIN_ENV];
      } else {
        process.env[SERVER_ORIGIN_ENV] = previous;
      }
    }
  });
});

describe("consume transport", () => {
  it("POSTs the claim token to the consume endpoint", async () => {
    const { calls, fetch } = stub(noContent);
    const client = createHttpSecretClient(ORIGIN, fetch);

    const result = await client.consume(SECRET_ID, CLAIM_TOKEN);

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(`${ORIGIN}/api/secrets/${SECRET_ID}/consume`);
    expect(call?.headers["content-type"]).toBe("application/json");
    // Exactly one field. No repository identity, no key, no fragment.
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ claim_id: CLAIM_TOKEN });
  });

  it("addresses consume, not release or claim", async () => {
    const { calls, fetch } = stub(noContent);
    const client = createHttpSecretClient(ORIGIN, fetch);
    await client.consume(SECRET_ID, CLAIM_TOKEN);
    expect(calls[0]?.url).toMatch(/\/consume$/);
    expect(calls[0]?.url).not.toContain("/release");
    expect(calls[0]?.url).not.toContain("/claim");
  });

  it("treats 204 as success, including a retry of its own earlier consume", async () => {
    const { fetch } = stub(noContent);
    const client = createHttpSecretClient(ORIGIN, fetch);
    await expect(client.consume(SECRET_ID, CLAIM_TOKEN)).resolves.toEqual({
      ok: true,
    });
  });

  it.each([
    [404, "not_found", "not-found"],
    [409, "claim_conflict", "claim-conflict"],
    [410, "consumed", "consumed"],
    [410, "expired", "expired"],
    [400, "bad_request", "rejected"],
    [500, "boom", "rejected"],
  ])("maps %i %s to %s", async (status, error, reason) => {
    const { fetch } = stub(() => json({ error }, status));
    const client = createHttpSecretClient(ORIGIN, fetch);
    await expect(client.consume(SECRET_ID, CLAIM_TOKEN)).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it("reports a transport failure without surfacing the underlying error", async () => {
    const fetchImpl = (async () => {
      throw new Error(`connect ECONNREFUSED ${ORIGIN}/api/secrets/x/consume`);
    }) as unknown as typeof fetch;
    const client = createHttpSecretClient(ORIGIN, fetchImpl);

    const result = await client.consume(SECRET_ID, CLAIM_TOKEN);
    // One reason, carrying nothing from the thrown error — which can contain
    // the request URL.
    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(result)).not.toContain(ORIGIN);
  });

  it("carries no token or secret id in a failure result", async () => {
    const { fetch } = stub(() => json({ error: "claim_conflict" }, 409));
    const client = createHttpSecretClient(ORIGIN, fetch);
    const result = await client.consume(SECRET_ID, CLAIM_TOKEN);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CLAIM_TOKEN);
    expect(serialized).not.toContain(SECRET_ID);
  });

  it("does not follow a redirect body into a success", async () => {
    const { fetch } = stub(() => json({ ok: true }, 302));
    const client = createHttpSecretClient(ORIGIN, fetch);
    await expect(client.consume(SECRET_ID, CLAIM_TOKEN)).resolves.toEqual({
      ok: false,
      reason: "rejected",
    });
  });
});

describe("claim transport carries the server-measured lease", () => {
  it("requires lease_remaining_ms and returns it", async () => {
    const { calls, fetch } = stub(() =>
      json(
        {
          envelope: ENVELOPE,
          claim_expires_at: 1_700_000_000_000,
          lease_remaining_ms: 240_000,
        },
        200,
      ),
    );
    const client = createHttpSecretClient(ORIGIN, fetch);

    const result = await client.claim(SECRET_ID, CLAIM_TOKEN);

    expect(result).toEqual({
      ok: true,
      envelope: ENVELOPE,
      claimExpiresAt: 1_700_000_000_000,
      leaseRemainingMs: 240_000,
    });
    expect(calls[0]?.url).toBe(`${ORIGIN}/api/secrets/${SECRET_ID}/claim`);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      claim_id: CLAIM_TOKEN,
    });
  });

  it("refuses a claim response with no server-measured lease", async () => {
    // Fails closed rather than falling back to the local clock, which is the
    // assumption the field exists to remove.
    const { fetch } = stub(() =>
      json({ envelope: ENVELOPE, claim_expires_at: 1 }, 200),
    );
    const client = createHttpSecretClient(ORIGIN, fetch);
    await expect(client.claim(SECRET_ID, CLAIM_TOKEN)).resolves.toEqual({
      ok: false,
      reason: "malformed-response",
    });
  });

  it("refuses a non-numeric lease", async () => {
    const { fetch } = stub(() =>
      json(
        { envelope: ENVELOPE, claim_expires_at: 1, lease_remaining_ms: "soon" },
        200,
      ),
    );
    const client = createHttpSecretClient(ORIGIN, fetch);
    await expect(client.claim(SECRET_ID, CLAIM_TOKEN)).resolves.toEqual({
      ok: false,
      reason: "malformed-response",
    });
  });

  it("maps a conflicted renewal to claim-conflict", async () => {
    const { fetch } = stub(() => json({ error: "claim_conflict" }, 409));
    const client = createHttpSecretClient(ORIGIN, fetch);
    await expect(client.claim(SECRET_ID, CLAIM_TOKEN)).resolves.toEqual({
      ok: false,
      reason: "claim-conflict",
    });
  });
});

describe("lease evidence must be a real duration", () => {
  // `typeof x === "number"` is not enough. JSON puts no bound on a numeric
  // literal, so a body can carry a value that parses to Infinity — which
  // satisfies every naive `>= minimum` check. These are rejected at the
  // transport, and again at the write gate, on purpose.

  const claimBody = (lease: string): string =>
    `{"envelope":${JSON.stringify(ENVELOPE)},"claim_expires_at":1,"lease_remaining_ms":${lease}}`;

  function claimWith(lease: string) {
    const fetchImpl = (async () =>
      new Response(claimBody(lease), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    return createHttpSecretClient(ORIGIN, fetchImpl);
  }

  it("rejects a JSON literal that overflows to Infinity", async () => {
    // The reported case. `1e400` is valid JSON and parses to Infinity in Node.
    expect(JSON.parse('{"n":1e400}').n).toBe(Infinity);
    await expect(claimWith("1e400").claim(SECRET_ID, CLAIM_TOKEN)).resolves.toEqual({
      ok: false,
      reason: "malformed-response",
    });
  });

  it("rejects a negative overflow to -Infinity", async () => {
    await expect(claimWith("-1e400").claim(SECRET_ID, CLAIM_TOKEN)).resolves.toEqual({
      ok: false,
      reason: "malformed-response",
    });
  });

  it.each([
    ["negative", "-1"],
    ["far negative", "-600000"],
    ["above the protocol maximum", String(MAX_CLAIM_LEASE_MS + 1)],
    ["absurdly large but finite", "999999999999"],
  ])("rejects a %s lease", async (_label, lease) => {
    await expect(claimWith(lease).claim(SECRET_ID, CLAIM_TOKEN)).resolves.toEqual({
      ok: false,
      reason: "malformed-response",
    });
  });

  it.each([
    ["zero", "0"],
    ["one millisecond", "1"],
    ["exactly the protocol maximum", String(MAX_CLAIM_LEASE_MS)],
    ["an ordinary lease", "240000"],
  ])("accepts a %s lease as well-formed evidence", async (_label, lease) => {
    const result = await claimWith(lease).claim(SECRET_ID, CLAIM_TOKEN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.leaseRemainingMs).toBe(Number(lease));
    }
  });

  it("mirrors the Phase 2 claim lease cap", () => {
    // Restated in the client rather than imported from Worker code, so this
    // pins the two to the same number. If the Worker's lease changes, this
    // fails until the client is updated deliberately.
    expect(MAX_CLAIM_LEASE_MS).toBe(5 * 60_000);
  });
});

describe("release transport", () => {
  it("POSTs the claim token to the release endpoint", async () => {
    const { calls, fetch } = stub(noContent);
    const client = createHttpSecretClient(ORIGIN, fetch);
    await expect(client.release(SECRET_ID, CLAIM_TOKEN)).resolves.toEqual({
      ok: true,
    });
    expect(calls[0]?.url).toBe(`${ORIGIN}/api/secrets/${SECRET_ID}/release`);
    expect(calls[0]?.method).toBe("POST");
  });
});
