import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  EXIT_BLOCKED,
  EXIT_OK,
  SEND_TTL_SECONDS,
  runPull,
  runSend,
} from "../src/cli/commands.js";
import { parseDeliveryLink } from "../src/cli/link.js";
import { generateCapability } from "../src/cli/capability.js";
import { promptForSecret } from "../src/cli/prompt.js";
import {
  DEFAULT_SERVER_ORIGIN,
  SERVER_ORIGIN_ENV,
  type ClaimOutcome,
  type ConsumeOutcome,
  type CreateOutcome,
  type ReleaseOutcome,
  type SecretClient,
} from "../src/cli/secret-client.js";
import { MAX_PLAINTEXT_BYTES } from "../src/crypto/envelope-format.js";
import { decrypt, importKey, parseEnvelope } from "../src/crypto/envelope.js";
import { canonicalizeSupportedRemote } from "../src/repo/identity.js";
import type { RepoResolution } from "../src/repo/git.js";

// The whole `repobd send` lifecycle: prompt, validate, encrypt, create, link.
// Real crypto, a real repository binding, and a real link — only the RepoBD
// service is a double. No network is used and no production endpoint is
// contacted.
//
// Two properties run through the whole file. Nothing reaches the network until
// the input has passed the same grammar the receiver will re-apply after
// decrypting, so a payload that could never be applied is never created. And
// the only thing that goes on the wire is a ciphertext envelope and a TTL: not
// the value, not the key, not the repository.

const SECRET = "TEST_ALPHA_123456";
const KEY_NAME = "API_KEY";
const REPO = "github.com/acme/alpha";
const ORIGIN = "https://repobd.example";

let root: string;
let previousServerUrl: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "repobd-send-"));
  previousServerUrl = process.env[SERVER_ORIGIN_ENV];
  // A hosted-style https origin, which is what most of this file exercises.
  // The loopback development default, and every origin the policy refuses, are
  // exercised separately below.
  process.env[SERVER_ORIGIN_ENV] = ORIGIN;
});

afterEach(() => {
  if (previousServerUrl === undefined) {
    delete process.env[SERVER_ORIGIN_ENV];
  } else {
    process.env[SERVER_ORIGIN_ENV] = previousServerUrl;
  }
  rmSync(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  return mkdtemp(path.join(root, "case-"));
}

const envPath = (dir: string): string => path.join(dir, ".env");
const readEnv = (dir: string): string => readFileSync(envPath(dir), "utf8");
const hasEnv = (dir: string): boolean => readdirSync(dir).includes(".env");

function canonical(identity: string) {
  const result = canonicalizeSupportedRemote(`https://${identity}.git`);
  if (!result.ok) {
    throw new Error(`fixture ${identity} did not canonicalize`);
  }
  return result.repo;
}

function resolverFor(dir: string, identity = REPO) {
  return async (): Promise<RepoResolution> => ({
    ok: true,
    repo: canonical(identity),
    root: dir,
  });
}

function failingResolver(reason: "not-a-repository" | "no-origin") {
  return async (): Promise<RepoResolution> => ({
    ok: false,
    reason,
    detail: "fixture resolution failure",
  });
}

interface Created {
  readonly envelope: string;
  readonly ttlSeconds: number;
}

interface Sender {
  readonly client: (origin: string) => SecretClient;
  /** Every create call, with exactly what it was given. */
  readonly created: Created[];
  /** How many times a client was even constructed. */
  clients: number;
  readonly origins: string[];
  /** Anything a `send` must never do. */
  readonly other: string[];
}

/** A service double whose create either succeeds or fails as scripted. */
function sender(
  outcome: CreateOutcome | "ok" = "ok",
  storedId: string = generateCapability(),
): Sender {
  const state: Sender = {
    clients: 0,
    created: [],
    origins: [],
    other: [],
    client: (origin: string) => {
      state.clients += 1;
      state.origins.push(origin);
      return {
        async create(envelope, ttlSeconds): Promise<CreateOutcome> {
          state.created.push({ envelope, ttlSeconds });
          return outcome === "ok" ? { ok: true, id: storedId } : outcome;
        },
        async claim(): Promise<ClaimOutcome> {
          state.other.push("claim");
          return { ok: false, reason: "rejected" };
        },
        async release(): Promise<ReleaseOutcome> {
          state.other.push("release");
          return { ok: false, reason: "rejected" };
        },
        async consume(): Promise<ConsumeOutcome> {
          state.other.push("consume");
          return { ok: false, reason: "rejected" };
        },
      };
    },
  };
  return state;
}

interface RunResult {
  code: number;
  out: string[];
  err: string[];
  all: string;
  svc: Sender;
  /** How many times the secret prompt was reached. */
  prompts: number;
}

async function send(
  dir: string,
  key: string,
  value: string,
  options: {
    svc?: Sender;
    resolveRepo?: (cwd: string) => Promise<RepoResolution>;
    identity?: string;
  } = {},
): Promise<RunResult> {
  const svc = options.svc ?? sender();
  const out: string[] = [];
  const err: string[] = [];
  let prompts = 0;
  const code = await runSend({
    readSecret: async () => {
      prompts += 1;
      return { key, value };
    },
    cwd: dir,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    resolveRepo: options.resolveRepo ?? resolverFor(dir, options.identity),
    createClient: svc.client,
  });
  return { code, out, err, all: [...out, ...err].join("\n"), svc, prompts };
}

/** The single link line a successful send prints. */
function linkFrom(run: RunResult): string {
  const line = run.out.at(-1);
  if (line === undefined) {
    throw new Error("send printed nothing");
  }
  return line;
}

describe("happy path", () => {
  it("creates a delivery and prints a link that parses", async () => {
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET);

    expect(run.code).toBe(EXIT_OK);
    expect(run.svc.created).toHaveLength(1);

    const parsed = parseDeliveryLink(linkFrom(run));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.link.origin).toBe(ORIGIN);
    expect(parsed.link.repo.canonical).toBe(REPO);
    expect(parsed.link.secretId).toBeTruthy();
  });

  it("binds the link to the repository the sender is standing in", async () => {
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET, {
      identity: "gitlab.com/acme/beta",
    });
    const parsed = parseDeliveryLink(linkFrom(run));
    expect(parsed.ok && parsed.link.repo.canonical).toBe("gitlab.com/acme/beta");
  });

  it("encrypts the assignment the receiver will apply, and nothing else", async () => {
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET);
    const parsed = parseDeliveryLink(linkFrom(run));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    // The envelope handed to the service, opened with the key from the link's
    // fragment — the two halves that never travel together.
    const envelope = run.svc.created[0]?.envelope as string;
    const plaintext = await decrypt(
      parseEnvelope(envelope),
      await importKey(parsed.link.key),
    );
    expect(plaintext).toBe(`${KEY_NAME}=${SECRET}`);
  });

  it("names the repository before asking for anything", async () => {
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET);
    expect(run.out[0]).toBe(`This repository: ${REPO}`);
    expect(run.err).toEqual([]);
  });

  it("round-trips: what send produces, pull applies", async () => {
    // The end of the lifecycle this phase exists to close. The link goes
    // straight from `send` into `pull`, against the same fixture repository,
    // through a service double that hands back exactly what create stored.
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET);
    const link = linkFrom(run);
    const envelope = run.svc.created[0]?.envelope as string;

    const ops: string[] = [];
    const pullOut: string[] = [];
    const pullErr: string[] = [];
    const code = await runPull({
      readLink: async () => link,
      cwd: dir,
      out: (l) => pullOut.push(l),
      err: (l) => pullErr.push(l),
      resolveRepo: resolverFor(dir),
      createClient: () => ({
        async create() {
          throw new Error("pull must not create");
        },
        async claim() {
          ops.push("claim");
          return {
            ok: true,
            envelope,
            claimExpiresAt: 0,
            leaseRemainingMs: 5 * 60_000,
          };
        },
        async release() {
          ops.push("release");
          return { ok: true };
        },
        async consume() {
          ops.push("consume");
          return { ok: true };
        },
      }),
      confirmReplacement: async () => "no",
    });

    expect(code).toBe(EXIT_OK);
    expect(ops).toEqual(["claim", "claim", "consume"]);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
    // The receiving side prints neither the value nor the link it was given.
    const pullAll = [...pullOut, ...pullErr].join("\n");
    expect(pullAll).not.toContain(SECRET);
    expect(pullAll).not.toContain(link);
  });

  it("does not pull the delivery itself", async () => {
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET);
    // Create is the only lifecycle call a send makes.
    expect(run.svc.other).toEqual([]);
    expect(hasEnv(dir)).toBe(false);
  });
});

describe("the TTL is a constant", () => {
  it("always sends exactly 900 seconds", async () => {
    expect(SEND_TTL_SECONDS).toBe(900);
    for (const value of [SECRET, "x", "0123456789"]) {
      const dir = await workspace();
      const run = await send(dir, KEY_NAME, value);
      expect(run.code).toBe(EXIT_OK);
      expect(run.svc.created[0]?.ttlSeconds).toBe(900);
    }
  });

  it("is well inside the Worker's own maximum", () => {
    // The Worker caps TTL at 86400s and that validation is untouched by this
    // phase; this pins that the CLI constant cannot drift past it.
    expect(SEND_TTL_SECONDS).toBeLessThanOrEqual(86_400);
    expect(SEND_TTL_SECONDS).toBeGreaterThan(0);
  });
});

describe("what leaves the process", () => {
  it("is a ciphertext envelope and a TTL, and nothing else", async () => {
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET);
    const created = run.svc.created[0] as Created;

    expect(created.ttlSeconds).toBe(SEND_TTL_SECONDS);
    // Neither the plaintext, the key name, nor the repository is in it.
    expect(created.envelope).not.toContain(SECRET);
    expect(created.envelope).not.toContain(KEY_NAME);
    expect(created.envelope).not.toContain(REPO);
    // And it is exactly the four approved envelope fields.
    expect(Object.keys(JSON.parse(created.envelope)).sort()).toEqual([
      "alg",
      "ct",
      "iv",
      "v",
    ]);

    // The key that opens it never went with it.
    const parsed = parseDeliveryLink(linkFrom(run));
    expect(parsed.ok && created.envelope.includes(parsed.link.key)).toBe(false);
  });

  it("uses a fresh key and a fresh envelope for every delivery", async () => {
    const first = await send(await workspace(), KEY_NAME, SECRET);
    const second = await send(await workspace(), KEY_NAME, SECRET);
    const a = parseDeliveryLink(linkFrom(first));
    const b = parseDeliveryLink(linkFrom(second));
    expect(a.ok && b.ok && a.link.key === b.link.key).toBe(false);
    expect(first.svc.created[0]?.envelope).not.toBe(
      second.svc.created[0]?.envelope,
    );
  });
});

describe("input that is not a deliverable assignment", () => {
  const REJECTED: readonly [string, string, string][] = [
    ["a key that is not a variable name", "not a key", SECRET],
    ["a key with an equals sign", `${KEY_NAME}=x`, SECRET],
    ["a key starting with a digit", "1KEY", SECRET],
    ["an empty key", "", SECRET],
    ["an empty value", KEY_NAME, ""],
    ["a value with a space", KEY_NAME, "two words"],
    ["a value with a quote", KEY_NAME, `"quoted"`],
    ["a value with a dollar sign", KEY_NAME, "$INTERPOLATED"],
    ["a value with a semicolon", KEY_NAME, "a;OTHER=b"],
    ["a value with a newline", KEY_NAME, "A=1\nB=2"],
    ["a non-ASCII value", KEY_NAME, "café"],
  ];

  it.each(REJECTED)("refuses %s before any network call", async (_l, key, value) => {
    const dir = await workspace();
    const run = await send(dir, key, value);

    expect(run.code).toBe(EXIT_BLOCKED);
    // The point of the whole ordering: no client was even constructed.
    expect(run.svc.clients).toBe(0);
    expect(run.svc.created).toEqual([]);
    expect(run.all).not.toContain("#k=");
    expect(run.err.at(-1)).toBe("No delivery link was created.");
  });

  it.each(REJECTED)("never echoes the rejected input for %s", async (_l, key, value) => {
    // A rejected key can itself be secret material: someone who pastes an API
    // key at the KEY prompt has typed a secret into the field RepoBD is about
    // to complain about.
    const dir = await workspace();
    const run = await send(dir, key, value);
    if (value !== "") {
      expect(run.all).not.toContain(value);
    }
    if (key !== "" && key !== KEY_NAME) {
      expect(run.all).not.toContain(key);
    }
  });

  it("refuses a payload larger than 64 KiB before any network call", async () => {
    const dir = await workspace();
    const oversized = "a".repeat(MAX_PLAINTEXT_BYTES + 1);
    const run = await send(dir, KEY_NAME, oversized);

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.clients).toBe(0);
    expect(run.svc.created).toEqual([]);
    expect(run.all).toContain("64 KiB");
    expect(run.all).not.toContain(oversized);
  });

  it("accepts a payload at exactly the limit", async () => {
    // The boundary belongs to the crypto layer, and this pins that `send` does
    // not narrow it with a second check of its own.
    const dir = await workspace();
    const value = "a".repeat(MAX_PLAINTEXT_BYTES - (KEY_NAME.length + 1));
    const run = await send(dir, KEY_NAME, value);
    expect(run.code).toBe(EXIT_OK);
    expect(run.svc.created).toHaveLength(1);
  });
});

describe("an unresolvable repository", () => {
  it("never asks for the secret and never reaches the network", async () => {
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET, {
      resolveRepo: failingResolver("not-a-repository"),
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    // The secret was never typed, so there was nothing to leak.
    expect(run.prompts).toBe(0);
    expect(run.svc.clients).toBe(0);
    expect(run.all).toContain("Not inside a Git repository.");
    expect(run.err.at(-1)).toBe("No delivery link was created.");
  });

  it("produces no link for an unsupported origin", async () => {
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET, {
      resolveRepo: failingResolver("no-origin"),
    });
    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.all).not.toContain("#k=");
  });
});

describe("a service that refuses the delivery", () => {
  it.each([
    ["unreachable", "Could not reach the RepoBD service."],
    ["rejected", "The RepoBD service returned an unexpected response."],
    ["malformed-response", "The RepoBD service returned an unexpected response."],
  ] as const)("reports %s and prints no link", async (reason, message) => {
    const dir = await workspace();
    const svc = sender({ ok: false, reason });
    const run = await send(dir, KEY_NAME, SECRET, { svc });

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.err).toContain(message);
    expect(run.err.at(-1)).toBe("No delivery link was created.");
    expect(run.all).not.toContain("#k=");
    expect(run.all).not.toContain(SECRET);
  });
});

describe("nothing secret reaches an output channel", () => {
  it("keeps the value and the key material out of everything but the link", async () => {
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET);
    const link = linkFrom(run);
    const parsed = parseDeliveryLink(link);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    // The plaintext value appears nowhere at all — not even in the link, which
    // carries only the key to it.
    expect(run.all).not.toContain(SECRET);
    // The envelope is never printed.
    expect(run.all).not.toContain(run.svc.created[0]?.envelope as string);
    expect(run.all).not.toContain("A256GCM");
    // Nothing goes to stderr on a successful send.
    expect(run.err).toEqual([]);
    // Exactly one line carries a fragment, and it is the last one.
    const withFragment = run.out.filter((line) => line.includes("#k="));
    expect(withFragment).toEqual([link]);
    // The key material appears only inside that line.
    const withoutLink = run.out.filter((line) => line !== link).join("\n");
    expect(withoutLink).not.toContain(parsed.link.key);
    expect(withoutLink).not.toContain(parsed.link.secretId);
  });

  it("never prints the origin it was configured with on a failure", async () => {
    const dir = await workspace();
    const svc = sender({ ok: false, reason: "unreachable" });
    const run = await send(dir, KEY_NAME, SECRET, { svc });
    expect(run.all).not.toContain(ORIGIN);
  });
});

describe("the server origin", () => {
  it("addresses the client at the configured origin", async () => {
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET);
    expect(run.svc.origins).toEqual([ORIGIN]);
  });

  it("falls back to the default production origin, and that link is pullable", async () => {
    // The whole default-origin flow, end to end, through the real parser: no
    // `REPOBD_SERVER_URL`, so `DEFAULT_SERVER_ORIGIN` is used, and the link
    // `send` prints must be one `pull` will accept. A sender that could
    // report success holding a link the receiving side refuses is the bug this
    // pins shut. The transport is a service double either way — no network
    // call reaches the real default origin here.
    delete process.env[SERVER_ORIGIN_ENV];
    const dir = await workspace();
    const svc = sender();
    const run = await send(dir, KEY_NAME, SECRET, { svc });

    expect(run.code).toBe(EXIT_OK);
    expect(svc.origins).toEqual([DEFAULT_SERVER_ORIGIN]);
    const parsed = parseDeliveryLink(linkFrom(run));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.link.origin).toBe(DEFAULT_SERVER_ORIGIN);
    expect(parsed.link.repo.canonical).toBe(REPO);
    // And it really does decrypt with the key that link carries.
    const envelope = svc.created[0]?.envelope as string;
    await expect(
      decrypt(parseEnvelope(envelope), await importKey(parsed.link.key)),
    ).resolves.toBe(`${KEY_NAME}=${SECRET}`);
  });

  it.each([
    ["the IPv4 loopback address", "http://127.0.0.1:8787"],
    ["the IPv6 loopback address", "http://[::1]:8787"],
  ])("also accepts plain http on %s", async (_label, origin) => {
    process.env[SERVER_ORIGIN_ENV] = origin;
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET);
    expect(run.code).toBe(EXIT_OK);
    expect(run.svc.origins).toEqual([origin]);
    expect(parseDeliveryLink(linkFrom(run))).toMatchObject({ ok: true });
  });

  it("normalizes a trailing slash rather than refusing it", async () => {
    process.env[SERVER_ORIGIN_ENV] = `${ORIGIN}/`;
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET);
    expect(run.code).toBe(EXIT_OK);
    expect(run.svc.origins).toEqual([ORIGIN]);
  });

  const BAD_ORIGINS: readonly [string, string][] = [
    ["http on a remote host", "http://example.com"],
    ["http on a LAN address", "http://192.168.1.5:8787"],
    ["http on a public address", "http://203.0.113.7:8787"],
    ["a lookalike loopback host", "http://localhost.example.com:8787"],
    ["a non-http scheme", "ftp://repobd.example"],
    ["a path", "http://localhost:8787/api"],
    ["a query", "http://localhost:8787/?x=1"],
    ["a fragment", "http://localhost:8787/#k=1"],
    ["credentials", "http://user:pass@localhost:8787"],
    ["https credentials", "https://user:pass@repobd.example"],
    ["a malformed value", "not a url"],
    ["a bare host with no scheme", "repobd.example"],
  ];

  it.each(BAD_ORIGINS)(
    "refuses %s before anything is created",
    async (_label, origin) => {
      process.env[SERVER_ORIGIN_ENV] = origin;
      const dir = await workspace();
      const run = await send(dir, KEY_NAME, SECRET);

      expect(run.code).toBe(EXIT_BLOCKED);
      // Nothing was typed, no client was constructed, nothing was created: the
      // check runs before the prompt and before the network.
      expect(run.prompts).toBe(0);
      expect(run.svc.clients).toBe(0);
      expect(run.svc.created).toEqual([]);
      expect(run.all).toContain(SERVER_ORIGIN_ENV);
      expect(run.all).not.toContain("#k=");
      expect(run.err.at(-1)).toBe("No delivery link was created.");
    },
  );

  it("never quotes the origin it refused", async () => {
    process.env[SERVER_ORIGIN_ENV] = "http://user:token@internal.example/api";
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, SECRET);
    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.all).not.toContain("token");
    expect(run.all).not.toContain("internal.example");
  });
});

describe("the secret prompt", () => {
  /** Piped input: everything arrives in one chunk, before either prompt. */
  function piped(text: string): Readable {
    return Readable.from([text]);
  }

  // The prompts themselves go to the real stderr; silenced so the suite's
  // output stays readable. What they contain is asserted in `prompt.ts`'s own
  // constants, not here.
  const realWrite = process.stderr.write.bind(process.stderr);
  beforeEach(() => {
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stderr.write = realWrite;
  });

  it("reads the key and the value from one piped chunk", async () => {
    // The regression this pins: two consecutive `rl.question` calls can lose
    // the second line when stdin is a pipe, because readline may emit both
    // lines before the second question is registered. The value is dropped,
    // and the read that follows either hangs waiting for input that has
    // already arrived or fails at end of input, depending on stream timing.
    await expect(promptForSecret(piped(`${KEY_NAME}\n${SECRET}\n`))).resolves.toEqual(
      { key: KEY_NAME, value: SECRET },
    );
  });

  it("does not take the value from the key line", async () => {
    await expect(
      promptForSecret(piped(`${KEY_NAME}=${SECRET}\n${SECRET}\n`)),
    ).resolves.toEqual({ key: `${KEY_NAME}=${SECRET}`, value: SECRET });
  });

  it("trims the key and leaves the value byte-exact", async () => {
    // Whitespace around a variable name is never meaningful; whitespace in a
    // value is the secret itself and must not be quietly repaired — it fails
    // the grammar instead.
    await expect(
      promptForSecret(piped(`  ${KEY_NAME}  \n ${SECRET} \n`)),
    ).resolves.toEqual({ key: KEY_NAME, value: ` ${SECRET} ` });
  });

  it("yields empty input rather than hanging when the stream ends early", async () => {
    await expect(promptForSecret(piped(`${KEY_NAME}\n`))).resolves.toEqual({
      key: KEY_NAME,
      value: "",
    });
    await expect(promptForSecret(piped(""))).resolves.toEqual({
      key: "",
      value: "",
    });
  });

  it("refuses input the stream never supplied", async () => {
    // The end-of-input case reaching `runSend`: an empty value is not a
    // deliverable assignment, so it blocks before any network call.
    const dir = await workspace();
    const run = await send(dir, KEY_NAME, "");
    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.clients).toBe(0);
  });
});

describe("caller options are captured before the first suspension", () => {
  /** A prompt the test resolves by hand, so the window stays open. */
  function pendingSecret(): {
    readSecret: () => Promise<{ key: string; value: string }>;
    resolve: (input: { key: string; value: string }) => void;
    started: Promise<void>;
  } {
    let release: (input: { key: string; value: string }) => void = () =>
      undefined;
    let began: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      began = r;
    });
    const pending = new Promise<{ key: string; value: string }>((r) => {
      release = r;
    });
    return {
      readSecret: () => {
        began();
        return pending;
      },
      resolve: (input) => release(input),
      started,
    };
  }

  it("cannot be given a different network client after it starts", async () => {
    const dir = await workspace();
    const captured = sender();
    const swapped = sender();
    const prompt = pendingSecret();

    const options: Record<string, unknown> = {
      readSecret: prompt.readSecret,
      cwd: dir,
      out: () => undefined,
      err: () => undefined,
      resolveRepo: resolverFor(dir),
      createClient: captured.client,
    };

    const run = runSend(options as never);
    await prompt.started;
    options["createClient"] = swapped.client;
    prompt.resolve({ key: KEY_NAME, value: SECRET });
    await run;

    expect(captured.created).toHaveLength(1);
    expect(swapped.clients).toBe(0);
    expect(swapped.created).toEqual([]);
  });

  it("cannot have its output channels swapped after it starts", async () => {
    const dir = await workspace();
    const svc = sender();
    const prompt = pendingSecret();
    const captured: string[] = [];
    const swapped: string[] = [];

    const options: Record<string, unknown> = {
      readSecret: prompt.readSecret,
      cwd: dir,
      out: (l: string) => captured.push(l),
      err: (l: string) => captured.push(l),
      resolveRepo: resolverFor(dir),
      createClient: svc.client,
    };

    const run = runSend(options as never);
    await prompt.started;
    options["out"] = (l: string) => swapped.push(l);
    options["err"] = (l: string) => swapped.push(l);
    prompt.resolve({ key: KEY_NAME, value: SECRET });
    await run;

    expect(captured.length).toBeGreaterThan(0);
    expect(swapped).toEqual([]);
  });
});
