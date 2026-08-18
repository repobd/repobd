import { describe, expect, it } from "vitest";
import {
  BINDING_VERSION,
  parseBinding,
  serializeBinding,
  verifyBinding,
} from "../src/repo/binding.js";
import {
  canonicalizeSupportedRemote,
  type CanonicalRepo,
} from "../src/repo/identity.js";

// The binding descriptor is a context guardrail. Nothing here is signed,
// authenticated, or tamper-proof, and these tests do not assert otherwise —
// they assert that an accident (a descriptor that does not name this
// repository, or one that cannot be read) blocks.

function repo(raw: string): CanonicalRepo {
  const result = canonicalizeSupportedRemote(raw);
  if (!result.ok) {
    throw new Error(`fixture ${raw} did not canonicalize: ${result.reason}`);
  }
  return result.repo;
}

const ALPHA = repo("https://github.com/repobd/test-alpha.git");
const BETA = repo("git@github.com:repobd/test-beta.git");

describe("serializeBinding", () => {
  it("emits exactly the two approved fields", () => {
    expect(JSON.parse(serializeBinding(ALPHA))).toEqual({
      bv: BINDING_VERSION,
      repo: "github.com/repobd/test-alpha",
    });
  });

  it("emits the identity, not the remote URL it came from", () => {
    const serialized = serializeBinding(ALPHA);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain(".git");
  });
});

describe("parseBinding", () => {
  it("round-trips a serialized descriptor", () => {
    const result = parseBinding(serializeBinding(ALPHA));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.binding).toEqual({
      bv: BINDING_VERSION,
      repo: "github.com/repobd/test-alpha",
    });
    expect(result.repo.canonical).toBe("github.com/repobd/test-alpha");
    expect(result.repo.host).toBe("github.com");
    expect(result.repo.path).toBe("repobd/test-alpha");
  });

  it("projects away unknown fields rather than carrying them", () => {
    // Written as raw JSON on purpose: an object literal's `__proto__` key
    // sets a prototype instead of becoming a property, so it would never
    // reach the parser through JSON.stringify.
    const result = parseBinding(
      '{"bv":1,"repo":"github.com/repobd/test-alpha",' +
        '"extra":"attacker supplied","__proto__":{"polluted":true}}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.keys(result.binding).sort()).toEqual(["bv", "repo"]);
    expect(Object.prototype).not.toHaveProperty("polluted");
    // The projection is what gets re-emitted, so nothing extra survives a
    // parse/serialize cycle either.
    expect(JSON.parse(serializeBinding(result.repo))).toEqual({
      bv: BINDING_VERSION,
      repo: "github.com/repobd/test-alpha",
    });
  });

  it("rejects an unknown version", () => {
    for (const bv of [0, 2, 99, -1, 1.5]) {
      const result = parseBinding(
        JSON.stringify({ bv, repo: "github.com/repobd/test-alpha" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unsupported-version");
      }
    }
  });

  it("rejects a version that is not a number", () => {
    const result = parseBinding(
      JSON.stringify({ bv: "1", repo: "github.com/repobd/test-alpha" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-version");
    }
  });

  it("rejects a missing or non-string repo", () => {
    for (const descriptor of [
      JSON.stringify({ bv: 1 }),
      JSON.stringify({ bv: 1, repo: null }),
      JSON.stringify({ bv: 1, repo: 42 }),
      JSON.stringify({ bv: 1, repo: ["github.com/repobd/test-alpha"] }),
    ]) {
      const result = parseBinding(descriptor);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid-repo");
      }
    }
  });

  it("rejects a raw remote URL in the repo field", () => {
    // The sender must bind an identity. Canonicalizing here on the receiver's
    // behalf would give one repository two spellings on the wire.
    for (const raw of [
      "https://github.com/repobd/test-alpha.git",
      "git@github.com:repobd/test-alpha.git",
      "ssh://git@github.com/repobd/test-alpha.git",
    ]) {
      const result = parseBinding(JSON.stringify({ bv: 1, repo: raw }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid-repo");
      }
    }
  });

  it("rejects an unsupported host", () => {
    for (const identity of [
      "git.example.com/team/service",
      "ssh.github.com/repobd/test-alpha",
      "gitlab.internal/group/project",
    ]) {
      const result = parseBinding(JSON.stringify({ bv: 1, repo: identity }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid-repo");
      }
    }
  });

  it("rejects a malformed canonical identity", () => {
    for (const identity of [
      "",
      "github.com",
      "github.com/repobd",
      "github.com/repobd/test-alpha/",
      "github.com//repobd/test-alpha",
      "GitHub.com/repobd/test-alpha",
      "github.com:443/repobd/test-alpha",
      "github.com/repobd/..",
      "github.com/repobd/.git",
    ]) {
      const result = parseBinding(JSON.stringify({ bv: 1, repo: identity }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid-repo");
      }
    }
  });

  it("rejects input that is not a JSON object", () => {
    expect(parseBinding("not json")).toMatchObject({ reason: "not-json" });
    expect(parseBinding("[]")).toMatchObject({ reason: "not-an-object" });
    expect(parseBinding("null")).toMatchObject({ reason: "not-an-object" });
    expect(parseBinding('"github.com/a/b"')).toMatchObject({
      reason: "not-an-object",
    });
  });
});

describe("verifyBinding", () => {
  it("matches the same repository", () => {
    expect(verifyBinding(ALPHA, ALPHA)).toEqual({ ok: true });
  });

  it("matches across the HTTPS and SSH spellings of one repository", () => {
    const https = repo("https://github.com/repobd/test-alpha.git");
    const ssh = repo("git@github.com:repobd/test-alpha.git");
    const sshUri = repo("ssh://git@github.com/repobd/test-alpha.git");
    expect(verifyBinding(https, ssh)).toEqual({ ok: true });
    expect(verifyBinding(https, sshUri)).toEqual({ ok: true });
  });

  it("blocks a different repository", () => {
    const verdict = verifyBinding(ALPHA, BETA);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) {
      return;
    }
    expect(verdict.expected).toBe("github.com/repobd/test-alpha");
    expect(verdict.actual).toBe("github.com/repobd/test-beta");
    expect(verdict.difference).toBe("other");
  });

  it("blocks a different supported host", () => {
    const gitlab = repo("https://gitlab.com/repobd/test-alpha.git");
    expect(verifyBinding(ALPHA, gitlab)).toMatchObject({ ok: false });
  });

  it("blocks a case-only difference and reports it as such", () => {
    const upper = repo("https://github.com/repobd/Test-Alpha.git");
    const verdict = verifyBinding(ALPHA, upper);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) {
      return;
    }
    // Diagnostic only. A case-only difference still blocks: on a
    // case-sensitive host these are two repositories, and only a person can
    // say which was meant.
    expect(verdict.difference).toBe("case-only");
  });

  it("does not leak the remote URL into the verdict", () => {
    const verdict = verifyBinding(ALPHA, BETA);
    if (verdict.ok) {
      return;
    }
    expect(verdict.expected).not.toContain("https://");
    expect(verdict.actual).not.toContain("git@");
  });
});
