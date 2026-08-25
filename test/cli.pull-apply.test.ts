import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXIT_BLOCKED,
  EXIT_OK,
  MIN_PREWRITE_LEASE_MS,
  runPull,
} from "../src/cli/commands.js";
import { promptForReplacement, type ReplacementAnswer } from "../src/cli/prompt.js";
import { MAX_CLAIM_LEASE_MS } from "../src/cli/secret-client.js";
import { buildDeliveryLink } from "../src/cli/link.js";
import { generateCapability } from "../src/cli/capability.js";
import type {
  ClaimOutcome,
  ConsumeOutcome,
  CreateOutcome,
  ReleaseOutcome,
  SecretClient,
} from "../src/cli/secret-client.js";
import { canonicalizeSupportedRemote } from "../src/repo/identity.js";
import type { RepoResolution } from "../src/repo/git.js";
import { encrypt, exportKey, generateKey, serializeEnvelope } from "../src/crypto/envelope.js";

// The whole `repobd pull` lifecycle, end to end, against a real filesystem and
// real crypto. Only the RepoBD service is a double — there is no network here
// and no production endpoint is contacted.
//
// What these tests are really about is ORDER. The service double records, at
// every lifecycle call, what `.env` looked like at that moment, so
// "claim before write" and "write before consume" are observations rather than
// readings of the source.

const SECRET = "TEST_ALPHA_123456";
const OTHER_SECRET = "TEST_BETA_987654";
const KEY_NAME = "API_KEY";
const REPO = "github.com/acme/alpha";
const ORIGIN = "https://repobd.example";

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "repobd-pull-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  return mkdtemp(path.join(root, "case-"));
}

const envPath = (dir: string): string => path.join(dir, ".env");
const readEnv = (dir: string): string => readFileSync(envPath(dir), "utf8");
const hasEnv = (dir: string): boolean => readdirSync(dir).includes(".env");

/** For the recorder only: some fixtures make .env deliberately unreadable. */
function peekEnv(dir: string): string | null {
  try {
    return readEnv(dir);
  } catch {
    return null;
  }
}

function canonical(identity: string) {
  const result = canonicalizeSupportedRemote(`https://${identity}.git`);
  if (!result.ok) {
    throw new Error(`fixture ${identity} did not canonicalize`);
  }
  return result.repo;
}

/** A resolver that answers for a fixture directory, with no Git involved. */
function resolverFor(dir: string, identity = REPO) {
  return async (): Promise<RepoResolution> => ({
    ok: true,
    repo: canonical(identity),
    root: dir,
  });
}

/** Builds a real delivery: a real envelope and a real link carrying its key. */
async function delivery(
  payload: string,
  boundTo = REPO,
): Promise<{ link: string; envelope: string; secretId: string; key: string }> {
  const cryptoKey = await generateKey();
  const envelope = serializeEnvelope(await encrypt(payload, cryptoKey));
  const key = await exportKey(cryptoKey);
  const secretId = generateCapability();
  const link = buildDeliveryLink({
    origin: ORIGIN,
    secretId,
    key,
    repo: canonical(boundTo),
  });
  return { link, envelope, secretId, key };
}

type Outcome = "ok" | "conflict" | "unreachable";

interface ServiceOptions {
  /**
   * What the server reports as remaining lease, per claim call, in order; the
   * last value repeats. This is the only lease figure the CLI may act on.
   */
  readonly leaseRemainingMs?: readonly number[];
  /** Per-call outcomes, consumed in order; the last one repeats. */
  readonly claim?: readonly Outcome[];
  readonly consume?: readonly Outcome[];
  readonly release?: readonly Outcome[];
}

interface Service {
  readonly client: (origin: string) => SecretClient;
  /** Every lifecycle call, with what `.env` looked like at that moment. */
  readonly log: {
    op: string;
    envExists: boolean;
    envContent: string | null;
  }[];
  readonly ops: () => string[];
  clients: number;
}

function service(
  dir: string,
  envelope: string,
  options: ServiceOptions = {},
): Service {
  const counts: Record<string, number> = { claim: 0, consume: 0, release: 0 };

  const leaseFor = (index: number): number => {
    const scripted = options.leaseRemainingMs;
    if (scripted === undefined || scripted.length === 0) {
      return 5 * 60_000;
    }
    return scripted[Math.min(index, scripted.length - 1)] as number;
  };

  const outcomeFor = (op: string): Outcome => {
    const scripted = (options as Record<string, readonly Outcome[] | undefined>)[op];
    if (scripted === undefined || scripted.length === 0) {
      return "ok";
    }
    const index = Math.min(counts[op] as number, scripted.length - 1);
    return scripted[index] as Outcome;
  };

  const record = (op: string): void => {
    state.log.push({
      op,
      envExists: hasEnv(dir),
      envContent: hasEnv(dir) ? peekEnv(dir) : null,
    });
  };

  const state: Service = {
    clients: 0,
    log: [],
    ops: () => state.log.map((entry) => entry.op),
    client: () => {
      state.clients += 1;
      return {
        async create(): Promise<CreateOutcome> {
          // `pull` never creates. Recorded like every other call, so a
          // regression appears in `ops()` rather than as a thrown error.
          record("create");
          return { ok: false, reason: "rejected" };
        },
        async claim(): Promise<ClaimOutcome> {
          record("claim");
          const outcome = outcomeFor("claim");
          const index = counts["claim"] as number;
          counts["claim"] = index + 1;
          if (outcome === "conflict") {
            return { ok: false, reason: "claim-conflict" };
          }
          if (outcome === "unreachable") {
            return { ok: false, reason: "unreachable" };
          }
          return {
            ok: true,
            envelope,
            // Deliberately a nonsense absolute timestamp: nothing in the CLI
            // may derive a decision from it, and a test that passes with this
            // value proves the local clock plays no part.
            claimExpiresAt: 0,
            leaseRemainingMs: leaseFor(index),
          };
        },
        async release(): Promise<ReleaseOutcome> {
          record("release");
          const outcome = outcomeFor("release");
          counts["release"] = (counts["release"] as number) + 1;
          return outcome === "ok"
            ? { ok: true }
            : { ok: false, reason: "unreachable" };
        },
        async consume(): Promise<ConsumeOutcome> {
          record("consume");
          const outcome = outcomeFor("consume");
          counts["consume"] = (counts["consume"] as number) + 1;
          if (outcome === "conflict") {
            return { ok: false, reason: "claim-conflict" };
          }
          if (outcome === "unreachable") {
            return { ok: false, reason: "unreachable" };
          }
          return { ok: true };
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
  svc: Service;
}

async function pull(
  dir: string,
  payload: string,
  options: {
    boundTo?: string;
    answer?: ReplacementAnswer;
    svc?: ServiceOptions;
    resolveRoot?: string;
    /** Runs between the confirmation and the rest of the flow. */
    afterAnswer?: () => void;
  } = {},
): Promise<RunResult> {
  const made = await delivery(payload, options.boundTo);
  const svc = service(dir, made.envelope, options.svc);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPull({
    readLink: async () => made.link,
    cwd: dir,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    resolveRepo: resolverFor(options.resolveRoot ?? dir),
    createClient: svc.client,
    confirmReplacement: async () => {
      const answer = options.answer ?? "no";
      options.afterAnswer?.();
      return answer;
    },
  });
  return { code, out, err, all: [...out, ...err].join("\n"), svc };
}

describe("happy path: create", () => {
  it("claims, writes, verifies, then consumes — in that order", async () => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`);

    expect(run.code).toBe(EXIT_OK);
    expect(run.svc.ops()).toEqual(["claim", "claim", "consume"]);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);

    // Order, observed rather than assumed: `.env` did not exist when the
    // delivery was claimed, and did exist when it was consumed.
    const claim = run.svc.log.find((e) => e.op === "claim");
    const consume = run.svc.log.find((e) => e.op === "consume");
    // The first claim is the fetch, the second is the pre-write ownership
    // gate; both precede the write, and the consume follows it.
    expect(claim?.envExists).toBe(false);
    expect(run.svc.log[1]?.envExists).toBe(false);
    expect(consume?.envExists).toBe(true);
    expect(consume?.envContent).toContain(`${KEY_NAME}=`);
    // Nothing was released on a successful run.
    expect(run.svc.ops()).not.toContain("release");
  });

  it("states the intended change before writing, and never the value", async () => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`);
    expect(run.out.join("\n")).toContain(`Repository verified: ${REPO}`);
    expect(run.out.join("\n")).toContain(`Will add ${KEY_NAME} to .env`);
    expect(run.out.join("\n")).toContain("Delivery consumed.");
    expect(run.all).not.toContain(SECRET);
  });

  it("appends to an existing file without disturbing it", async () => {
    const dir = await workspace();
    const before = `# header\nOTHER=${OTHER_SECRET}\n`;
    writeFileSync(envPath(dir), before);
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`);

    expect(run.code).toBe(EXIT_OK);
    expect(readEnv(dir)).toBe(`${before}${KEY_NAME}=${SECRET}\n`);
    expect(run.svc.ops()).toEqual(["claim", "claim", "consume"]);
  });
});

describe("wrong repository", () => {
  it("never reaches the network, never writes, never consumes", async () => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      boundTo: "github.com/acme/beta",
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.clients).toBe(0);
    expect(run.svc.ops()).toEqual([]);
    expect(hasEnv(dir)).toBe(false);
    expect(run.all).toContain("Repository mismatch");
    expect(run.all).not.toContain(SECRET);
  });
});

describe("failures before a write never consume", () => {
  it("refuses a payload that is not one KEY=value, and releases", async () => {
    const dir = await workspace();
    const run = await pull(dir, `A=1\nB=2`);

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.ops()).toEqual(["claim", "release"]);
    expect(hasEnv(dir)).toBe(false);
    expect(run.all).not.toContain(SECRET);
  });

  it("refuses an ambiguous .env, and releases", async () => {
    const dir = await workspace();
    // A compound line: outside the supported subset.
    const before = `OTHER=x ${KEY_NAME}=${OTHER_SECRET}\n`;
    writeFileSync(envPath(dir), before);
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`);

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.ops()).toEqual(["claim", "release"]);
    expect(readEnv(dir)).toBe(before);
    expect(run.all).not.toContain(SECRET);
    expect(run.all).not.toContain(OTHER_SECRET);
  });

  it("refuses a duplicate active key, and releases", async () => {
    const dir = await workspace();
    const before = `${KEY_NAME}=a\n${KEY_NAME}=b\n`;
    writeFileSync(envPath(dir), before);
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`);

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.ops()).toEqual(["claim", "release"]);
    expect(readEnv(dir)).toBe(before);
  });

  it("refuses a decryptable-looking but undecryptable delivery, and releases", async () => {
    const dir = await workspace();
    const made = await delivery(`${KEY_NAME}=${SECRET}`);
    // A different key's envelope: authentication fails.
    const other = await delivery(`${KEY_NAME}=${OTHER_SECRET}`);
    const svc = service(dir, other.envelope);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runPull({
      readLink: async () => made.link,
      cwd: dir,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      resolveRepo: resolverFor(dir),
      createClient: svc.client,
      confirmReplacement: async () => "no",
    });

    expect(code).toBe(EXIT_BLOCKED);
    expect(svc.ops()).toEqual(["claim", "release"]);
    expect(hasEnv(dir)).toBe(false);
    expect([...out, ...err].join("\n")).toContain("could not be decrypted");
  });
});

describe("same value already present", () => {
  it("writes nothing and still consumes, so a retry converges", async () => {
    const dir = await workspace();
    const before = `${KEY_NAME}=${SECRET}\n`;
    writeFileSync(envPath(dir), before);
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`);

    expect(run.code).toBe(EXIT_OK);
    expect(run.svc.ops()).toEqual(["claim", "claim", "consume"]);
    // Byte-identical: nothing was rewritten.
    expect(readEnv(dir)).toBe(before);
    expect(run.out.join("\n")).toContain("already present");
    expect(run.all).not.toContain(SECRET);
  });

  it("converges after a first run whose consume was lost", async () => {
    // The scenario that makes the no-op path a requirement rather than a
    // convenience: the write landed, consume did not confirm, and the user
    // runs it again.
    const dir = await workspace();
    const first = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { consume: ["unreachable"] },
    });
    expect(first.code).toBe(EXIT_BLOCKED);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);

    const second = await pull(dir, `${KEY_NAME}=${SECRET}`);
    expect(second.code).toBe(EXIT_OK);
    expect(second.svc.ops()).toEqual(["claim", "claim", "consume"]);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
  });
});

describe("replacing an existing different value", () => {
  const before = `OTHER=keep\n${KEY_NAME}=${OTHER_SECRET}\n`;

  it("asks with the key name only, then replaces and consumes", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), before);
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, { answer: "yes" });

    expect(run.code).toBe(EXIT_OK);
    expect(run.svc.ops()).toEqual(["claim", "claim", "consume"]);
    expect(readEnv(dir)).toBe(`OTHER=keep\n${KEY_NAME}=${SECRET}\n`);
    expect(run.out.join("\n")).toContain(
      `${KEY_NAME} already exists in .env with a different value`,
    );
    expect(run.all).not.toContain(SECRET);
    expect(run.all).not.toContain(OTHER_SECRET);
  });

  it("writes nothing when the answer is no", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), before);
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, { answer: "no" });

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.ops()).toEqual(["claim", "release"]);
    expect(readEnv(dir)).toBe(before);
    expect(run.all).toContain("Nothing was written");
    expect(run.all).not.toContain(SECRET);
  });

  it("refuses when there is no terminal to confirm at", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), before);
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      answer: "unavailable",
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.ops()).toEqual(["claim", "release"]);
    expect(readEnv(dir)).toBe(before);
    expect(run.all).toContain("terminal");
    expect(run.all).not.toContain(SECRET);
  });

  it("never asks for create, append or no-op", async () => {
    // If the prompt were consulted on these paths, this answer would refuse
    // them. It must not be reached at all.
    for (const seed of [null, `OTHER=x\n`, `${KEY_NAME}=${SECRET}\n`]) {
      const dir = await workspace();
      if (seed !== null) {
        writeFileSync(envPath(dir), seed);
      }
      const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
        answer: "unavailable",
      });
      expect(run.code).toBe(EXIT_OK);
      expect(run.svc.ops()).toEqual(["claim", "claim", "consume"]);
    }
  });
});

describe("the ownership gate before writing is answered by the server", () => {
  // Every run asks the server, immediately before touching the filesystem,
  // whether this token still holds the delivery and how much lease is left.
  // Nothing here consults a local clock — the service double even returns a
  // nonsense `claimExpiresAt` of 0, so a test that passes proves the CLI made
  // no use of it.

  it("always refreshes ownership with the same token before writing", async () => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`);

    expect(run.code).toBe(EXIT_OK);
    // Two claims even on the simplest run: the fetch, and the pre-write gate.
    expect(run.svc.ops()).toEqual(["claim", "claim", "consume"]);

    // The gate happened before anything was written, and the write before the
    // consume — all observed from what `.env` looked like at each call.
    const [fetchClaim, gateClaim, consume] = run.svc.log;
    expect(fetchClaim?.envExists).toBe(false);
    expect(gateClaim?.envExists).toBe(false);
    expect(consume?.envExists).toBe(true);
  });

  it("is unaffected by a local clock far from the server's", async () => {
    // The regression this pins: a lease decision derived from Date.now() minus
    // a server timestamp. The double reports a healthy remaining lease and an
    // absolute expiry of 0, which under the old comparison would have looked
    // long expired.
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { leaseRemainingMs: [5 * 60_000] },
    });

    expect(run.code).toBe(EXIT_OK);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
  });

  it("writes nothing when the server says the claim is not ours", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `OTHER=x\n`);
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { claim: ["ok", "conflict"] },
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    // No write, no consume — and no release, because this run cannot say who
    // holds the claim now.
    expect(run.svc.ops()).toEqual(["claim", "claim"]);
    expect(readEnv(dir)).toBe(`OTHER=x\n`);
    expect(run.all).not.toContain(SECRET);
  });

  it("writes nothing when ownership cannot be confirmed at all", async () => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { claim: ["ok", "unreachable"] },
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.ops()).toEqual(["claim", "claim"]);
    expect(hasEnv(dir)).toBe(false);
    // Unknown is not the same as lost, and the wording says only that.
    expect(run.all).toContain("could not confirm");
    expect(run.all).not.toContain(SECRET);
  });

  it("writes nothing when too little lease remains", async () => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      // The claim succeeds — it is ours — but the server says it is nearly
      // over, which is what a delivery close to its own expiry reports.
      svc: { leaseRemainingMs: [5 * 60_000, MIN_PREWRITE_LEASE_MS - 1] },
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.ops()).toEqual(["claim", "claim", "release"]);
    expect(hasEnv(dir)).toBe(false);
    expect(run.all).toContain("too close to expiry");
    expect(run.all).not.toContain(SECRET);
  });

  it("fails closed when the outcome carries no server-measured lease", async () => {
    // A malformed outcome must not slip past: `undefined < MIN` is false, so
    // the check is written as a positive requirement instead.
    const dir = await workspace();
    const made = await delivery(`${KEY_NAME}=${SECRET}`);
    let claims = 0;
    const out: string[] = [];
    const err: string[] = [];
    const code = await runPull({
      readLink: async () => made.link,
      cwd: dir,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      resolveRepo: resolverFor(dir),
      createClient: () => ({
        async create() {
          throw new Error("create must not be reached");
        },
        async claim() {
          claims += 1;
          return {
            ok: true,
            envelope: made.envelope,
            claimExpiresAt: 0,
            // Deliberately absent from the shape the CLI relies on.
            leaseRemainingMs: undefined as unknown as number,
          };
        },
        async release() {
          return { ok: true };
        },
        async consume() {
          throw new Error("consume must not be reached");
        },
      }),
      confirmReplacement: async () => "no",
    });

    expect(code).toBe(EXIT_BLOCKED);
    expect(claims).toBe(2);
    expect(hasEnv(dir)).toBe(false);
    expect([...out, ...err].join("\n")).not.toContain(SECRET);
  });

  it("writes when exactly the minimum lease remains", async () => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { leaseRemainingMs: [5 * 60_000, MIN_PREWRITE_LEASE_MS] },
    });

    expect(run.code).toBe(EXIT_OK);
    expect(run.svc.ops()).toEqual(["claim", "claim", "consume"]);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
  });

  it("gates after the confirmation, not before it", async () => {
    // The ordering that matters for a slow human: prompt, then ownership,
    // then write. A gate before the prompt would prove nothing about the
    // moment of the write.
    const dir = await workspace();
    writeFileSync(envPath(dir), `${KEY_NAME}=${OTHER_SECRET}\n`);
    const seenAtAnswer: string[] = [];
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      answer: "yes",
      afterAnswer: () => {
        seenAtAnswer.push(...[]);
      },
    });

    expect(run.code).toBe(EXIT_OK);
    expect(run.svc.ops()).toEqual(["claim", "claim", "consume"]);
    // The second claim saw the file still holding the old value: it ran after
    // the answer and before the write.
    expect(run.svc.log[1]?.envContent).toBe(`${KEY_NAME}=${OTHER_SECRET}\n`);
    expect(run.svc.log[2]?.envContent).toBe(`${KEY_NAME}=${SECRET}\n`);
  });
});

describe("a replacement approval is bound to what was inspected", () => {
  // The stale-approval race: a person is shown one `.env` and says yes, the
  // file changes, and the approval must not be spent on the new one.

  it("refuses when the target changed after the answer", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `${KEY_NAME}=BEFORE_PROMPT\n`);

    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      answer: "yes",
      afterAnswer: () => {
        // Someone else edits the file between the question and the write.
        writeFileSync(envPath(dir), `${KEY_NAME}=CHANGED_AFTER_YES\n`);
      },
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    // The incoming value was never written, and the newer content survives.
    expect(readEnv(dir)).toBe(`${KEY_NAME}=CHANGED_AFTER_YES\n`);
    expect(readEnv(dir)).not.toContain(SECRET);
    expect(run.svc.ops()).not.toContain("consume");
    expect(run.all).toContain("changed after");
    expect(run.all).not.toContain(SECRET);
  });

  it("does not re-prompt or silently reuse the approval", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `${KEY_NAME}=BEFORE_PROMPT\n`);
    let asked = 0;
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      answer: "yes",
      afterAnswer: () => {
        asked += 1;
        writeFileSync(envPath(dir), `${KEY_NAME}=CHANGED_AFTER_YES\n`);
      },
    });

    expect(asked).toBe(1);
    expect(run.code).toBe(EXIT_BLOCKED);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=CHANGED_AFTER_YES\n`);
  });

  it("replaces normally when the target did not change", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `OTHER=keep\n${KEY_NAME}=${OTHER_SECRET}\n`);
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, { answer: "yes" });

    expect(run.code).toBe(EXIT_OK);
    expect(readEnv(dir)).toBe(`OTHER=keep\n${KEY_NAME}=${SECRET}\n`);
    expect(run.svc.ops()).toEqual(["claim", "claim", "consume"]);
  });

  it("invalidates the approval on a metadata-only change", async () => {
    // Same bytes, different mode. The supported snapshot covers permissions,
    // so this is a different state and the approval no longer applies.
    const dir = await workspace();
    const before = `${KEY_NAME}=${OTHER_SECRET}\n`;
    writeFileSync(envPath(dir), before);
    chmodSync(envPath(dir), 0o600);

    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      answer: "yes",
      afterAnswer: () => {
        chmodSync(envPath(dir), 0o640);
      },
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(readEnv(dir)).toBe(before);
    expect(run.svc.ops()).not.toContain("consume");
    expect(run.all).not.toContain(SECRET);
    expect(run.all).not.toContain(OTHER_SECRET);
  });

  it("binds the absent-file case too", async () => {
    // Not a human-approval path, but the same binding: the file appeared
    // after it was inspected as missing.
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      answer: "yes",
      afterAnswer: () => undefined,
    });
    // No prompt on the create path, so this simply succeeds.
    expect(run.code).toBe(EXIT_OK);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
  });

  it("leaks nothing when the approval is invalidated", async () => {
    const dir = await workspace();
    writeFileSync(envPath(dir), `${KEY_NAME}=${OTHER_SECRET}\n`);
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      answer: "yes",
      afterAnswer: () => {
        writeFileSync(envPath(dir), `${KEY_NAME}=SOMETHING_ELSE\n`);
      },
    });
    expect(run.all).not.toContain(SECRET);
    expect(run.all).not.toContain(OTHER_SECRET);
    expect(run.all).not.toContain("SOMETHING_ELSE");
  });
});

describe("write and verification failures", () => {
  it("does not consume when the write fails", async () => {
    const dir = await workspace();
    chmodSync(dir, 0o500);
    let run: RunResult;
    try {
      run = await pull(dir, `${KEY_NAME}=${SECRET}`);
    } finally {
      chmodSync(dir, 0o700);
    }

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.ops()).toEqual(["claim", "claim", "release"]);
    expect(run.svc.ops()).not.toContain("consume");
    expect(hasEnv(dir)).toBe(false);
    expect(run.all).not.toContain(SECRET);
  });

  it("says .env may have changed when the read-back cannot confirm it", async () => {
    // A umask that strips the owner read bit makes the created file
    // write-only, so the write lands and the verification read cannot open it.
    const dir = await workspace();
    const previous = process.umask(0o477);
    let run: RunResult;
    try {
      run = await pull(dir, `${KEY_NAME}=${SECRET}`);
    } finally {
      process.umask(previous);
    }

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.ops()).toEqual(["claim", "claim", "release"]);
    expect(run.svc.ops()).not.toContain("consume");
    // The wording must not claim the key was not applied: RepoBD does not
    // know whether the write landed, only that it could not confirm it.
    expect(run.all).toContain("could not confirm that API_KEY was applied");
    expect(run.all).toContain("may have changed");
    expect(run.all).not.toContain("was not applied,");
    expect(run.all).not.toContain(SECRET);

    chmodSync(envPath(dir), 0o600);
    // No rollback: what was written is still there.
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
  });
});

describe("consume trouble after a verified write", () => {
  it("keeps the write, does not roll back, and says consumption is unconfirmed", async () => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { consume: ["unreachable"] },
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    // The write stands.
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
    // Applied is reported as applied; only consumption is in doubt.
    expect(run.out.join("\n")).toContain(`Applied ${KEY_NAME} to .env.`);
    expect(run.err.join("\n")).toContain("could not be marked as used");
    expect(run.out.join("\n")).not.toContain("Delivery consumed.");
    // Never released after a successful apply.
    expect(run.svc.ops()).not.toContain("release");
    expect(run.all).not.toContain(SECRET);
  });

  it("renews once and retries consume once when the lease lapsed", async () => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { consume: ["conflict", "ok"] },
    });

    expect(run.code).toBe(EXIT_OK);
    // claim, write, consume(conflict), claim(renew), consume(ok).
    expect(run.svc.ops()).toEqual([
      "claim",
      "claim",
      "consume",
      "claim",
      "consume",
    ]);
    // One write only: the file is unchanged between the two consume attempts.
    const consumes = run.svc.log.filter((e) => e.op === "consume");
    expect(consumes).toHaveLength(2);
    expect(consumes[0]?.envContent).toBe(consumes[1]?.envContent);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
  });

  it("gives up after one retry rather than looping", async () => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { consume: ["conflict"] },
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.ops()).toEqual([
      "claim",
      "claim",
      "consume",
      "claim",
      "consume",
    ]);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
  });
});

describe("the write gate rejects malformed lease evidence itself", () => {
  // Checked at the transport too, but this is the line that authorizes a
  // filesystem mutation and it must be sound on its own terms. The service
  // double bypasses the transport entirely, which is exactly how a value the
  // transport would have rejected reaches this gate in a test.

  it.each([
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["NaN", Number.NaN],
    ["a negative duration", -1],
    ["more than the protocol maximum", MAX_CLAIM_LEASE_MS + 1],
    ["zero", 0],
    ["just below the minimum", MIN_PREWRITE_LEASE_MS - 1],
  ])("refuses to write on %s", async (_label, lease) => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { leaseRemainingMs: [5 * 60_000, lease] },
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    // Never reached the filesystem, never consumed.
    expect(hasEnv(dir)).toBe(false);
    expect(run.svc.ops()).not.toContain("consume");
    expect(run.all).not.toContain(SECRET);
  });

  it.each([
    ["exactly the minimum", MIN_PREWRITE_LEASE_MS],
    ["an ordinary lease", 240_000],
    ["the protocol maximum", MAX_CLAIM_LEASE_MS],
  ])("writes on %s", async (_label, lease) => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { leaseRemainingMs: [5 * 60_000, lease] },
    });

    expect(run.code).toBe(EXIT_OK);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
    expect(run.svc.ops()).toEqual(["claim", "claim", "consume"]);
  });

  it("does not let Infinity authorize a replacement either", async () => {
    const dir = await workspace();
    const before = `${KEY_NAME}=${OTHER_SECRET}\n`;
    writeFileSync(envPath(dir), before);
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      answer: "yes",
      svc: { leaseRemainingMs: [5 * 60_000, Number.POSITIVE_INFINITY] },
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(readEnv(dir)).toBe(before);
    expect(run.svc.ops()).not.toContain("consume");
  });
});

describe("consume recovery is bounded and never rewrites .env", () => {
  it("retries a transport-ambiguous consume exactly once, directly", async () => {
    // `unreachable` cannot distinguish "never arrived" from "worked, response
    // lost". Consume is idempotent for the same token, so the safe move is to
    // ask again — and not to renew first, which would be a request made on a
    // guess about a lease nothing suggested was the problem.
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { consume: ["unreachable", "ok"] },
    });

    expect(run.code).toBe(EXIT_OK);
    // No claim between the two consumes.
    expect(run.svc.ops()).toEqual(["claim", "claim", "consume", "consume"]);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
  });

  it("stops after one direct retry when the transport stays unreachable", async () => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { consume: ["unreachable"] },
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.ops()).toEqual(["claim", "claim", "consume", "consume"]);
    // The apply stands and is reported as such; only consumption is in doubt.
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
    expect(run.out.join("\n")).toContain(`Applied ${KEY_NAME} to .env.`);
    expect(run.err.join("\n")).toContain("could not be marked as used");
  });

  it("does not renew on transport ambiguity", async () => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { consume: ["unreachable"] },
    });
    // Exactly two claims: the fetch and the pre-write gate. Neither consume
    // attempt was preceded by a third.
    expect(run.svc.ops().filter((op) => op === "claim")).toHaveLength(2);
  });

  it("renews once for an ownership conflict, then retries consume once", async () => {
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { consume: ["conflict", "ok"] },
    });

    expect(run.code).toBe(EXIT_OK);
    expect(run.svc.ops()).toEqual([
      "claim",
      "claim",
      "consume",
      "claim",
      "consume",
    ]);
  });

  it("does not chain the two recoveries", async () => {
    // A conflict, a renewal, then an unreachable retry: the run stops rather
    // than starting the transport recovery on top of the ownership one.
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      svc: { consume: ["conflict", "unreachable"] },
    });

    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.ops()).toEqual([
      "claim",
      "claim",
      "consume",
      "claim",
      "consume",
    ]);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
  });

  it("never writes .env twice during any consume recovery", async () => {
    for (const script of [
      ["unreachable", "ok"],
      ["unreachable"],
      ["conflict", "ok"],
      ["conflict", "unreachable"],
    ] as const) {
      const dir = await workspace();
      const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
        svc: { consume: script as unknown as readonly Outcome[] },
      });
      // Whatever the recovery path, the file holds exactly one assignment and
      // every consume attempt saw identical content.
      expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
      const seen = run.svc.log
        .filter((e) => e.op === "consume")
        .map((e) => e.envContent);
      expect(new Set(seen).size).toBe(1);
    }
  });
});

describe("caller options are captured before the first suspension", () => {
  // `readLink()` suspends for as long as a person takes to paste a link, and
  // anything reachable from the options object can change during that window.
  // These drive the exported `runPull` directly, with the link deliberately
  // held pending while the object is mutated underneath it.

  /** A link reader the test resolves by hand, so the window stays open. */
  function pendingLink(): {
    readLink: () => Promise<string>;
    resolve: (link: string) => void;
    started: Promise<void>;
  } {
    let release: (link: string) => void = () => undefined;
    let began: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      began = r;
    });
    const pending = new Promise<string>((r) => {
      release = r;
    });
    return {
      readLink: () => {
        began();
        return pending;
      },
      resolve: (link: string) => release(link),
      started,
    };
  }

  it("cannot be given a confirmation callback after it starts", async () => {
    // The reported case. The run begins with no `confirmReplacement`, so the
    // captured default is the real TTY prompt — which refuses under the test
    // runner. Adding an approving callback mid-flight must change nothing.
    const dir = await workspace();
    const before = `${KEY_NAME}=${OTHER_SECRET}\n`;
    writeFileSync(envPath(dir), before);

    const made = await delivery(`${KEY_NAME}=${SECRET}`);
    const service_ = service(dir, made.envelope);
    const link = pendingLink();
    const out: string[] = [];
    const err: string[] = [];

    const options: Record<string, unknown> = {
      readLink: link.readLink,
      cwd: dir,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      resolveRepo: resolverFor(dir),
      createClient: service_.client,
      // No confirmReplacement.
    };

    const run = runPull(options as never);
    await link.started;
    // Arrives while the paste is pending.
    options["confirmReplacement"] = async () => "yes";
    link.resolve(made.link);
    const code = await run;

    expect(code).toBe(EXIT_BLOCKED);
    // Not replaced, not consumed.
    expect(readEnv(dir)).toBe(before);
    expect(readEnv(dir)).not.toContain(SECRET);
    expect(service_.ops()).not.toContain("consume");
    expect([...out, ...err].join("\n")).not.toContain(SECRET);
  });

  it("keeps the callback it was given when one is swapped in mid-flight", async () => {
    // The inverse: an approving callback supplied at invocation must remain
    // the one used, even if the property is replaced with a refusing one.
    const dir = await workspace();
    writeFileSync(envPath(dir), `${KEY_NAME}=${OTHER_SECRET}\n`);

    const made = await delivery(`${KEY_NAME}=${SECRET}`);
    const service_ = service(dir, made.envelope);
    const link = pendingLink();

    const options: Record<string, unknown> = {
      readLink: link.readLink,
      cwd: dir,
      out: () => undefined,
      err: () => undefined,
      resolveRepo: resolverFor(dir),
      createClient: service_.client,
      confirmReplacement: async () => "yes",
    };

    const run = runPull(options as never);
    await link.started;
    options["confirmReplacement"] = async () => "no";
    link.resolve(made.link);
    const code = await run;

    // The captured callback approved, so the replacement happened.
    expect(code).toBe(EXIT_OK);
    expect(readEnv(dir)).toBe(`${KEY_NAME}=${SECRET}\n`);
  });

  it("cannot be redirected to another repository after it starts", async () => {
    // Swapping the resolver mid-flight must not change which repository the
    // binding is checked against, nor where the secret would land.
    const target = await workspace();
    const elsewhere = await workspace();

    const made = await delivery(`${KEY_NAME}=${SECRET}`);
    const service_ = service(target, made.envelope);
    const link = pendingLink();

    const options: Record<string, unknown> = {
      readLink: link.readLink,
      cwd: target,
      out: () => undefined,
      err: () => undefined,
      resolveRepo: resolverFor(target),
      createClient: service_.client,
      confirmReplacement: async () => "no",
    };

    const run = runPull(options as never);
    await link.started;
    options["resolveRepo"] = resolverFor(elsewhere, "github.com/acme/beta");
    options["cwd"] = elsewhere;
    link.resolve(made.link);
    const code = await run;

    expect(code).toBe(EXIT_OK);
    // Written where the run began, and nowhere else.
    expect(readEnv(target)).toBe(`${KEY_NAME}=${SECRET}\n`);
    expect(hasEnv(elsewhere)).toBe(false);
  });

  it("cannot be given a different network client after it starts", async () => {
    const dir = await workspace();
    const made = await delivery(`${KEY_NAME}=${SECRET}`);
    const captured = service(dir, made.envelope);
    const swapped = service(dir, made.envelope);
    const link = pendingLink();

    const options: Record<string, unknown> = {
      readLink: link.readLink,
      cwd: dir,
      out: () => undefined,
      err: () => undefined,
      resolveRepo: resolverFor(dir),
      createClient: captured.client,
      confirmReplacement: async () => "no",
    };

    const run = runPull(options as never);
    await link.started;
    options["createClient"] = swapped.client;
    link.resolve(made.link);
    await run;

    // The whole lifecycle went to the client captured at invocation.
    expect(captured.ops()).toEqual(["claim", "claim", "consume"]);
    expect(swapped.ops()).toEqual([]);
    expect(swapped.clients).toBe(0);
  });

  it("cannot have its output channels swapped after it starts", async () => {
    const dir = await workspace();
    const made = await delivery(`${KEY_NAME}=${SECRET}`);
    const service_ = service(dir, made.envelope);
    const link = pendingLink();
    const captured: string[] = [];
    const swapped: string[] = [];

    const options: Record<string, unknown> = {
      readLink: link.readLink,
      cwd: dir,
      out: (l: string) => captured.push(l),
      err: (l: string) => captured.push(l),
      resolveRepo: resolverFor(dir),
      createClient: service_.client,
      confirmReplacement: async () => "no",
    };

    const run = runPull(options as never);
    await link.started;
    options["out"] = (l: string) => swapped.push(l);
    options["err"] = (l: string) => swapped.push(l);
    link.resolve(made.link);
    await run;

    expect(captured.length).toBeGreaterThan(0);
    expect(swapped).toEqual([]);
  });

  it("still reaches no network at all when the repository does not match", async () => {
    // The Phase 3 invariant, re-checked here because this cycle moved the
    // client factory capture earlier: capturing a reference must not have
    // constructed anything.
    const dir = await workspace();
    const run = await pull(dir, `${KEY_NAME}=${SECRET}`, {
      boundTo: "github.com/acme/beta",
    });
    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.svc.clients).toBe(0);
    expect(run.svc.ops()).toEqual([]);
    expect(hasEnv(dir)).toBe(false);
  });
});

describe("nothing secret reaches an output channel", () => {
  const FRAGMENT_MARKER = "#k=";

  const LEAK_CASES: readonly [
    string,
    string | null,
    string,
    ServiceOptions,
    ReplacementAnswer,
  ][] = [
    ["success", null, `${KEY_NAME}=${SECRET}`, {}, "yes"],
    ["invalid payload", null, `A=1\nB=2`, {}, "yes"],
    ["ambiguous file", `OTHER=x ${KEY_NAME}=${OTHER_SECRET}\n`, `${KEY_NAME}=${SECRET}`, {}, "yes"],
    ["cancellation", `${KEY_NAME}=${OTHER_SECRET}\n`, `${KEY_NAME}=${SECRET}`, {}, "no"],
    ["consume failure", null, `${KEY_NAME}=${SECRET}`, { consume: ["unreachable"] }, "yes"],
    ["ownership lost", null, `${KEY_NAME}=${SECRET}`, { claim: ["ok", "conflict"] }, "yes"],
  ];

  it.each(LEAK_CASES)("keeps the secret out of output on %s", async (_label, seed, payload, svc, answer) => {
    const dir = await workspace();
    if (seed !== null) {
      writeFileSync(envPath(dir), seed);
    }
    const run = await pull(dir, payload, { svc, answer });

    expect(run.all).not.toContain(SECRET);
    expect(run.all).not.toContain(OTHER_SECRET);
    // Nor the delivery's own material.
    expect(run.all).not.toContain(FRAGMENT_MARKER);
    expect(run.all).not.toContain('"alg"');
    expect(run.all).not.toContain("A256GCM");
  });

  it("keeps the link, its key and the envelope out of output on success", async () => {
    const dir = await workspace();
    const made = await delivery(`${KEY_NAME}=${SECRET}`);
    const svc = service(dir, made.envelope);
    const out: string[] = [];
    const err: string[] = [];
    await runPull({
      readLink: async () => made.link,
      cwd: dir,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      resolveRepo: resolverFor(dir),
      createClient: svc.client,
      confirmReplacement: async () => "no",
    });
    const all = [...out, ...err].join("\n");
    expect(all).not.toContain(made.link);
    expect(all).not.toContain(made.key);
    expect(all).not.toContain(made.envelope);
    expect(all).not.toContain(made.secretId);
    expect(all).not.toContain(SECRET);
  });
});

describe("the replacement prompt cannot be answered by a pipe", () => {
  it("reports unavailable rather than reading stdin when there is no TTY", async () => {
    // Under the test runner stdin is not a terminal, which is exactly the
    // shape of a piped invocation: the link already came down that channel,
    // and a second line must never be taken as approval.
    expect(process.stdin.isTTY).not.toBe(true);
    await expect(promptForReplacement(KEY_NAME)).resolves.toBe("unavailable");
  });
});
