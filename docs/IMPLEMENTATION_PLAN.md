# RepoBD MVP Implementation Plan

## Purpose

This plan converts the reviewed MVP requirements into small implementation phases. It is intentionally conservative: each phase must preserve the security invariants and avoid unnecessary dependencies or abstractions.

## Status

| Phase | Scope | Status |
|---|---|---|
| 0 | Repository scaffold | COMPLETE |
| 1 | Crypto envelope | COMPLETE |
| 2 | Worker + D1 transport | COMPLETE |
| 3 | CLI repository identity guard | COMPLETE |
| 4 | Safe local apply | COMPLETE |
| 5A | CLI sender, local development only | COMPLETE |
| 5B | Production integration and real end-to-end | IMPLEMENTED — production E2E completed, pending final Review B / commit gate |
| 6 | Release hardening | NOT STARTED |

Current committed HEAD: `4bf43fa382ff841e929edb00e91913fa2c04a404`,
`chore: bind production D1 database`. Phase 5B closure documentation is
uncommitted work in progress on top of it.

The phase descriptions below are kept as written where they still describe what
was built. Where the delivered scope is narrower than the original sketch —
Phase 4 most of all — the section says so rather than being rewritten to look
like it was always the plan. That history is why the v0.1 boundary is what it
is.

## Phase 0 — Repository scaffold only — COMPLETE

Goal: create the smallest runnable TypeScript workspace without product behavior.

Scope:
- package metadata and scripts
- TypeScript configuration
- minimal CLI entry point skeleton
- minimal Worker/static web app skeleton only if required by the chosen Cloudflare scaffold
- Vitest / Cloudflare test setup
- `.gitignore` and `.env.example` with names only, no secrets
- Wrangler configuration for local development only

Do not create D1 production resources or deploy anything in this phase.

Validation:
- typecheck passes
- minimal test command runs
- CLI help/version skeleton runs locally
- Worker local test harness runs if scaffolded

Stop point: report the exact files and dependencies added before any transport implementation.

## Phase 1 — Crypto envelope and local-only proof — COMPLETE

Goal: prove client-side/native encryption and decryption without server persistence.

Scope:
- Web Crypto AES-GCM using native APIs
- secure random key and IV generation
- versioned envelope shape
- 64 KiB plaintext limit enforced before encryption
- tests for round trip, modified ciphertext, wrong key, oversized payload

Rules:
- no custom cryptographic primitive
- plaintext must not be logged
- no network call is required for the proof

Stop point: Codex security review of the crypto flow before persistence is added.

## Phase 2 — Worker + D1 short-lived ciphertext transport — COMPLETE

Goal: store only ciphertext and non-secret metadata and retrieve it by opaque id.

Scope:
- create local D1 migration/schema
- create secret record
- fetch metadata/ciphertext needed by the receiver
- TTL enforcement
- one-time state model
- payload/request validation
- Cloudflare-native abuse/rate-limit controls where practical

Rules:
- Worker must never receive decryption key or plaintext
- no production resource creation/deployment without explicit user approval
- no request-body/payload logging

Stop point: adversarial tests + Codex review of server boundary and D1 state transitions.

## Phase 3 — CLI repository identity guard — COMPLETE

Goal: block a delivery when the current Git repository does not match the intended repository.

Scope:
- detect Git repository
- read `origin` via Git CLI
- normalize supported HTTPS/SSH Git remote forms
- compare with sender-bound repository identity
- hard block mismatch before apply
- ignore branch for v0.1

Rules:
- folder name/path is not repository identity
- no git commit/push/write operations
- malicious local Git configuration is outside the v0.1 threat model

Stop point: demonstrate `test-alpha -> alpha PASS` and `test-alpha -> beta BLOCK`.

## Phase 4 — Safe local apply — COMPLETE

Commits `63a3575` (4A + 4B) and `266cc97` (4C).

Goal, as originally written: safely map and write received developer secrets
after repository match.

**What was actually built is narrower than that goal, deliberately.** During
Phase 4 planning the payload contract was settled at exactly one `KEY=value`
per delivery, which removed the need for mapping inference entirely — the key
travels inside the payload — and the target was fixed at a single file. The
scope below describes what exists, not what was first sketched.

Delivered in three slices:

**4A — payload and existing-file logic (pure).**
- `src/apply/payload.ts`: the single authority for the `KEY=value` grammar.
  Exactly one assignment; several fail closed.
- `src/apply/env-file.ts`: recognizes a conservative single-line subset of
  `.env` as an allowlist, and refuses everything outside it — duplicates,
  multiline values, same-line compound syntax, loader-dependent forms, exotic
  whitespace. No dotenv parser.

**4B — filesystem trust boundary.**
- `src/repo/git.ts` gained `rev-parse --show-toplevel` as a fourth read-only
  allowlisted command, returning the work tree root alongside the identity.
- `src/apply/target.ts`: writes only `<verified root>/.env`, a path it
  constructs and never accepts. Symlink and special-file refusal, exclusive
  create at `0600`, append that cannot truncate, replacement through a temp
  file whose ownership and permissions are established and verified before any
  secret byte is written, BOM preservation, and read-back verification.

**4C — lifecycle wiring.**
- `src/cli/commands.ts` runs the full pull lifecycle; `secret-client.ts` gained
  `consume`; `prompt.ts` gained a TTY-only replacement confirmation.
- The Worker claim response gained `lease_remaining_ms`, additively. No state,
  token semantics, consume precondition, TTL or lease rule changed.

Consume semantics, as implemented:
- no consume on repository mismatch — and no claim either
- no consume on user cancellation
- no consume on operational or write failure
- no consume when ownership cannot be confirmed immediately before the write
- consume only after a verified successful apply, where an existing identical
  value counts as success so a retry converges

Every slice closed with a Codex security review at blocker 0 / major 0.

## Phase 5A — CLI sender — COMPLETE

The original Phase 5 sketch here assumed a wider payload than v0.1 settled on —
free text, a `.env` document, environment metadata and target selection — and a
web send page. A planning cycle replaced it, and the questions it left open were
decided at the Human Gate before implementation. Phase 5 is split: 5A is the
CLI sender against local development, 5B is production integration and a real
end-to-end run.

`repobd send` now encrypts one `KEY=value` locally and prints a delivery link
`repobd pull` can consume. Delivered scope:

- `KEY` and value prompted as two separate stdin lines. The value is plain and
  unmasked in v0.1, and no secret is ever accepted as a command-line argument.
- exactly one `KEY=value`, validated by the existing Phase 4 payload grammar.
  No new grammar was added.
- local encryption with a fresh key, before any network call. The 64 KiB bound
  is the crypto layer's own.
- create carries the ciphertext envelope and the TTL only — no plaintext, no
  key, no repository identity. The Worker's existing create endpoint is reused;
  no endpoint and no cryptographic primitive was added.
- TTL fixed at 900 seconds. No flag, no prompt, no environment override.
- service origin from `REPOBD_SERVER_URL`, otherwise the local-development
  default `http://localhost:8787`. HTTPS is required, with one narrow
  exception: plain HTTP only for a loopback development origin (`localhost`,
  `127.0.0.1`, `[::1]`), which is what lets the local flow produce a link that
  parses. The builder and the parser share one origin policy so they cannot
  diverge. No configuration file, no `--server` flag.
- one line of output carries the delivery link; nothing else prints the key,
  the fragment, the value, or the origin.

Deferred post-v0.1: a web sender, and environment metadata. The receiver's
target stays `.env` at the verified work-tree root; target selection is not an
open question.

Fixed, as before:

- client-side encryption; the server never receives plaintext or the key
- the binding is produced from the sender's own resolved repository
- the delivery link carries key and binding in the fragment only
- no commit, push, deploy, package install, or arbitrary command execution

## Phase 5B — Production integration and real end-to-end — IMPLEMENTED, production E2E completed

Goal: stand up the minimum Cloudflare surface needed to prove one genuine
external send → pull round trip.

Scope: a production D1 database and applied migrations, a
`wrangler.production.jsonc` production configuration, a deployed Worker, the
CLI pointed at that origin over HTTPS, and minimal Cloudflare-native rate
limiting in place *before* the end-to-end matrix runs against a public
endpoint.

Every step that creates or changes a production Cloudflare resource required
explicit user approval first, split across three Human Gates — A: create the
D1 database and bind its real id; B: migrate, activate rate limiting, and
deploy; C: run the real E2E matrix — all three now complete.

**Phase 5B-1 — rate-limit enforcement + non-executable production D1
shape — COMPLETE, reviewed at Codex Review A (blocker 0 / major 0 / minor 0
/ nit 0).** Cloudflare Workers Rate Limiting bindings (`CREATE_LIMITER` on
`POST /api/secrets`, `LIFECYCLE_LIMITER` on claim/consume/release) exist in
three Wrangler configs, each with a different role and threshold:

- `wrangler.jsonc` — local dev and the existing shared worker test suite.
  Both limiters set to `1000` requests/60s: a generous local-only ceiling,
  **not** the production threshold, so the pre-existing tests (which share
  one Miniflare instance and therefore one counter per namespace for their
  whole run) are never throttled by it.
- `wrangler.production.jsonc` — what is now actually deployed.
  `CREATE_LIMITER` exactly `20` requests/60s, `LIFECYCLE_LIMITER` exactly
  `120` requests/60s — the real production policy — plus the real
  `d1_databases` binding to `repobd-production`
  (`database_id 79800646-dc8a-4dca-97c9-81fed33dc94a`), added at Human Gate
  A from the actual `wrangler d1 create` output.
- `wrangler.ratelimit-test.jsonc` — test-only, its own isolated Miniflare
  instance (via `test/vitest.worker-ratelimit.config.ts`). Same exact
  `20`/`120` per-60s thresholds as production, so
  `test/worker.ratelimit.test.ts` proves the real numbers end-to-end
  without any other test file's traffic sharing its counters.

`src/worker/index.ts` enforces via `limit({ key })`, keyed on the coarse
`CF-Connecting-IP` signal, returning 429 before any D1 mutation on
rejection. `/health` and unmatched routes never consult a limiter. Every
`ratelimits` `namespace_id` in all three configs is a distinct
positive-integer string — non-secret configuration, never derived from a
secret, key, repository identity, delivery id, claim token, or client IP.
Account-wide production namespace uniqueness was confirmed before deploy: a
read-only Cloudflare API check (`GET /accounts/{id}/workers/scripts`) showed
zero pre-existing Worker scripts on the target account.

**Phase 5B-2/3 — infrastructure provisioning, deploy, and real E2E —
COMPLETE.** D1 created (`repobd-production`) and migrated
(`0001_create_secrets.sql`, schema verified to match the reviewed design
exactly); Worker deployed to `https://repobd-worker.shinya-bj.workers.dev`
(version `7c505c06-f0f4-4b03-9992-10226f3858ec`); `GET /health` returns
`200 ok`. A real synthetic E2E matrix ran against this environment:

- **E2E-1 normal round trip** — PASS. `send` → production `create` →
  delivery link → `pull` in the matching fixture repository → correct
  value written and read back → `consume` → production row reached
  `consumed`.
- **E2E-2 wrong repository** — PASS. `pull` from a different fixture
  repository was rejected with "Repository mismatch" before any claim;
  read-only D1 inspection confirmed the row stayed `available` throughout;
  the intended repository could still claim it afterward.
- **E2E-3 consumed delivery** — PASS. A second `pull` of the same,
  already-consumed delivery was rejected ("already been used"); no second
  `.env` write; `consumed_at` unchanged in D1.
- **E2E-4 expiry** — PASS, tested via a direct authorized call to the
  existing `create` endpoint with a short `ttl_seconds` (no TTL CLI
  override added, and the shipped CLI's fixed 900-second TTL is
  unchanged); claim after expiry returned `410 expired`.
- **E2E-5 same-value convergence** — PASS. A delivery matching an
  already-present `.env` value produced no file write (file hash/mtime
  unchanged) but still consumed the delivery in D1 — the documented
  lost-consume-retry convergence path.
- **E2E-6 consume uncertainty** — intentionally not run against production;
  existing Phase 4 HTTP-client-boundary integration tests remain
  authoritative, and Phase 5B does not add network-chaos infrastructure.
- **E2E-7 unreachable origin** — PASS, tested locally against an
  unreachable loopback origin; CLI failed closed ("Could not reach the
  RepoBD service") with no `.env` write; production was never contacted.
- **E2E-8 create rate-limit admission** — PASS. A 25-request synthetic
  burst against the live create limiter produced 21 successes and 4
  `429 {"error":"rate_limited"}` rejections (window-boundary timing, not a
  threshold change — the configured limit remained exactly 20/60s
  throughout); read-only D1 inspection confirmed exactly the successful
  count of new rows, i.e. every rejected request produced zero state
  mutation; `/health` remained `200` throughout; a create after the window
  reset succeeded again.

Read-only production D1 inspection across every row created during the
matrix confirmed no plaintext synthetic value, decryption key, or
repository-identity string ever appeared in server storage. Only synthetic
test data was used throughout; no real credential was ever entered.

## Phase 6 — Release hardening — NOT STARTED

Goal: make v0.1 safe enough for external testing.

Scope:
- full negative/adversarial test pass
- README quick start
- SECURITY.md / responsible disclosure
- threat-model wording checked for overclaiming
- privacy/terms minimum needed for hosted service
- abuse contact/process
- npm package smoke test
- demo/test repositories only; no production credentials

Public release remains a separate explicit decision.

## Development policy

For every phase:
1. Read `AGENTS.md`, `HANDOVER.md`, `docs/AI_WORKFLOW.md`, and only the relevant authoritative sections.
2. Claude Code proposes a small implementation plan first.
3. User approves scope where required.
4. Claude Code implements the smallest change.
5. Targeted tests/typecheck run — completed before the review is requested.
6. Codex performs read-only review from the chosen base commit. Claude Code
   is idle for the whole review — no edits, no other repository work, no
   polling for the result.
7. Codex findings go to the user. Any repair, at any severity, requires
   explicit human authorization for a new write cycle; re-review happens
   only after that separately authorized fix cycle. See "Single active
   agent per repository", the "Review wait gate", and the "Human
   authorization gate" in `docs/AI_WORKFLOW.md`.
8. Push/deploy/resource creation require explicit user approval.

Model defaults:
- Claude Code: Sonnet 5
- Codex: gpt-5.6-sol, High

Escalate security-sensitive design/changes to:
- Claude Code: Opus 5
- Codex: gpt-5.6-sol, maximum available effort
