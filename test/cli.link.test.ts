import { describe, expect, it } from "vitest";
import { toBase64Url } from "../src/crypto/envelope-format.js";
import { validateCanonicalRepoIdentity } from "../src/repo/identity.js";
import {
  buildDeliveryLink,
  parseDeliveryLink,
  parseServiceOrigin,
  type LinkParseFailureReason,
} from "../src/cli/link.js";

// Delivery-link format tests. Nothing here reaches a network, runs Git, or
// touches the filesystem: the parser is pure by construction.

const ORIGIN = "https://repobd.example";
const SECRET_ID = toBase64Url(new Uint8Array(16).fill(7));
const KEY = toBase64Url(new Uint8Array(32).fill(9));

function repo(canonical: string) {
  const result = validateCanonicalRepoIdentity(canonical);
  if (!result.ok) {
    throw new Error(`fixture is not canonical: ${canonical}`);
  }
  return result.repo;
}

const ALPHA = repo("github.com/acme/alpha");

function link(fragment: string): string {
  return `${ORIGIN}/d/${SECRET_ID}#${fragment}`;
}

function bindingParam(json: string): string {
  return `k=${KEY}&b=${encodeURIComponent(json)}`;
}

function expectBlocked(raw: string, reason: LinkParseFailureReason): void {
  const result = parseDeliveryLink(raw);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe(reason);
  }
}

describe("delivery link round trip", () => {
  it("parses a link it built", () => {
    const built = buildDeliveryLink({
      origin: ORIGIN,
      secretId: SECRET_ID,
      key: KEY,
      repo: ALPHA,
    });
    const result = parseDeliveryLink(built);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.link.origin).toBe(ORIGIN);
      expect(result.link.secretId).toBe(SECRET_ID);
      expect(result.link.key).toBe(KEY);
      expect(result.link.repo.canonical).toBe("github.com/acme/alpha");
      expect(result.link.binding.bv).toBe(1);
    }
  });

  it("keeps the key and the binding in the fragment", () => {
    const built = buildDeliveryLink({
      origin: ORIGIN,
      secretId: SECRET_ID,
      key: KEY,
      repo: ALPHA,
    });
    const [beforeHash, afterHash] = built.split("#");
    // What a request could ever be addressed to must not contain either.
    expect(beforeHash).not.toContain(KEY);
    expect(beforeHash).not.toContain("github.com/acme/alpha");
    expect(beforeHash).not.toContain("acme");
    expect(afterHash).toContain(KEY);
    expect(afterHash).toContain("github.com");
  });

  it("tolerates surrounding whitespace from a paste", () => {
    const built = buildDeliveryLink({
      origin: ORIGIN,
      secretId: SECRET_ID,
      key: KEY,
      repo: ALPHA,
    });
    expect(parseDeliveryLink(`  ${built}\n`).ok).toBe(true);
  });
});

describe("delivery link fails closed", () => {
  it("rejects a non-URL", () => {
    expectBlocked("not a link", "not-a-url");
  });

  it.each([
    ["a remote host", "http://repobd.example"],
    ["a private LAN address", "http://192.168.1.5:8787"],
    ["a public IP address", "http://203.0.113.7:8787"],
    ["a host that merely ends in localhost", "http://evil.localhost"],
    ["a host that merely starts with it", "http://localhost.example.com"],
    ["another loopback address in 127/8", "http://127.0.0.2:8787"],
    ["a non-http scheme", "ftp://repobd.example"],
  ])("rejects plain http on %s", (_label, origin) => {
    expectBlocked(
      `${origin}/d/${SECRET_ID}#${bindingParam('{"bv":1,"repo":"github.com/acme/alpha"}')}`,
      "unsupported-scheme",
    );
  });

  it.each([
    ["localhost", "http://localhost:8787"],
    ["the IPv4 loopback address", "http://127.0.0.1:8787"],
    ["the IPv6 loopback address", "http://[::1]:8787"],
    ["localhost with no port", "http://localhost"],
  ])("accepts plain http on %s, for local development", (_label, origin) => {
    const result = parseDeliveryLink(
      `${origin}/d/${SECRET_ID}#${bindingParam('{"bv":1,"repo":"github.com/acme/alpha"}')}`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.link.origin).toBe(origin);
    }
  });

  it("rejects credentials on a loopback origin too", () => {
    expectBlocked(
      `http://user:token@localhost:8787/d/${SECRET_ID}#${bindingParam('{"bv":1,"repo":"github.com/acme/alpha"}')}`,
      "credentials",
    );
  });

  it("rejects embedded credentials", () => {
    expectBlocked(
      `https://user:token@repobd.example/d/${SECRET_ID}#${bindingParam('{"bv":1,"repo":"github.com/acme/alpha"}')}`,
      "credentials",
    );
  });

  it("rejects a query string", () => {
    expectBlocked(
      `${ORIGIN}/d/${SECRET_ID}?x=1#${bindingParam('{"bv":1,"repo":"github.com/acme/alpha"}')}`,
      "unexpected-query",
    );
  });

  it("rejects a path that is not a delivery path", () => {
    expectBlocked(
      `${ORIGIN}/x/${SECRET_ID}#${bindingParam('{"bv":1,"repo":"github.com/acme/alpha"}')}`,
      "not-a-delivery-path",
    );
  });

  it("rejects a secret id outside the URL-safe token shape", () => {
    expectBlocked(
      `${ORIGIN}/d/..%2F..%2Fetc#${bindingParam('{"bv":1,"repo":"github.com/acme/alpha"}')}`,
      "invalid-secret-id",
    );
  });
});

// One policy, applied by both ends. A builder that accepted an origin the
// parser refuses is the bug this pair exists to make impossible: it would let
// a sender report success holding a link nobody can pull.
describe("the origin policy is shared by the builder and the parser", () => {
  const ACCEPTED = [
    "https://repobd.example",
    "https://repobd.example:8443",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
  ];

  const REFUSED: readonly [string, string][] = [
    ["http on a remote host", "http://repobd.example"],
    ["http on a LAN address", "http://192.168.1.5:8787"],
    ["http on a public address", "http://203.0.113.7:8787"],
    ["a lookalike loopback host", "http://localhost.example.com"],
    ["embedded credentials", "https://user:token@repobd.example"],
    ["loopback with credentials", "http://user:token@localhost:8787"],
    ["a path", "http://localhost:8787/api"],
    ["a query", "http://localhost:8787/?x=1"],
    ["a fragment", "http://localhost:8787/#k=1"],
    ["a bare host with no scheme", "repobd.example"],
    ["nonsense", "not a url"],
    ["an empty string", ""],
    ["a non-http scheme", "ftp://repobd.example"],
    ["a file URL", "file:///etc/passwd"],
  ];

  it.each(ACCEPTED)("accepts %s and builds a link that parses", (origin) => {
    expect(parseServiceOrigin(origin)).toEqual({ ok: true, origin });
    const built = buildDeliveryLink({
      origin,
      secretId: SECRET_ID,
      key: KEY,
      repo: ALPHA,
    });
    const parsed = parseDeliveryLink(built);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.link.origin).toBe(origin);
    }
  });

  it.each(REFUSED)("refuses %s, and refuses to build with it", (_l, origin) => {
    expect(parseServiceOrigin(origin).ok).toBe(false);
    expect(() =>
      buildDeliveryLink({
        origin,
        secretId: SECRET_ID,
        key: KEY,
        repo: ALPHA,
      }),
    ).toThrow();
  });

  it("names the reason without quoting the value it refused", () => {
    // The value can be a private hostname, and it can carry credentials.
    const result = parseServiceOrigin("https://user:token@internal.example");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("credentials");
      expect(result.detail).not.toContain("token");
      expect(result.detail).not.toContain("internal.example");
    }
    // The builder's throw is subject to the same rule.
    try {
      buildDeliveryLink({
        origin: "https://user:token@internal.example",
        secretId: SECRET_ID,
        key: KEY,
        repo: ALPHA,
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("token");
      expect(String(error)).not.toContain("internal.example");
    }
  });

  it.each([
    ["a trailing slash", "https://repobd.example/", "https://repobd.example"],
    [
      "surrounding whitespace",
      "  https://repobd.example \n",
      "https://repobd.example",
    ],
    ["an uppercase host", "https://RepoBD.Example", "https://repobd.example"],
    ["the default https port", "https://repobd.example:443", "https://repobd.example"],
  ])("normalizes %s", (_label, raw, expected) => {
    // The only normalizations applied are the ones that cannot mean anything
    // else. Anything structurally different is refused above, not repaired.
    expect(parseServiceOrigin(raw)).toEqual({ ok: true, origin: expected });
  });
});

// The secret id must satisfy the Worker's own capability grammar locally, so a
// malformed one is refused before a request could be addressed with it.
describe("secret id grammar matches the Worker", () => {
  const validBinding = bindingParam('{"bv":1,"repo":"github.com/acme/alpha"}');

  it("accepts a canonical 22-character capability", () => {
    expect(SECRET_ID).toHaveLength(22);
    const result = parseDeliveryLink(
      `${ORIGIN}/d/${SECRET_ID}#${validBinding}`,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a secret id that is not 22 characters", () => {
    for (const id of [
      SECRET_ID.slice(0, 21),
      `${SECRET_ID}A`,
      toBase64Url(new Uint8Array(32).fill(3)),
      "abcdefghijklmnop",
    ]) {
      expectBlocked(`${ORIGIN}/d/${id}#${validBinding}`, "invalid-secret-id");
    }
  });

  it("rejects padded or non-canonical base64url", () => {
    // 24 characters with `=` padding, and a 22-character value whose trailing
    // bits are not zero — both refused by the shared strict decoder.
    expectBlocked(
      `${ORIGIN}/d/${SECRET_ID.slice(0, 21)}%3D#${validBinding}`,
      "invalid-secret-id",
    );
    expectBlocked(
      `${ORIGIN}/d/${`${SECRET_ID.slice(0, 21)}B`}#${validBinding}`,
      "invalid-secret-id",
    );
  });

  it("rejects a secret id with a non-alphabet character", () => {
    expectBlocked(
      `${ORIGIN}/d/${`${SECRET_ID.slice(0, 21)}+`}#${validBinding}`,
      "invalid-secret-id",
    );
  });
});

// Exactly one `k`, exactly one `b`, nothing else. First-value-wins would let a
// link read as one repository and bind to another.
describe("fragment grammar is exact", () => {
  const BINDING = encodeURIComponent('{"bv":1,"repo":"github.com/acme/alpha"}');

  it("rejects a duplicate key", () => {
    expectBlocked(
      link(`k=${KEY}&k=${KEY}&b=${BINDING}`),
      "duplicate-fragment-field",
    );
  });

  it("rejects a duplicate binding", () => {
    expectBlocked(
      link(
        `k=${KEY}&b=${BINDING}&b=${encodeURIComponent('{"bv":1,"repo":"github.com/acme/beta"}')}`,
      ),
      "duplicate-fragment-field",
    );
  });

  it("rejects an unknown fragment field", () => {
    expectBlocked(
      link(`k=${KEY}&b=${BINDING}&x=ignored`),
      "unknown-fragment-field",
    );
  });

  it("rejects a missing key and a missing binding", () => {
    expectBlocked(link(`b=${BINDING}`), "missing-key");
    expectBlocked(link(`k=${KEY}`), "missing-binding");
  });

  it("accepts the two fields in either order", () => {
    expect(parseDeliveryLink(link(`k=${KEY}&b=${BINDING}`)).ok).toBe(true);
    expect(parseDeliveryLink(link(`b=${BINDING}&k=${KEY}`)).ok).toBe(true);
  });
});

describe("delivery link fails closed", () => {

  it("rejects a link with no fragment", () => {
    expectBlocked(`${ORIGIN}/d/${SECRET_ID}`, "missing-fragment");
    expectBlocked(`${ORIGIN}/d/${SECRET_ID}#`, "missing-fragment");
  });

  it("rejects a missing key", () => {
    expectBlocked(
      link(`b=${encodeURIComponent('{"bv":1,"repo":"github.com/acme/alpha"}')}`),
      "missing-key",
    );
  });

  it("rejects a key that is not an AES-256 key", () => {
    expectBlocked(
      `${ORIGIN}/d/${SECRET_ID}#k=short&b=${encodeURIComponent('{"bv":1,"repo":"github.com/acme/alpha"}')}`,
      "invalid-key",
    );
  });

  it("rejects a missing binding rather than treating it as unbound", () => {
    expectBlocked(`${ORIGIN}/d/${SECRET_ID}#k=${KEY}`, "missing-binding");
  });

  it("rejects a binding that is not JSON", () => {
    expectBlocked(link(bindingParam("not-json")), "malformed-binding");
  });

  it("rejects a binding whose repo is not canonical", () => {
    expectBlocked(
      link(bindingParam('{"bv":1,"repo":"https://github.com/acme/alpha.git"}')),
      "malformed-binding",
    );
    expectBlocked(
      link(bindingParam('{"bv":1,"repo":"git.internal.example/acme/alpha"}')),
      "malformed-binding",
    );
  });

  it("rejects an unknown binding version", () => {
    expectBlocked(
      link(bindingParam('{"bv":2,"repo":"github.com/acme/alpha"}')),
      "unsupported-binding-version",
    );
  });

  it("never repeats the key or the fragment in a failure detail", () => {
    const raw = link(bindingParam("not-json"));
    const result = parseDeliveryLink(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).not.toContain(KEY);
      expect(result.detail).not.toContain(SECRET_ID);
      expect(result.detail).not.toContain("not-json");
    }
  });
});
