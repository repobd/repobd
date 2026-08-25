# RepoBD Handover

## Current state

Phases 0 through 5A are complete and committed. `repobd pull` and `repobd
send` together run a local send → pull round trip. Phase 5B — production
integration and a real end-to-end run — is in progress.

- branch: `main`
- current committed HEAD: `7dbebba98b68a9b7df1ffa371e7e8bd7fe267aa3`
- commit: `feat: complete CLI sender flow`
- Phase 5B: in progress. Phase 5B-1 (rate-limit enforcement and non-
  executable production D1 shape) is implemented, pending Codex Review A
  and Human Gate A. No Cloudflare resource has been created.

Repository:
- GitHub: `repobd/repobd` (private during MVP development)
- Local path: `/Users/shinya/Desktop/repobd`
- Domain: `repobd.com`
- npm account: `repobd`
- Email aliases: `hello@repobd.com`, `support@repobd.com`, `security@repobd.com`, `abuse@repobd.com`

No production Cloudflare resources exist. Nothing is deployed. Nothing is
published to npm. The repository is still private.

## Product direction

RepoBD is a CLI-first developer security tool: secret transport plus a
repository context guardrail. Its purpose is to apply a secret only in the
intended repository context.

- **Secrets should travel with context.**
- **Wrong repo. No secret.**
- RepoBD is not a Secret Manager, a file transfer service, a dotenv editor, or
  an arbitrary filesystem writer.
- AI parallel development weakens an old assumption: human visual and context
  checks no longer scale with the number of repos, terminals, agents and
  environments. RepoBD also serves human-to-human handoff; AI accelerates the
  problem rather than being the only case.

## Confirmed v0.1 boundaries

These are settled. They are the current contract, not open questions.

- **Payload.** One delivery carries exactly one `KEY=value`. Several
  assignments fail closed. Not a dotenv document, not an arbitrary text bundle.
- **Target.** `.env` at the verified Git work tree root, and nowhere else. No
  `.env.local`, `.env.production`, `.env.development`, `.env.preview`,
  `.env.staging`, relative path, absolute path, or caller-selected file.
- **`.env` handling.** RepoBD implements no general dotenv parser. It modifies
  an existing file only when it can confidently read the one ordinary
  single-line assignment it needs. Duplicate active target, multiline value,
  loader-dependent syntax, same-line compound syntax and exotic whitespace in a
  syntactic position all fail closed: no write, no consume. Commented
  historical entries are left untouched. RepoBD does not guess.
- **Shell.** RepoBD writes dotenv-style assignments. It does not guarantee
  equivalent behaviour when a `.env` file is executed as shell code, including
  `source .env`. Shell-source compatibility is outside v0.1.
- **Crypto.** Client-side AES-256-GCM. The server never receives plaintext or
  the decryption key, and never decrypts.
- **Repository binding.** Identity comes from the `origin` remote, canonical as
  `<lowercase-host>/<case-preserved-path>`, on github.com, gitlab.com or
  bitbucket.org. Comparison is exact and case-sensitive. Branch is not part of
  the binding. The binding travels only in the delivery link fragment; the
  server never receives repository identity.
- **One-time semantics and TTL** are enforced by the Worker.
- **No commit, push, deploy, package install, or arbitrary command execution**
  from RepoBD.
- **Abuse controls** rely on Cloudflare rate limiting, TTL and traffic
  metadata, never on plaintext inspection.

## Implemented send lifecycle

```text
service origin resolved and validated
→ local repository resolved
→ KEY prompted on stdin, then the value, as two separate lines
→ validate exactly one KEY=value (the Phase 4 grammar, unchanged)
→ fresh key, local encryption
→ create (ciphertext envelope + fixed 900s TTL, nothing else)
→ print one delivery link
```

Properties this ordering carries:

- **Nothing typed against a broken configuration** — a `REPOBD_SERVER_URL` that
  is not a usable origin, and an unresolvable repository, both stop before the
  prompt and before any network call.
- **No secret in argv** — `KEY` and the value are read from stdin. The value is
  plain and unmasked in v0.1; masking is not what invariant 21 is about.
- **Nothing created that could not be applied** — the sender validates against
  the same grammar the receiver re-applies after decrypting, and the 64 KiB
  bound is enforced by the crypto layer, both before the network.
- **What reaches the Worker/service** — the ciphertext envelope and TTL only.
  No plaintext secret, decryption key, or repository identity is sent to the
  Worker/service.
- **One line of output carries the link** — the key, the fragment, the value
  and the origin appear nowhere else, on success or on failure.
- **Origin policy** — `REPOBD_SERVER_URL` when set, otherwise the
  local-development default `http://localhost:8787`. HTTPS is required, with
  one narrow exception: plain HTTP only for a loopback development origin
  (`localhost`, `127.0.0.1`, `[::1]`). The link builder and the link parser
  share one policy, so `send` cannot print a link `pull` would refuse. No
  configuration file, no `--server` flag, no TTL flag.

## Implemented pull lifecycle

```text
delivery link (stdin prompt)
→ local repository guard
→ claim
→ decrypt
→ validate exactly one KEY=value
→ inspect .env
→ replacement confirmation, only if an existing different value would be lost
→ server-authoritative ownership gate
→ safe write
→ read-back verification
→ consume
```

Properties this ordering carries:

- **Wrong repository** — no claim, no secret retrieval, no write, no consume.
  The check completes before any network call, so a mismatch never constructs a
  client.
- **Ownership before mutation** — immediately before writing, RepoBD re-claims
  with the same token and requires the server's own remaining-lease figure to
  be a finite duration within the protocol range and above a minimum safe
  window. A local clock is never used to decide this. If ownership cannot be
  confirmed, nothing is written.
- **Local apply failure** — no consume.
- **Same value already present** — no write, and the apply counts as
  successful, so the delivery is consumed. This is what lets a run whose
  consume was lost converge on a retry.
- **Different existing value** — explicit human confirmation, showing the key
  name and never a value, and requiring a terminal. The approval is bound to
  the exact filesystem state that was inspected; if `.env` changes after the
  answer, the approval is invalid and nothing is written.
- **Verified apply only** — consume happens only after a write has been read
  back and proved.
- **Consume transport uncertainty** — bounded idempotent retry. No second
  `.env` write occurs on any recovery path.

## Threat boundary

RepoBD is a practical accidental-safety guardrail. Repository binding is not
authentication and is not a cryptographic proof of repository.

Outside the v0.1 threat model: a compromised OS, a malicious local user, a
modified RepoBD binary, a Git binary or configuration deliberately altered to
defeat RepoBD, a deliberately rewritten delivery binding, and a hostile local
filesystem race beyond the supported accidental-concurrency boundary.

Documentation must not promise defence against these.

## Stack

- Domain/DNS/email routing: Cloudflare
- Web/API: Cloudflare Workers
- Database: Cloudflare D1
- Crypto: Web Crypto API / native platform crypto
- CLI: Node.js + TypeScript, npm package `repobd`
- Tests: Vitest + Cloudflare Workers Vitest integration

See `docs/BUILD_NATIVE_DEPENDENCY.md` before adding dependencies.

## Herdr development layout

- Pane 1: Claude Code — implementation, default Sonnet 5
- Pane 2: Codex — read-only review, gpt-5.6-sol / High
- Pane 3: test terminal — no AI required
- Pane 4: Wrangler/dev runtime terminal — no AI required

Security-sensitive tasks may escalate Claude Code to Opus 5 and Codex to
maximum available effort.

## Phase status

Authoritative phase plan: `docs/IMPLEMENTATION_PLAN.md`.

- **Phase 0 — repository scaffold** (`94d96d1`). COMPLETE. Minimal TypeScript
  workspace, Vitest, local-only Wrangler config, no product behaviour.
- **Phase 1 — crypto envelope** (`7e4b30c`). COMPLETE. Client-side
  AES-256-GCM in `src/crypto/envelope.ts`.
- **Phase 2 — Worker + D1 transport** (`de073a9`, `28772ba`, `4e2733b`).
  COMPLETE. Schema and migrations, create/claim/consume/release lifecycle,
  claim leases, TTL, one-time semantics, request validation. Local-only.
- **Phase 3 — CLI repository identity guard** (`8885e38`, `89f46f4`,
  `afd6f8c`). COMPLETE. `src/repo/identity.ts` and `binding.ts` are pure;
  `src/repo/git.ts` resolves the local repository through read-only Git;
  `src/cli/link.ts`, `guard.ts` and `secret-client.ts` enforce the ordered
  check before any network access.
- **Phase 4 — safe local apply** (`63a3575`, `266cc97`). COMPLETE.
  `src/apply/payload.ts` is the single authority for the `KEY=value` grammar;
  `src/apply/env-file.ts` recognizes a conservative single-line `.env` subset
  as an allowlist; `src/apply/target.ts` is the filesystem trust boundary; and
  `src/cli/commands.ts` wires the lifecycle above.
- **Phase 5A — CLI sender, local development** (`7dbebba`). COMPLETE.
  `src/cli/prompt.ts` reads `KEY` and the value from stdin;
  `src/cli/commands.ts` (`runSend`) orders origin resolution, repository
  resolution, grammar validation and local encryption ahead of the single
  create call; `src/cli/secret-client.ts` adds `create` and validates the
  configured origin; `src/cli/link.ts` owns the one origin policy the builder
  and parser share.
- **Phase 5B — production integration and real end-to-end.** IN PROGRESS.
  Phase 5B-1 (rate-limit enforcement + non-executable production D1 shape) is
  implemented across three distinct Wrangler configs, each with a different
  role:
  - `wrangler.jsonc` (local dev + the existing shared worker test suite):
    `CREATE_LIMITER` and `LIFECYCLE_LIMITER`, both `1000` requests/60s — a
    generous local-only ceiling, **not** the production threshold, chosen so
    the pre-existing 890+ tests sharing one Miniflare instance are never
    throttled by it.
  - `wrangler.production.jsonc` (what actually deploys, not yet used):
    `CREATE_LIMITER` exactly `20`/60s, `LIFECYCLE_LIMITER` exactly `120`/60s
    — the real production policy. No `d1_databases` entry — that is added
    only at Human Gate A, once the database actually exists; no fake or
    placeholder `database_id` is committed.
  - `wrangler.ratelimit-test.jsonc` (test-only, its own isolated Miniflare
    instance via `test/vitest.worker-ratelimit.config.ts`): the same exact
    `20`/`120` per 60s thresholds as production, so
    `test/worker.ratelimit.test.ts` proves the real numbers end-to-end
    without sharing a counter with any other test file.

  `src/worker/index.ts` calls `limit({ key })` on the matching binding ahead
  of create and ahead of claim/consume/release, keyed on the coarse
  `CF-Connecting-IP` signal, returning 429 before any D1 mutation on
  rejection. `/health` and unmatched routes never consult a limiter. Every
  `ratelimits` `namespace_id` across all three configs is a distinct
  positive-integer string, non-secret, never derived from a secret, key,
  repository identity, delivery id, claim token, or client IP;
  account-wide uniqueness against other Cloudflare resources on the target
  account has not been verified and is a documented Gate B pre-deploy
  requirement, not a claim. No Cloudflare resource has been created, no
  migration applied, nothing deployed, no E2E run. Not yet reviewed by
  Codex.

Phases 0–4 each closed with a Codex security review at blocker 0 / major 0.

## Known open items

- **Phase 5B-1 is implemented but not yet reviewed.** The rate-limit
  enforcement and config are locally validated but have not passed Codex
  Review A or Human Gate A.
- **Deferred post-v0.1 by decision, not omission:** a web sender and any
  environment metadata channel. There is no TTL flag and no `--server` flag,
  and neither is planned for v0.1.
- **Release documentation is not written.** The v0.1 boundaries — one
  `KEY=value` per delivery, the conservative `.env` subset, and the absence of
  a shell-`source` guarantee — are now stated in `README.md` and
  `docs/MVP_REQUIREMENTS.md`, and are recorded as marked release requirements in
  the module headers of `src/apply/payload.ts`, `env-file.ts` and `target.ts`.
  What is still missing is the material a release would need beyond that:
  `SECURITY.md` and a disclosure process, an install and quick-start path, and
  privacy/terms for a hosted service. The repository is private and nothing is
  published, so none of it is on a deadline.
- **`cli.smoke.test.ts` is load-sensitive.** Both of its cases spawn
  `npx tsx src/cli/index.ts` with no per-test timeout, against vitest's 5s
  default. One local full-suite run has failed on it under load; it has not
  failed in CI. Phase 0 code, untouched since. Fixing it needs its own
  authorized cycle.
- **No production infrastructure.** No Cloudflare resources are provisioned and
  nothing is deployed.

## Development workflow

Human-mediated, one active AI agent at a time:

```text
CC → Codex → user → GPT analysis → human decision → optional next CC cycle
```

Claude Code implements only an explicitly authorized cycle, sends the review
request to Codex, then goes idle. Codex reviews read-only and reports in its
own pane. Review results do not return to Claude Code, and Claude Code never
polls for them. Every new write cycle needs explicit user authorization. See
`docs/AI_WORKFLOW.md` for the authoritative detail.

## Next action

1. Send the Phase 5B-1 working tree to Codex for Review A (rate-limit
   binding syntax/enforcement, no fake D1 identifier, explicit production
   targeting — see the Phase 5B plan).
2. Human Gate A: authorize creating the dedicated RepoBD production D1
   database, then add its real binding to `wrangler.production.jsonc`.
3. Human Gate B: authorize the migration, rate-limit activation, and deploy.
4. Human Gate C: authorize the real E2E matrix.

Production Cloudflare resource creation, deployment and npm publication all
still require explicit user approval.
