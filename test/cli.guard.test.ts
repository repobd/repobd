import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toBase64Url } from "../src/crypto/envelope-format.js";
import { validateCanonicalRepoIdentity } from "../src/repo/identity.js";
import { buildDeliveryLink, parseDeliveryLink } from "../src/cli/link.js";
import {
  runPull,
  runSend,
  hasUnexpectedPullOperand,
  EXIT_BLOCKED,
  EXIT_OK,
} from "../src/cli/commands.js";
import {
  SERVER_ORIGIN_ENV,
  createHttpSecretClient,
  type SecretClient,
} from "../src/cli/secret-client.js";

// Phase 3C adversarial tests: the guard must decide before anything reaches a
// network client.
//
// The network is never real here. Every case injects a client factory that
// counts, so "no network happened" is asserted as an observed count rather
// than inferred from the order of statements in the source. Repositories are
// throwaway fixtures created in a temporary directory; none is ever fetched,
// cloned from a real host, or pushed.

const ISOLATION = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
} as const;

const savedEnv: Record<string, string | undefined> = {};
let root: string;

beforeAll(() => {
  for (const [key, value] of Object.entries(ISOLATION)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  root = mkdtempSync(path.join(tmpdir(), "repobd-cli-"));
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A repository with one empty commit and, optionally, an `origin`. */
async function makeRepo(...originUrls: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(root, "case-"));
  git(dir, "init", "-q", "-b", "main", ".");
  git(dir, "config", "user.name", "RepoBD Test");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  for (const [index, url] of originUrls.entries()) {
    if (index === 0) {
      git(dir, "remote", "add", "origin", url);
    } else {
      git(dir, "config", "--add", "remote.origin.url", url);
    }
  }
  return dir;
}

const ORIGIN = "https://repobd.example";
const SECRET_ID = toBase64Url(new Uint8Array(16).fill(7));
const KEY = toBase64Url(new Uint8Array(32).fill(9));

function canonical(value: string) {
  const result = validateCanonicalRepoIdentity(value);
  if (!result.ok) {
    throw new Error(`fixture is not canonical: ${value}`);
  }
  return result.repo;
}

/** A well-formed link bound to `repoIdentity`. */
function linkFor(repoIdentity: string): string {
  return buildDeliveryLink({
    origin: ORIGIN,
    secretId: SECRET_ID,
    key: KEY,
    repo: canonical(repoIdentity),
  });
}

interface Spy {
  /** How many times a client was even constructed. */
  clients: number;
  /** Every network method invocation, in order. */
  calls: { method: string; secretId: string; claimToken: string }[];
  createClient: (origin: string) => SecretClient;
  origins: string[];
}

function spy(): Spy {
  const state: Spy = {
    clients: 0,
    calls: [],
    origins: [],
    createClient: (origin: string) => {
      state.clients += 1;
      state.origins.push(origin);
      return {
        async create() {
          // `pull` never creates a delivery. Recorded rather than thrown so a
          // regression shows up as an unexpected call in `calls`, alongside
          // every other one.
          state.calls.push({ method: "create", secretId: "", claimToken: "" });
          return { ok: false, reason: "rejected" };
        },
        async claim(secretId, claimToken) {
          state.calls.push({ method: "claim", secretId, claimToken });
          return {
            ok: true,
            envelope: "opaque",
            claimExpiresAt: 1,
            leaseRemainingMs: 5 * 60_000,
          };
        },
        async release(secretId, claimToken) {
          state.calls.push({ method: "release", secretId, claimToken });
          return { ok: true };
        },
        async consume(secretId, claimToken) {
          state.calls.push({ method: "consume", secretId, claimToken });
          return { ok: true };
        },
      };
    },
  };
  return state;
}

interface Run {
  code: number;
  out: string[];
  err: string[];
  network: Spy;
}

async function pull(link: string, cwd: string): Promise<Run> {
  const network = spy();
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPull({
    readLink: async () => link,
    cwd,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    createClient: network.createClient,
  });
  return { code, out, err, network };
}

/** The assertion that carries Phase 3's guarantee. */
function expectNoNetwork(run: Run): void {
  expect(run.network.clients).toBe(0);
  expect(run.network.calls).toEqual([]);
  expect(run.code).toBe(EXIT_BLOCKED);
}

describe("exact match is the only path to the network", () => {
  it("reaches the network only after an exact match, and never consumes", async () => {
    // This file is about the guard, so the fixture's envelope is deliberately
    // not decryptable: the run gets as far as claim, fails to decrypt, and
    // hands the claim back. What matters here is that the network was reached
    // at all, that it was reached at the right address, and that a delivery is
    // never consumed on a path that did not apply anything. The full apply
    // lifecycle is exercised in cli.pull-apply.test.ts.
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const run = await pull(linkFor("github.com/acme/alpha"), dir);

    expect(run.network.clients).toBe(1);
    expect(run.network.calls.map((c) => c.method)).toEqual(["claim", "release"]);
    expect(run.network.calls.map((c) => c.method)).not.toContain("consume");
    expect(run.network.origins).toEqual([ORIGIN]);
    expect(run.out.join("\n")).toContain("Repository verified: github.com/acme/alpha");
    expect(run.code).toBe(EXIT_BLOCKED);
  });

  it("matches the SSH spelling of the same hosted repository", async () => {
    const dir = await makeRepo("git@github.com:acme/alpha.git");
    const run = await pull(linkFor("github.com/acme/alpha"), dir);
    // The subject is that the match let the run reach the network at all.
    expect(run.network.calls.map((c) => c.method)).toEqual(["claim", "release"]);
  });

  it("never consumes: the claim is released, not consumed", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const run = await pull(linkFor("github.com/acme/alpha"), dir);
    expect(run.network.calls.map((c) => c.method)).not.toContain("consume");
    expect(run.network.calls.at(-1)?.method).toBe("release");
  });
});

describe("wrong repository blocks before any network access", () => {
  it("blocks a different repository", async () => {
    const dir = await makeRepo("https://github.com/acme/beta.git");
    const run = await pull(linkFor("github.com/acme/alpha"), dir);

    expectNoNetwork(run);
    expect(run.err[0]).toBe("Repository mismatch. Secret was not retrieved.");
    expect(run.err.join("\n")).toContain("github.com/acme/alpha");
    expect(run.err.join("\n")).toContain("github.com/acme/beta");
  });

  it("blocks a different owner on the same host", async () => {
    const dir = await makeRepo("https://github.com/other/alpha.git");
    const run = await pull(linkFor("github.com/acme/alpha"), dir);
    expectNoNetwork(run);
  });

  it("blocks the same path on a different supported host", async () => {
    const dir = await makeRepo("https://gitlab.com/acme/alpha.git");
    const run = await pull(linkFor("github.com/acme/alpha"), dir);
    expectNoNetwork(run);
  });

  it("blocks a case-only difference and says so", async () => {
    const dir = await makeRepo("https://github.com/acme/Alpha.git");
    const run = await pull(linkFor("github.com/acme/alpha"), dir);

    expectNoNetwork(run);
    expect(run.err[0]).toBe("Repository mismatch. Secret was not retrieved.");
    expect(run.err.join("\n")).toContain("differ only by letter case");
  });
});

describe("unresolvable local repository blocks before any network access", () => {
  it("blocks a self-hosted origin", async () => {
    const dir = await makeRepo("git@git.internal.example.com:acme/alpha.git");
    const run = await pull(linkFor("github.com/acme/alpha"), dir);

    expectNoNetwork(run);
    expect(run.err).toEqual([
      "This repository setup is not supported by RepoBD v0.1.",
    ]);
  });

  it("blocks an origin on a non-default port", async () => {
    const dir = await makeRepo("https://github.com:8443/acme/alpha.git");
    const run = await pull(linkFor("github.com/acme/alpha"), dir);
    expectNoNetwork(run);
    expect(run.err).toEqual([
      "This repository setup is not supported by RepoBD v0.1.",
    ]);
  });

  it("blocks a repository with no origin", async () => {
    const dir = await makeRepo();
    const run = await pull(linkFor("github.com/acme/alpha"), dir);

    expectNoNetwork(run);
    expect(run.err).toEqual(["No supported origin repository was found."]);
  });

  it("blocks an origin with more than one configured URL", async () => {
    const dir = await makeRepo(
      "https://github.com/acme/alpha.git",
      "https://github.com/acme/beta.git",
    );
    const run = await pull(linkFor("github.com/acme/alpha"), dir);

    expectNoNetwork(run);
    expect(run.err).toEqual([
      "This repository setup is not supported by RepoBD v0.1.",
    ]);
  });

  it("does not report an unresolvable repository as a mismatch", async () => {
    const dir = await makeRepo();
    const run = await pull(linkFor("github.com/acme/alpha"), dir);
    expect(run.err.join("\n")).not.toContain("mismatch");
  });
});

describe("unreadable delivery link blocks before any network access", () => {
  const alpha = "github.com/acme/alpha";

  it("blocks a malformed link", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const run = await pull("not a link", dir);
    expectNoNetwork(run);
    expect(run.err).toEqual(["Invalid RepoBD delivery link."]);
  });

  it("blocks a missing binding rather than falling back to unbound", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const run = await pull(`${ORIGIN}/d/${SECRET_ID}#k=${KEY}`, dir);
    expectNoNetwork(run);
    expect(run.err).toEqual(["Invalid RepoBD delivery link."]);
  });

  it("blocks a malformed binding rather than ignoring it", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const run = await pull(
      `${ORIGIN}/d/${SECRET_ID}#k=${KEY}&b=${encodeURIComponent("{ nope")}`,
      dir,
    );
    expectNoNetwork(run);
    expect(run.err).toEqual(["Invalid RepoBD delivery link."]);
  });

  it("blocks an unknown binding version", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const run = await pull(
      `${ORIGIN}/d/${SECRET_ID}#k=${KEY}&b=${encodeURIComponent(
        `{"bv":2,"repo":"${alpha}"}`,
      )}`,
      dir,
    );
    expectNoNetwork(run);
    expect(run.err).toEqual([
      "This delivery link needs a newer version of RepoBD.",
    ]);
  });

  it("blocks a duplicated fragment field", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const binding = encodeURIComponent(`{"bv":1,"repo":"${alpha}"}`);
    for (const fragment of [
      `k=${KEY}&k=${KEY}&b=${binding}`,
      `k=${KEY}&b=${binding}&b=${encodeURIComponent(
        '{"bv":1,"repo":"github.com/acme/beta"}',
      )}`,
    ]) {
      const run = await pull(`${ORIGIN}/d/${SECRET_ID}#${fragment}`, dir);
      expectNoNetwork(run);
      expect(run.err).toEqual(["Invalid RepoBD delivery link."]);
    }
  });

  it("blocks an unknown fragment field", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const run = await pull(
      `${ORIGIN}/d/${SECRET_ID}#k=${KEY}&b=${encodeURIComponent(
        `{"bv":1,"repo":"${alpha}"}`,
      )}&x=ignored`,
      dir,
    );
    expectNoNetwork(run);
    expect(run.err).toEqual(["Invalid RepoBD delivery link."]);
  });

  it("blocks a secret id that is not a canonical capability", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const binding = encodeURIComponent(`{"bv":1,"repo":"${alpha}"}`);
    for (const id of ["abcdefghijklmnop", SECRET_ID.slice(0, 21), `${SECRET_ID}A`]) {
      const run = await pull(`${ORIGIN}/d/${id}#k=${KEY}&b=${binding}`, dir);
      expectNoNetwork(run);
      expect(run.err).toEqual(["Invalid RepoBD delivery link."]);
    }
  });

  it("blocks a link whose binding names an unsupported host", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const run = await pull(
      `${ORIGIN}/d/${SECRET_ID}#k=${KEY}&b=${encodeURIComponent(
        '{"bv":1,"repo":"git.internal.example.com/acme/alpha"}',
      )}`,
      dir,
    );
    expectNoNetwork(run);
    expect(run.err).toEqual(["Invalid RepoBD delivery link."]);
  });
});

describe("fragment tampering follows the modified binding, and is not authenticated", () => {
  // RepoBD makes no cryptographic tamper claim about the fragment. Whoever
  // holds the link can rewrite the binding, and already holds the decryption
  // key. What these two cases record is that the guard obeys whatever binding
  // it is given, exactly — it never guesses at an "original" one.

  it("blocks when the binding is rewritten to a repository this is not", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const run = await pull(linkFor("github.com/acme/beta"), dir);
    expectNoNetwork(run);
  });

  it("proceeds when the binding is rewritten to this repository", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    // The guardrail is defeated by an intentional edit. This is documented
    // behavior, not a defect: see docs/THREAT_MODEL.md.
    const run = await pull(linkFor("github.com/acme/alpha"), dir);
    // It proceeds past the guard, which is the documented consequence.
    expect(run.network.calls.map((c) => c.method)[0]).toBe("claim");
  });
});

describe("the server never learns repository identity", () => {
  it("sends only a claim token, on a URL carrying only the secret id", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const requests: { url: string; body: string }[] = [];

    const code = await runPull({
      readLink: async () => linkFor("github.com/acme/alpha"),
      cwd: dir,
      out: () => {},
      err: () => {},
      createClient: (origin) =>
        createHttpSecretClient(origin, async (input, init) => {
          requests.push({
            url: String(input),
            body: String((init as { body?: unknown } | undefined)?.body ?? ""),
          });
          const claim = String(input).endsWith("/claim");
          return new Response(
            claim
              ? JSON.stringify({
                  envelope: "opaque",
                  claim_expires_at: 1,
                  lease_remaining_ms: 5 * 60_000,
                })
              : null,
            {
              status: claim ? 200 : 204,
              headers: claim ? { "content-type": "application/json" } : {},
            },
          );
        }),
    });

    // Two requests were made, which is what puts them under test below.
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      // No repository identity, in any spelling. Checked against the URL,
      // which is fully deterministic; the body is checked structurally below
      // instead, so no assertion here depends on the content of a random
      // token.
      expect(request.url).not.toContain("github.com");
      expect(request.url).not.toContain("acme");
      expect(request.url).not.toContain("alpha");
      expect(request.url).not.toContain(KEY);
      // The body is exactly one claim token and nothing else — asserted
      // structurally rather than by substring, because a random base64url
      // token can legitimately contain any short substring (it has been
      // observed to contain "bv"). The key set is what proves no binding,
      // repository, or version field rides along.
      const body = JSON.parse(request.body) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["claim_id"]);
      expect(typeof body["claim_id"]).toBe("string");
    }
    expect(requests[0]?.url).toBe(
      `${ORIGIN}/api/secrets/${SECRET_ID}/claim`,
    );
    expect(requests[1]?.url).toBe(
      `${ORIGIN}/api/secrets/${SECRET_ID}/release`,
    );
  });
});

describe("nothing sensitive reaches output", () => {
  it("never prints the key or the fragment, on any path", async () => {
    const fixtures = [
      await makeRepo("https://github.com/acme/alpha.git"),
      await makeRepo("https://github.com/acme/beta.git"),
      await makeRepo("git@git.internal.example.com:acme/alpha.git"),
      await makeRepo(),
    ];
    for (const dir of fixtures) {
      const run = await pull(linkFor("github.com/acme/alpha"), dir);
      const printed = [...run.out, ...run.err].join("\n");
      expect(printed).not.toContain(KEY);
      expect(printed).not.toContain(SECRET_ID);
      expect(printed).not.toContain("#");
      expect(printed).not.toContain("k=");
      expect(printed).not.toContain("b=");
    }
  });

  it("never echoes a credential-bearing origin URL", async () => {
    const dir = await makeRepo(
      "https://carol:ghp_supersecrettoken@github.com/acme/alpha.git",
    );
    const run = await pull(linkFor("github.com/acme/alpha"), dir);

    expectNoNetwork(run);
    const printed = [...run.out, ...run.err].join("\n");
    expect(printed).not.toContain("ghp_supersecrettoken");
    expect(printed).not.toContain("carol");
    expect(printed).toBe("This repository setup is not supported by RepoBD v0.1.");
  });
});

describe("the delivery link never travels in argv", () => {
  it("reads the link from the injected reader, not an argument", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    let reads = 0;
    const network = spy();
    const code = await runPull({
      readLink: async () => {
        reads += 1;
        return linkFor("github.com/acme/alpha");
      },
      cwd: dir,
      out: () => {},
      err: () => {},
      createClient: network.createClient,
    });
    expect(reads).toBe(1);
    expect(network.calls).toHaveLength(2);
  });

  it("blocks an empty line the way it blocks any unreadable link", async () => {
    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const run = await pull("", dir);
    expectNoNetwork(run);
    expect(run.err).toEqual(["Invalid RepoBD delivery link."]);
  });

  it("reads a link piped on stdin and never echoes it back", async () => {
    // Bound to alpha, run from beta: the guard blocks locally, so this
    // exercises the real prompt path without reaching a network.
    const dir = await makeRepo("https://github.com/acme/beta.git");
    const result = spawnSync(
      "npx",
      ["tsx", path.resolve(import.meta.dirname, "../src/cli/index.ts"), "pull"],
      {
        cwd: dir,
        input: `${linkFor("github.com/acme/alpha")}\n`,
        encoding: "utf8",
        env: { ...process.env, ...ISOLATION },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Paste RepoBD link:");
    expect(result.stderr).toContain("Repository mismatch. Secret was not retrieved.");
    // The link itself came back out nowhere.
    const printed = `${result.stdout}${result.stderr}`;
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain(SECRET_ID);
    expect(printed).not.toContain("https://repobd.example");
  });

  it("rejects a link passed as an argument without echoing any of it", async () => {
    // Sentinels, so a leak of any part of the link is unmistakable. The
    // argument parser's own excess-argument diagnostic would quote the whole
    // string, so this must be refused before parsing.
    const SENTINEL_ID = "SENTINELsecretIDvalue";
    const SENTINEL_KEY = "SENTINELdecryptionKEYvalue";
    const SENTINEL_REPO = "github.com/sentinelowner/sentinelrepo";
    const sentinelLink = `https://repobd.example/d/${SENTINEL_ID}#k=${SENTINEL_KEY}&b=${encodeURIComponent(
      `{"bv":1,"repo":"${SENTINEL_REPO}"}`,
    )}`;

    const dir = await makeRepo("https://github.com/acme/alpha.git");
    const result = spawnSync(
      "npx",
      [
        "tsx",
        path.resolve(import.meta.dirname, "../src/cli/index.ts"),
        "pull",
        sentinelLink,
      ],
      { cwd: dir, encoding: "utf8", env: { ...process.env, ...ISOLATION } },
    );

    expect(result.status).toBe(1);
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toContain(sentinelLink);
      expect(stream).not.toContain(SENTINEL_ID);
      expect(stream).not.toContain(SENTINEL_KEY);
      expect(stream).not.toContain(SENTINEL_REPO);
      expect(stream).not.toContain("sentinelowner");
      expect(stream).not.toContain("bv");
      expect(stream).not.toContain("repobd.example");
      expect(stream).not.toContain("#");
    }
    expect(result.stderr.trim()).toBe(
      "repobd pull does not accept a link argument. Run repobd pull and paste the link when prompted.",
    );
    expect(result.stdout).toBe("");
  });

  it("recognizes an unexpected operand without reading its value", () => {
    expect(hasUnexpectedPullOperand(["pull", "https://example/x#k=1"])).toBe(true);
    expect(hasUnexpectedPullOperand(["pull", "anything"])).toBe(true);
    // Options still reach the parser, so --help keeps working.
    expect(hasUnexpectedPullOperand(["pull"])).toBe(false);
    expect(hasUnexpectedPullOperand(["pull", "--help"])).toBe(false);
    expect(hasUnexpectedPullOperand(["pull", "-h"])).toBe(false);
    // A `--` separator does not smuggle an operand past the check.
    expect(hasUnexpectedPullOperand(["pull", "--", "https://example/x"])).toBe(true);
    // Other commands are untouched.
    expect(hasUnexpectedPullOperand(["send"])).toBe(false);
    expect(hasUnexpectedPullOperand([])).toBe(false);
  });

  it("still shows pull help, and the zero-argument flow is unaffected", async () => {
    const help = execFileSync(
      "npx",
      [
        "tsx",
        path.resolve(import.meta.dirname, "../src/cli/index.ts"),
        "pull",
        "--help",
      ],
      { encoding: "utf8" },
    );
    expect(help).toContain("prompts for the delivery link");
  });

  it("does not expose the link as a command-line argument", async () => {
    // `pull` takes no operand: commander rejects one rather than accepting a
    // secret-bearing link into argv, shell history, and process listings.
    const help = execFileSync(
      "npx",
      ["tsx", path.resolve(import.meta.dirname, "../src/cli/index.ts"), "pull", "--help"],
      { encoding: "utf8" },
    );
    expect(help).toContain("pull");
    expect(help).not.toContain("<link>");
    expect(help).not.toContain("[link]");
  });
});

describe("the guard mutates nothing", () => {
  it("leaves the repository and its configuration untouched", async () => {
    const dir = await makeRepo("https://github.com/acme/beta.git");
    const before = {
      status: git(dir, "status", "--porcelain"),
      config: git(dir, "config", "--local", "--list"),
      head: git(dir, "rev-parse", "HEAD"),
    };

    await pull(linkFor("github.com/acme/alpha"), dir);
    await pull(linkFor("github.com/acme/beta"), dir);

    expect({
      status: git(dir, "status", "--porcelain"),
      config: git(dir, "config", "--local", "--list"),
      head: git(dir, "rev-parse", "HEAD"),
    }).toEqual(before);
  });
});

describe("send binds to the sender's own repository", () => {
  async function send(cwd: string) {
    const out: string[] = [];
    const err: string[] = [];
    // The secret and the service are doubles; the repository is a real one,
    // which is what this file is about.
    let asked = 0;
    // A hosted-style https origin, pinned for the duration of the call so this
    // file does not depend on whatever the ambient environment names.
    const previousOrigin = process.env[SERVER_ORIGIN_ENV];
    process.env[SERVER_ORIGIN_ENV] = ORIGIN;
    try {
      const code = await runSend({
        readSecret: async () => {
          asked += 1;
          return { key: "API_KEY", value: "TEST_GUARD_VALUE" };
        },
        cwd,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        createClient: () => ({
          async create() {
            return { ok: true, id: SECRET_ID };
          },
          async claim() {
            throw new Error("send must not claim");
          },
          async release() {
            throw new Error("send must not release");
          },
          async consume() {
            throw new Error("send must not consume");
          },
        }),
      });
      return { code, out, err, asked };
    } finally {
      if (previousOrigin === undefined) {
        delete process.env[SERVER_ORIGIN_ENV];
      } else {
        process.env[SERVER_ORIGIN_ENV] = previousOrigin;
      }
    }
  }

  it("reports the repository a link would be bound to", async () => {
    const dir = await makeRepo("git@github.com:acme/alpha.git");
    const result = await send(dir);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out.join("\n")).toContain("github.com/acme/alpha");
    // The link is bound to the repository just resolved from real Git.
    const link = result.out.at(-1) as string;
    const parsed = parseDeliveryLink(link);
    expect(parsed.ok && parsed.link.repo.canonical).toBe("github.com/acme/alpha");
  });

  it("never asks for a secret it could not deliver", async () => {
    const dir = await makeRepo("git@git.internal.example.com:acme/alpha.git");
    const result = await send(dir);
    expect(result.code).toBe(EXIT_BLOCKED);
    expect(result.asked).toBe(0);
  });

  it("produces no link when the sender's repository is unsupported", async () => {
    const dir = await makeRepo("git@git.internal.example.com:acme/alpha.git");
    const result = await send(dir);
    expect(result.code).toBe(EXIT_BLOCKED);
    expect(result.err).toEqual([
      "This repository setup is not supported by RepoBD v0.1.",
      "No delivery link was created.",
    ]);
  });

  it("produces no link when there is no origin", async () => {
    const dir = await makeRepo();
    const result = await send(dir);
    expect(result.code).toBe(EXIT_BLOCKED);
    expect(result.err[0]).toBe("No supported origin repository was found.");
  });
});
