import { describe, expect, it } from "vitest";
import { parseApplyPayload, validateAssignment } from "../src/apply/payload.js";

// The v0.1 contract under test: one delivery carries exactly one
// `KEY=value` assignment, with a conservative unquoted value.
//
// Dummy sentinel values only, per docs/TEST_STRATEGY.md. Several tests assert
// that the sentinel does not appear in a failure's `detail` — that assertion is
// the point of using a distinctive one.

const SENTINEL = "TEST_ALPHA_123456";

function expectFailure(text: string, reason: string): string {
  const result = parseApplyPayload(text);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected a failure");
  }
  expect(result.reason).toBe(reason);
  return result.detail;
}

describe("parseApplyPayload — accepted", () => {
  it("parses one KEY=value assignment", () => {
    const result = parseApplyPayload(`API_KEY=${SENTINEL}`);
    expect(result).toEqual({
      ok: true,
      assignment: { key: "API_KEY", value: SENTINEL },
    });
  });

  it("tolerates a single terminal LF", () => {
    const result = parseApplyPayload(`API_KEY=${SENTINEL}\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assignment.value).toBe(SENTINEL);
  });

  it("tolerates a single terminal CRLF", () => {
    const result = parseApplyPayload(`API_KEY=${SENTINEL}\r\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assignment).toEqual({ key: "API_KEY", value: SENTINEL });
  });

  it("accepts a leading underscore and inner digits in the key", () => {
    const result = parseApplyPayload("_OPENAI_KEY_2=abc123");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assignment.key).toBe("_OPENAI_KEY_2");
  });

  it("preserves key case exactly", () => {
    const result = parseApplyPayload("MixedCase_Key=abc");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // A lowercasing or uppercasing regression would apply the secret to a
    // variable nobody named.
    expect(result.assignment.key).toBe("MixedCase_Key");
  });

  it("splits at the first '=', so a value may contain more", () => {
    const result = parseApplyPayload("API_KEY=YWJjZA==");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assignment).toEqual({ key: "API_KEY", value: "YWJjZA==" });
  });

  it("accepts the punctuation ordinary API keys use", () => {
    const result = parseApplyPayload("API_KEY=sk-live_9.a~b+c/d=");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assignment.value).toBe("sk-live_9.a~b+c/d=");
  });
});

describe("parseApplyPayload — one delivery, one assignment", () => {
  it("rejects two valid assignments rather than choosing one", () => {
    const detail = expectFailure(
      `OPENAI_API_KEY=abc123\nANTHROPIC_API_KEY=def456`,
      "multiple-lines",
    );
    // Neither assignment may be used, reported, or echoed.
    expect(detail).not.toContain("abc123");
    expect(detail).not.toContain("def456");
    expect(detail).not.toContain("OPENAI_API_KEY");
    expect(detail).not.toContain("ANTHROPIC_API_KEY");
  });

  it("rejects two assignments with a terminal newline", () => {
    expectFailure("A=1\nB=2\n", "multiple-lines");
  });

  it("rejects a second assignment separated by a blank line", () => {
    expectFailure("A=1\n\nB=2", "multiple-lines");
  });

  it("rejects a trailing blank line beyond the single terminal newline", () => {
    expectFailure(`API_KEY=${SENTINEL}\n\n`, "multiple-lines");
  });

  it("rejects a comment line accompanying the assignment", () => {
    expectFailure(`# the key\nAPI_KEY=${SENTINEL}`, "multiple-lines");
  });

  it("rejects a trailing comment line", () => {
    expectFailure(`API_KEY=${SENTINEL}\n# note`, "multiple-lines");
  });

  it("rejects a CRLF-separated pair", () => {
    expectFailure("A=1\r\nB=2", "multiple-lines");
  });

  it("rejects a lone carriage return as a line break", () => {
    expectFailure("A=1\rB=2", "multiple-lines");
  });
});

describe("parseApplyPayload — payload shape", () => {
  it("rejects an empty payload", () => {
    expectFailure("", "empty-payload");
  });

  it("rejects a payload that is only a newline", () => {
    expectFailure("\n", "empty-payload");
  });

  it("rejects a comment-only payload", () => {
    expectFailure("# nothing here", "missing-assignment");
  });

  it("rejects a bare value with no '='", () => {
    const detail = expectFailure(SENTINEL, "missing-assignment");
    expect(detail).not.toContain(SENTINEL);
  });
});

describe("parseApplyPayload — key grammar", () => {
  it("rejects an empty key", () => {
    expectFailure("=abc", "invalid-key");
  });

  it("rejects a leading digit", () => {
    expectFailure("1API_KEY=abc", "invalid-key");
  });

  it("rejects a hyphen", () => {
    expectFailure("API-KEY=abc", "invalid-key");
  });

  it("rejects a dot", () => {
    expectFailure("API.KEY=abc", "invalid-key");
  });

  it("rejects whitespace inside the key", () => {
    expectFailure("API KEY=abc", "invalid-key");
  });

  it("rejects leading whitespace before the key", () => {
    expectFailure(" API_KEY=abc", "invalid-key");
  });

  it("rejects whitespace before the '='", () => {
    expectFailure("API_KEY =abc", "invalid-key");
  });

  it("rejects an export prefix", () => {
    // `export` is recognized when inspecting an existing .env, never in a
    // payload.
    expectFailure(`export API_KEY=${SENTINEL}`, "invalid-key");
  });

  it("never echoes the candidate key, which may itself be secret", () => {
    // A payload that is a bare secret ending in '=' yields a candidate key
    // that is the secret.
    const detail = expectFailure("sk-live-abc=", "invalid-key");
    expect(detail).not.toContain("sk-live-abc");
  });
});

describe("parseApplyPayload — value grammar", () => {
  it("rejects an empty value", () => {
    expectFailure("API_KEY=", "empty-value");
  });

  it("rejects whitespace after the '='", () => {
    expectFailure(`API_KEY= ${SENTINEL}`, "unsupported-value");
  });

  it("rejects a value containing a space", () => {
    expectFailure("API_KEY=two words", "unsupported-value");
  });

  it("rejects a value containing a tab", () => {
    expectFailure("API_KEY=a\tb", "unsupported-value");
  });

  it("rejects trailing whitespace", () => {
    expectFailure(`API_KEY=${SENTINEL} `, "unsupported-value");
  });

  it("rejects a double-quoted value", () => {
    expectFailure(`API_KEY="${SENTINEL}"`, "unsupported-value");
  });

  it("rejects a single-quoted value", () => {
    expectFailure(`API_KEY='${SENTINEL}'`, "unsupported-value");
  });

  it("rejects '#'", () => {
    expectFailure("API_KEY=abc#def", "unsupported-value");
  });

  it("rejects '$'", () => {
    expectFailure("API_KEY=abc$HOME", "unsupported-value");
  });

  it("rejects a backslash", () => {
    expectFailure("API_KEY=abc\\def", "unsupported-value");
  });

  it("rejects a backtick", () => {
    expectFailure("API_KEY=abc`id`", "unsupported-value");
  });

  it("rejects non-ASCII", () => {
    expectFailure("API_KEY=café", "unsupported-value");
  });

  it("rejects a control character", () => {
    expectFailure(`API_KEY=abc${String.fromCharCode(1)}def`, "unsupported-value");
  });

  it("rejects DEL", () => {
    expectFailure(`API_KEY=abc${String.fromCharCode(127)}def`, "unsupported-value");
  });

  it("rejects a multi-line PEM block", () => {
    const pem = "API_KEY=-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----";
    // The line break is caught first; either way it fails closed.
    expectFailure(pem, "multiple-lines");
  });

  it("never echoes the value it refused", () => {
    for (const payload of [
      `API_KEY="${SENTINEL}"`,
      `API_KEY=${SENTINEL} `,
      `API_KEY=${SENTINEL}#x`,
      `API_KEY=$${SENTINEL}`,
    ]) {
      const result = parseApplyPayload(payload);
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.detail).not.toContain(SENTINEL);
    }
  });
});

describe("validateAssignment — the shared grammar authority", () => {
  // The same rules `parseApplyPayload` applies, reachable on their own so the
  // filesystem write boundary can re-check an assignment it was handed rather
  // than trusting that it came from a parser.

  it("accepts a well-formed pair", () => {
    expect(validateAssignment("API_KEY", SENTINEL)).toEqual({
      ok: true,
      assignment: { key: "API_KEY", value: SENTINEL },
    });
  });

  it("agrees with parseApplyPayload on every case", () => {
    const pairs: readonly [string, string][] = [
      ["API_KEY", SENTINEL],
      ["_A9", "sk-live_9.a~b+c/d="],
      ["1BAD", SENTINEL],
      ["API-KEY", SENTINEL],
      ["", SENTINEL],
      ["API_KEY", ""],
      ["API_KEY", `"${SENTINEL}"`],
      ["API_KEY", "two words"],
      ["API_KEY", "a#b"],
      ["API_KEY", "café"],
    ];
    for (const [key, value] of pairs) {
      const direct = validateAssignment(key, value);
      const parsed = parseApplyPayload(`${key}=${value}`);
      // One grammar, one implementation: a divergence here means the writer
      // boundary and the parser disagree about what is applicable.
      expect(direct.ok).toBe(parsed.ok);
    }
  });

  it("rejects non-string input rather than trusting the type", () => {
    for (const bad of [undefined, null, 42, {}, [], Symbol("k")]) {
      expect(validateAssignment(bad, SENTINEL).ok).toBe(false);
      expect(validateAssignment("API_KEY", bad).ok).toBe(false);
    }
  });

  it("rejects a value carrying a newline", () => {
    expect(validateAssignment("API_KEY", `a\n${SENTINEL}`).ok).toBe(false);
  });

  it("reports a reason and nothing else", () => {
    const result = validateAssignment("1BAD", SENTINEL);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("invalid-key");
    // No detail string at all here: the caller composes safe wording, and a
    // rejected pair is unvalidated input.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain("1BAD");
  });
});

describe("parseApplyPayload — diagnostics carry no secret", () => {
  it("keeps every failure detail free of the payload", () => {
    const payloads = [
      "",
      "\n",
      SENTINEL,
      `API_KEY=${SENTINEL}\nOTHER=${SENTINEL}`,
      `1KEY=${SENTINEL}`,
      `API-KEY=${SENTINEL}`,
      "API_KEY=",
      `API_KEY="${SENTINEL}"`,
      `API_KEY=${SENTINEL} `,
    ];
    for (const payload of payloads) {
      const result = parseApplyPayload(payload);
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.detail).not.toContain(SENTINEL);
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
    }
  });
});
