import { describe, expect, it } from "vitest";
import { inspectEnvFile } from "../src/apply/env-file.js";
import { parseApplyPayload } from "../src/apply/payload.js";

// What the existing `.env` says about one key, under an allowlist: RepoBD
// recognizes a small, documented subset of `.env` syntax and refuses anything
// outside it. These tests are organized around that contract — first what is
// supported, then what falls outside — rather than around a list of individual
// syntaxes someone thought to check.
//
// Two sentinels, so a leak of either is visible: the value being applied and a
// value already sitting in the file.

const INCOMING = "TEST_ALPHA_123456";
const EXISTING = "TEST_BETA_987654";
const KEY = "API_KEY";

const NBSP = String.fromCharCode(0x00a0);
const VTAB = String.fromCharCode(0x0b);
const FORM_FEED = String.fromCharCode(0x0c);
const EM_SPACE = String.fromCharCode(0x2003);
const ZWNBSP = String.fromCharCode(0xfeff);

function inspect(text: string, key = KEY, value = INCOMING) {
  return inspectEnvFile(text, key, value);
}

function expectAction(
  text: string,
  action: string,
  key = KEY,
  value = INCOMING,
) {
  const result = inspect(text, key, value);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.reason}`);
  }
  expect(result.action).toBe(action);
  return result;
}

function expectRefusal(
  text: string,
  reason: string,
  key = KEY,
  value = INCOMING,
): string {
  const result = inspect(text, key, value);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`expected a refusal, got ${result.action}`);
  }
  expect(result.reason).toBe(reason);
  return result.detail;
}

describe("the supported subset", () => {
  it("reads an ordinary assignment holding this value", () => {
    const result = expectAction(`API_KEY=${INCOMING}\n`, "noop-success");
    expect(result.lineIndex).toBe(0);
  });

  it("reads an ordinary assignment holding a different value", () => {
    const result = expectAction(
      `API_KEY=${EXISTING}\n`,
      "replace-requires-confirmation",
    );
    expect(result.lineIndex).toBe(0);
  });

  it("reports the key absent when another key is set", () => {
    const result = expectAction(`OTHER=x\n`, "append");
    expect(result.lineIndex).toBeNull();
  });

  it("treats an empty file as absent", () => {
    const result = expectAction("", "append");
    expect(result.style).toEqual({
      empty: true,
      newline: "lf",
      endsWithNewline: false,
    });
  });

  it("handles the ordinary shape of a real file", () => {
    // Blank lines, historical comments, an unrelated key, and the active
    // target — only the last of which is eligible for replacement.
    const result = expectAction(
      [
        "# old key",
        `# API_KEY=older`,
        "",
        "OTHER_KEY=value",
        `API_KEY=${INCOMING}`,
        "",
      ].join("\n"),
      "noop-success",
    );
    expect(result.lineIndex).toBe(4);
  });

  it("never treats a commented-out key as active", () => {
    expectAction(`# API_KEY=${EXISTING}\n`, "append");
    expectAction(`#API_KEY=${EXISTING}\n`, "append");
    expectAction(`   # API_KEY=${EXISTING}\n`, "append");
  });

  it("prefers the active assignment over a commented historical one", () => {
    const result = expectAction(
      `# API_KEY=${EXISTING}\nAPI_KEY=${INCOMING}\n`,
      "noop-success",
    );
    expect(result.lineIndex).toBe(1);
  });

  it("accepts an export prefix", () => {
    const result = expectAction(`export API_KEY=${INCOMING}\n`, "noop-success");
    expect(result.lineIndex).toBe(0);
  });

  it("accepts space and tab indentation", () => {
    expectAction(` \tAPI_KEY=${INCOMING}\n`, "noop-success");
  });

  it("accepts a trailing comment, which is not part of the value", () => {
    // RepoBD reads a separated trailing comment as a comment, so under its
    // own supported interpretation the key holds the payload value and a retry
    // converges rather than asking pointlessly. This says nothing about what
    // any other consumer of the file does with it.
    expectAction(`API_KEY=${INCOMING} # note\n`, "noop-success");
  });

  it("is not confused by an equals sign inside a trailing comment", () => {
    expectAction(`API_KEY=${INCOMING} # see also=elsewhere\n`, "noop-success");
  });

  it("still asks when a trailing comment sits on a different value", () => {
    expectAction(`API_KEY=${EXISTING} # note\n`, "replace-requires-confirmation");
  });

  it("accepts a simple quoted value and compares it literally", () => {
    // RepoBD does not unquote. `"abc"` is not the same literal as `abc`, so
    // the user is asked rather than told the values match.
    expectAction(`API_KEY="${INCOMING}"\n`, "replace-requires-confirmation");
    expectAction(`API_KEY='${INCOMING}'\n`, "replace-requires-confirmation");
  });

  it("accepts a quoted value with a trailing comment", () => {
    expectAction(`API_KEY="${INCOMING}" # note\n`, "replace-requires-confirmation");
  });

  it("accepts a quoted value on an unrelated key", () => {
    expectAction(`OTHER="closed"\nAPI_KEY=${INCOMING}\n`, "noop-success");
  });

  it("accepts an empty existing value", () => {
    expectAction(`API_KEY=\n`, "replace-requires-confirmation");
  });

  it("matches keys exactly", () => {
    expectAction(`MY_API_KEY=${EXISTING}\n`, "append");
    expectAction(`API_KEY_OLD=${EXISTING}\n`, "append");
    expectAction(`api_key=${EXISTING}\n`, "append");
    const result = expectAction(
      `MY_API_KEY=a\nAPI_KEY_OLD=b\nAPI_KEY=${INCOMING}\napi_key=d\n`,
      "noop-success",
    );
    expect(result.lineIndex).toBe(2);
  });

  it("refuses a key the caller did not validate", () => {
    expectRefusal(`API_KEY=${INCOMING}\n`, "invalid-key", "1BAD");
  });
});

describe("RepoBD can always read back what RepoBD writes", () => {
  // The invariant that makes the two grammars one grammar: a canonical
  // assignment must never be classified as unsupported on a later run, or a
  // successful apply would leave a file its own retry refuses.

  const VALUES = [
    INCOMING,
    "ambiguous",
    "unsupported-syntax",
    "sk-live_9.a~b+c/d=",
    "YWJjZA==",
    "a.b.c",
    "x",
    "1",
    "!%*()[]{}^~+,./:?@",
    "A".repeat(200),
  ];

  it.each(VALUES)("round-trips %s through payload, write and read", (value) => {
    const parsed = parseApplyPayload(`API_KEY=${value}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    for (const newline of ["\n", "\r\n"]) {
      const written = `API_KEY=${parsed.assignment.value}${newline}`;
      const result = inspectEnvFile(written, "API_KEY", parsed.assignment.value);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      // Same meaning on the way back: the key holds exactly what was written,
      // so a retry converges instead of asking or refusing.
      expect(result.action).toBe("noop-success");
      expect(result.lineIndex).toBe(0);
    }
  });

  it("round-trips a canonical value appended below existing content", () => {
    const written = `# header\nOTHER=x\nAPI_KEY=${INCOMING}\n`;
    expectAction(written, "noop-success");
  });

  it("treats a value equal to an internal reason name as an ordinary value", () => {
    // No sentinel may collide with a secret: "ambiguous" is a value, not a
    // control state.
    for (const value of [
      "ambiguous",
      "unsupported-syntax",
      "duplicate-key",
      "invalid-key",
      "null",
      "undefined",
    ]) {
      const same = inspectEnvFile(`API_KEY=${value}\n`, "API_KEY", value);
      expect(same.ok).toBe(true);
      if (same.ok) {
        expect(same.action).toBe("noop-success");
      }
      const different = inspectEnvFile(`API_KEY=${value}\n`, "API_KEY", "other");
      expect(different.ok).toBe(true);
      if (different.ok) {
        expect(different.action).toBe("replace-requires-confirmation");
      }
    }
  });
});

describe("an inline comment needs a separator after a quoted value", () => {
  // Reading an immediately adjacent `#` as a comment would make an active
  // assignment behind it invisible. RepoBD does not decide what any particular
  // loader makes of that form — it is outside the supported subset.

  it("refuses an immediate # hiding an assignment", () => {
    expectRefusal(`OTHER="x"#;API_KEY=${EXISTING}\n`, "unsupported-syntax");
  });

  it("refuses an immediate # on the target's own line", () => {
    expectRefusal(`API_KEY="${EXISTING}"#;OTHER=x\n`, "unsupported-syntax");
  });

  it.each([
    ["double-quoted, immediate comment", `OTHER="x"#comment\n`],
    ["single-quoted, immediate comment", `OTHER='x'#comment\n`],
    ["immediate # with nothing after it", `OTHER="x"#\n`],
    ["immediate # on the target, plain", `API_KEY="${EXISTING}"#note\n`],
  ])("refuses %s", (_label, text) => {
    expectRefusal(text, "unsupported-syntax");
  });

  it.each([
    ["one space", `OTHER="x" # comment`],
    ["several spaces", `OTHER="x"    # comment`],
    ["a tab", `OTHER="x"\t# comment`],
    ["space then immediate hash text", `OTHER="x" #comment`],
  ])("accepts a comment separated by %s", (_label, first) => {
    const result = expectAction(`${first}\nAPI_KEY=${INCOMING}\n`, "noop-success");
    expect(result.lineIndex).toBe(1);
  });

  it("accepts a quoted value with no comment and trailing spacing", () => {
    expectAction(`OTHER="x"   \nAPI_KEY=${INCOMING}\n`, "noop-success");
  });

  it("keeps the separated form supported on the target's own line", () => {
    expectAction(`API_KEY="${INCOMING}" # note\n`, "replace-requires-confirmation");
  });

  it("applies the same rule to a bare value, without a special case", () => {
    // `#` is not a canonical value character, so an adjacent one makes the run
    // uncanonical rather than starting a comment.
    expectAction(`API_KEY=${INCOMING} # note\n`, "noop-success");
    expectRefusal(`API_KEY=${INCOMING}#note\n`, "unsupported-syntax");
  });
});

describe("values a shell would treat specially are ordinary values", () => {
  // RepoBD writes dotenv-style assignments. Shell `source` semantics are
  // outside the v0.1 compatibility contract, so a value a shell would expand
  // is not thereby invalid — what matters is that RepoBD reads back exactly
  // what RepoBD wrote.

  const SHELL_SPECIAL = ["~", "(x)", "*", "?", "[a]", "{a}", "!", "^", "%", "@host", "a~b"];

  it.each(SHELL_SPECIAL)("accepts and round-trips %s", (value) => {
    const parsed = parseApplyPayload(`API_KEY=${value}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.assignment.value).toBe(value);
    const result = inspectEnvFile(
      `API_KEY=${value}\n`,
      "API_KEY",
      parsed.assignment.value,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("noop-success");
    }
  });
});

describe("outside the subset — several assignments on one physical line", () => {
  // Refused for being outside the grammar, not because a list of suspicious
  // delimiters happened to match. The two directions fail differently: the
  // first would hide an active target and append a duplicate, the second would
  // delete unrelated content during a replacement.

  it.each([
    ["space, target hidden", `OTHER=x API_KEY=${EXISTING}\n`],
    ["space, target first", `API_KEY=${EXISTING} OTHER=x\n`],
    ["semicolon, target hidden", `OTHER=x;API_KEY=${EXISTING}\n`],
    ["semicolon, target first", `API_KEY=${EXISTING};OTHER=x\n`],
    ["&&, target hidden", `OTHER=x&&API_KEY=${EXISTING}\n`],
    ["&&, target first", `API_KEY=${EXISTING}&&OTHER=x\n`],
    ["single &", `OTHER=x&API_KEY=${EXISTING}\n`],
    ["pipe", `OTHER=x|API_KEY=${EXISTING}\n`],
    ["redirect", `OTHER=x>API_KEY=${EXISTING}\n`],
    ["three fragments", `A=1 B=2 C=3\nAPI_KEY=${INCOMING}\n`],
    ["exported compound", `export API_KEY=${EXISTING} OTHER=x\n`],
    ["quoted then fragment", `OTHER="closed" AGAIN="open\nAPI_KEY=${INCOMING}\n`],
    ["quoted then closed fragment", `OTHER="closed" AGAIN="also"\n`],
    ["stray trailing quote", `OTHER="closed" "stray\n`],
    ["fragment on the target's own quoted line", `API_KEY="${EXISTING}" EXTRA="x"\n`],
  ])("refuses %s", (_label, text) => {
    expectRefusal(text, "unsupported-syntax");
  });

  it("refuses even when the target itself is on a clean line", () => {
    // One unsupported line makes the file unsafe: the target may be set on
    // that line too, and RepoBD cannot tell.
    expectRefusal(`OTHER=x AGAIN=y\nAPI_KEY=${INCOMING}\n`, "unsupported-syntax");
  });
});

describe("outside the subset — values spanning more than one line", () => {
  // No dedicated multiline detector exists any more. A multiline value's
  // opening line is not a supported line, and neither is its continuation, so
  // both are refused by the same rule as everything else.

  it.each([
    ["double-quoted target", `API_KEY="old\ncontinuation"\n`],
    ["single-quoted target", `API_KEY='old\ncontinuation'\n`],
    ["backtick target", "API_KEY=`old\ncontinuation`\n"],
    ["exported multiline target", `export API_KEY="old\ncontinuation"\n`],
    ["multiline on another key", `OTHER="open\nAPI_KEY=${EXISTING}\nclose"\n`],
    ["dotted-key opener", `OTHER.KEY="open\nAPI_KEY=${EXISTING}\nclose"\n`],
    ["colon-style opener", `OTHER: "open\nAPI_KEY=${EXISTING}\nclose"\n`],
    ["never closed", `OTHER="open\nAPI_KEY=${INCOMING}\n`],
    ["closes on a later line", `OTHER="open\nstill inside\nclose"\nAPI_KEY=${INCOMING}\n`],
  ])("refuses %s", (_label, text) => {
    expectRefusal(text, "unsupported-syntax");
  });

  it("refuses a multiline value rather than reporting a no-op", () => {
    // The opener line is all RepoBD could compare, so it must not be able to
    // report the key as already holding the payload value.
    expectRefusal(`API_KEY="${INCOMING}\ncontinuation"\n`, "unsupported-syntax");
  });
});

describe("outside the subset — quoting RepoBD does not read", () => {
  it.each([
    ["escaped quote", `OTHER="a\\"b"\n`],
    ["backslash in a quoted value", `API_KEY="a\\b"\n`],
    ["backtick-quoted value", "API_KEY=`abc`\n"],
    ["unbalanced quote in a bare value", `API_KEY=ab"cd\n`],
    ["hash inside a bare value", `API_KEY=a#b\n`],
    ["dollar inside a bare value", `API_KEY=a$b\n`],
    ["quoted value with an inner quote", `API_KEY="a"b"\n`],
  ])("refuses %s", (_label, text) => {
    expectRefusal(text, "unsupported-syntax");
  });
});

describe("outside the subset — spacing a loader would read differently", () => {
  // RepoBD reads space and tab. A loader whose indent-strip is `\s`-based
  // reads more than that, and a line the two would read differently is
  // refused rather than adjudicated — in either direction.

  const EXOTIC: readonly [string, string][] = [
    ["non-breaking space", NBSP],
    ["vertical tab", VTAB],
    ["form feed", FORM_FEED],
    ["em space", EM_SPACE],
    ["zero-width no-break space", ZWNBSP],
  ];

  it.each(EXOTIC)("refuses a %s indent", (_label, ws) => {
    expectRefusal(`${ws}API_KEY=${EXISTING}\n`, "unsupported-syntax");
  });

  it.each(EXOTIC)("refuses a %s after export", (_label, ws) => {
    expectRefusal(`export${ws}API_KEY=${EXISTING}\n`, "unsupported-syntax");
  });

  it.each(EXOTIC)("refuses a %s before the equals sign", (_label, ws) => {
    expectRefusal(`API_KEY${ws}=${EXISTING}\n`, "unsupported-syntax");
  });

  it("refuses exotic spacing on an unrelated key too", () => {
    // The file as a whole is what must be readable.
    expectRefusal(`${NBSP}OTHER=x\nAPI_KEY=${INCOMING}\n`, "unsupported-syntax");
  });

  it("refuses a space before the value", () => {
    // RepoBD does not trim on the file's behalf, and does not guess whether a
    // loader would.
    expectRefusal(`API_KEY= ${INCOMING}\n`, "unsupported-syntax");
    expectRefusal(`API_KEY = ${INCOMING}\n`, "unsupported-syntax");
  });

  it("refuses an unquoted value containing spaces", () => {
    // Indistinguishable from two assignments without guessing. Quote it, and
    // RepoBD reads the file again.
    expectRefusal(`OTHER=a b c\nAPI_KEY=${INCOMING}\n`, "unsupported-syntax");
    expectAction(`OTHER="a b c"\nAPI_KEY=${INCOMING}\n`, "noop-success");
  });
});

describe("outside the subset — lines that are not assignments at all", () => {
  it.each([
    ["a section header", `[section]\nAPI_KEY=${INCOMING}\n`],
    ["free text", `some free text\nAPI_KEY=${INCOMING}\n`],
    ["a bare key name", `API_KEY\n`],
    ["a colon-style line", `API_KEY: ${EXISTING}\n`],
    ["a mangled target line", `API_KEY ${EXISTING}\n`],
    ["a key with a hyphen", `API-KEY=${EXISTING}\n`],
    ["a key starting with a digit", `1KEY=${EXISTING}\n`],
  ])("refuses %s", (_label, text) => {
    expectRefusal(text, "unsupported-syntax");
  });
});

describe("duplicate active target keys", () => {
  it("refuses two active assignments of the target", () => {
    expectRefusal(
      `API_KEY=${EXISTING}\nAPI_KEY=${INCOMING}\n`,
      "duplicate-key",
    );
  });

  it("refuses a duplicate even when both hold this value", () => {
    expectRefusal(
      `API_KEY=${INCOMING}\nAPI_KEY=${INCOMING}\n`,
      "duplicate-key",
    );
  });

  it("refuses a duplicate spelled with export", () => {
    expectRefusal(
      `API_KEY=${EXISTING}\nexport API_KEY=${INCOMING}\n`,
      "duplicate-key",
    );
  });

  it("does not count a commented historical key as a duplicate", () => {
    expectAction(
      `# API_KEY=${EXISTING}\nAPI_KEY=${INCOMING}\n`,
      "noop-success",
    );
  });
});

describe("line style", () => {
  it("reports LF with a trailing newline", () => {
    const result = expectAction(`OTHER=x\n`, "append");
    expect(result.style).toEqual({
      empty: false,
      newline: "lf",
      endsWithNewline: true,
    });
  });

  it("reports LF without a trailing newline", () => {
    const result = expectAction(`OTHER=x`, "append");
    expect(result.style).toEqual({
      empty: false,
      newline: "lf",
      endsWithNewline: false,
    });
  });

  it("reports CRLF", () => {
    const result = expectAction(`OTHER=x\r\nTHIRD=y\r\n`, "append");
    expect(result.style).toEqual({
      empty: false,
      newline: "crlf",
      endsWithNewline: true,
    });
  });

  it("reports CRLF without a trailing newline", () => {
    const result = expectAction(`OTHER=x\r\nTHIRD=y`, "append");
    expect(result.style.newline).toBe("crlf");
    expect(result.style.endsWithNewline).toBe(false);
  });

  it("refuses mixed line endings", () => {
    expectRefusal(`OTHER=x\r\nTHIRD=y\n`, "mixed-line-endings");
  });

  it("refuses a stray carriage return", () => {
    expectRefusal(`OTHER=x\rTHIRD=y\n`, "stray-carriage-return");
  });

  it("indexes lines correctly in a CRLF file", () => {
    const result = expectAction(
      `# header\r\nOTHER=x\r\nAPI_KEY=${EXISTING}\r\n`,
      "replace-requires-confirmation",
    );
    expect(result.lineIndex).toBe(2);
  });

  it("indexes the last line of a file with no trailing newline", () => {
    const result = expectAction(
      `OTHER=x\nAPI_KEY=${EXISTING}`,
      "replace-requires-confirmation",
    );
    expect(result.lineIndex).toBe(1);
  });

  it("treats a file of only a newline as absent", () => {
    const result = expectAction(`\n`, "append");
    expect(result.style.empty).toBe(false);
    expect(result.style.endsWithNewline).toBe(true);
  });
});

describe("diagnostics carry no secret", () => {
  it("names the key but never a value", () => {
    const detail = expectRefusal(
      `API_KEY=${EXISTING}\nAPI_KEY=${INCOMING}\n`,
      "duplicate-key",
    );
    expect(detail).toContain(KEY);
    expect(detail).not.toContain(EXISTING);
    expect(detail).not.toContain(INCOMING);
  });

  it("keeps every refusal free of both values", () => {
    const cases: readonly [string, string][] = [
      [`API_KEY=${EXISTING}\nAPI_KEY=${INCOMING}\n`, "duplicate-key"],
      [`OTHER=x API_KEY=${EXISTING}\n`, "unsupported-syntax"],
      [`API_KEY=${EXISTING};OTHER=x\n`, "unsupported-syntax"],
      [`OTHER="${EXISTING}\n`, "unsupported-syntax"],
      [`API_KEY="${EXISTING}\ncont"\n`, "unsupported-syntax"],
      [`${NBSP}API_KEY=${EXISTING}\n`, "unsupported-syntax"],
      [`OTHER=${EXISTING}\r\nTHIRD=${INCOMING}\n`, "mixed-line-endings"],
      [`OTHER=${EXISTING}\rTHIRD=y\n`, "stray-carriage-return"],
    ];
    for (const [text, reason] of cases) {
      const result = inspect(text);
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.reason).toBe(reason);
      expect(result.detail).not.toContain(EXISTING);
      expect(result.detail).not.toContain(INCOMING);
    }
  });

  it("returns no value in a successful inspection either", () => {
    const result = inspect(`API_KEY=${EXISTING}\n`);
    expect(JSON.stringify(result)).not.toContain(EXISTING);
    expect(JSON.stringify(result)).not.toContain(INCOMING);
  });
});
