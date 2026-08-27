# RepoBD Handover

## Current state

Phases 0 through 6C-2-A are complete and committed. `repobd pull` and
`repobd send` together run a local send → pull round trip, proven against
real production infrastructure. Phase 6 — release readiness — is in
progress: the Phase 6 plan is Human-approved, Phase 6B (local release
artifact preparation) and Phase 6C-2-A (production custom domain) are both
committed, and Phase 6C-2-B (CLI default-origin change) is implemented and
uncommitted.

- branch: `main`
- current committed HEAD: `80a596e0ed947d038ee0b364fb3292b7b1c3a114`
- commit: `chore: add stable production service domain`
- Phase 5B: COMPLETE. Production D1 created and migrated, Worker deployed
  to `workers.dev` with rate-limit guardrails active, and a real synthetic
  end-to-end matrix run against that production environment (Human Gates
  A, B, and C). Closure documentation reviewed at Codex Review B (blocker
  0 / major 0 / minor 0 / nit 0) and committed.
- Phase 6B: COMPLETE. Release artifacts (`package.json`, `LICENSE`,
  `SECURITY.md`, `README.md`, the CLI version fix) reviewed and committed
  — see "Phase 6" below.
- Phase 6C-1: COMPLETE. Read-only pre-public audit — full-history
  `gitleaks` scan clean, `repobd.com` zone confirmed on the intended
  Cloudflare account, no conflicting DNS for `api.repobd.com`, npm
  package name confirmed available.
- Phase 6C-2-A: COMPLETE. `api.repobd.com` attached to the production
  Worker as a Wrangler Custom Domain; `workers.dev` deliberately kept
  live as a fallback (`workers_dev: true`), Preview URLs explicitly
  disabled (`preview_urls: false`). Both endpoints healthy.
- Phase 6C-2-B: implemented, uncommitted — see "Phase 6" below.

Repository:
- GitHub: `repobd/repobd` (private during MVP development)
- Local path: `/Users/shinya/Desktop/repobd`
- Domain: `repobd.com`
- npm account: `repobd`
- Email aliases: `hello@repobd.com`, `support@repobd.com`, `security@repobd.com`, `abuse@repobd.com`

Production Cloudflare resources now exist for RepoBD (Phase 5B — see
below); the repository is still private, and nothing is published to npm.
This is production *integration*, not a public release: no public
documentation, support process, or announced availability exists yet, and
none is implied by this checkpoint.

### Production environment (Phase 5B, updated Phase 6C-2-A)

- **Worker:** `repobd-worker`. Public origin (as of Phase 6C-2-A):
  `https://api.repobd.com`, a Wrangler Custom Domain attached to this same
  Worker; `https://repobd-worker.shinya-bj.workers.dev` remains live
  deliberately as a fallback (`workers_dev: true`), Preview URLs are
  explicitly disabled (`preview_urls: false`). Current version
  `eca60b38-e69f-4de1-8ae8-c9c76140a192`.
- **D1:** `repobd-production` (`database_id`
  `79800646-dc8a-4dca-97c9-81fed33dc94a`), migration
  `0001_create_secrets.sql` applied, schema matches the reviewed design
  exactly (`id, envelope, created_at, expires_at, state, claim_id,
  claim_expires_at, consumed_at` — no plaintext, key, or repository-identity
  column).
- **Rate limiting:** `CREATE_LIMITER` (namespace `2001`, 20 requests/60s on
  `POST /api/secrets`) and `LIFECYCLE_LIMITER` (namespace `2002`, 120
  requests/60s on claim/consume/release), both active in production;
  `/health` and unmatched routes are exempt. Account-wide namespace
  uniqueness was confirmed before deploy — the account had zero Worker
  scripts prior to this deployment.
- **Real E2E matrix (synthetic data only, no real credentials):** normal
  round trip, wrong-repository block, consumed-delivery re-pull rejection,
  real TTL expiry, same-value convergence, unreachable-origin local
  fail-closed behavior, and the create rate limiter's 429 admission guard
  were all exercised against this live production environment and passed.
  Consume-uncertainty/retry (E2E-6) was intentionally not run against
  production — existing HTTP-client-boundary integration tests from Phase 4
  remain the authority for that behavior, and Phase 5B does not add
  network-chaos infrastructure. Read-only production D1 inspection
  confirmed no plaintext secret value, decryption key, or repository
  identity ever reached server storage, in any row created during this
  matrix.

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
- **Origin policy** — `REPOBD_SERVER_URL` when set, otherwise the default
  production service `https://api.repobd.com` (live since Phase 6C-2-A).
  HTTPS is required, with one narrow exception: plain HTTP only for a
  loopback development origin (`localhost`, `127.0.0.1`, `[::1]`), reached
  through the `REPOBD_SERVER_URL` override for local development/testing.
  The link builder and the link parser share one policy, so `send` cannot
  print a link `pull` would refuse. No configuration file, no `--server`
  flag, no TTL flag.

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
- **Phase 5B — production integration and real end-to-end.** COMPLETE.
  Closure documentation reviewed at Codex Review B (blocker 0 / major 0 /
  minor 0 / nit 0) and committed at `ea51dfb`. Phase 5B-1 (rate-limit
  enforcement + non-executable production D1 shape,
  reviewed at Codex Review A: blocker 0 / major 0 / minor 0 / nit 0) is
  committed across three distinct Wrangler configs, each with a different
  role:
  - `wrangler.jsonc` (local dev + the existing shared worker test suite):
    `CREATE_LIMITER` and `LIFECYCLE_LIMITER`, both `1000` requests/60s — a
    generous local-only ceiling, **not** the production threshold, chosen so
    the pre-existing 890+ tests sharing one Miniflare instance are never
    throttled by it.
  - `wrangler.production.jsonc` (what is now actually deployed — see
    "Production environment" above): `CREATE_LIMITER` exactly `20`/60s,
    `LIFECYCLE_LIMITER` exactly `120`/60s — the real production policy, and
    the real `d1_databases` binding to `repobd-production`, added at Human
    Gate A from the actual `wrangler d1 create` output.
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
  repository identity, delivery id, claim token, or client IP.
  Account-wide production namespace uniqueness was confirmed before deploy
  (zero pre-existing Worker scripts on the target account). Human Gates A
  (D1 creation), B (migration + rate-limit activation + deploy + health),
  and C (real synthetic E2E matrix) are all complete, and Codex Review B
  closed at blocker 0 / major 0 / minor 0 / nit 0.
- **Phase 6 — release readiness.** IN PROGRESS. The Phase 6 audit plan is
  Human-approved: MIT license, manual/2FA first npm publish, a narrow npm
  `files` allowlist, and `api.repobd.com` as the v0.1 production endpoint
  are all settled decisions.
  **Phase 6B — local release artifact preparation — COMPLETE**, reviewed
  at Codex review (blocker 0 / major 0 / minor 0 / nit 0) and committed.
  `package.json` carries `version: "0.1.0"`, no `private`, a CLI-only
  `description`, `license`, `repository`/`bugs`/`homepage`, and a
  `"files": ["dist"]` allowlist; a real (unpublished) `npm pack` confirms
  the package boundary dropped from 105 files/1.0 MB (the whole
  repository) to 35 files/76.8 kB — `LICENSE`, `README.md`,
  `package.json`, and `dist/**` only, independently verified against the
  raw tarball. `LICENSE` (MIT, copyright 2026 Shinya Sato — the
  repository's own git-author identity) and `SECURITY.md` (states GitHub
  Private Vulnerability Reporting is not yet available, since the
  repository is still private, without inventing a contact) were added.
  `src/cli/index.ts` no longer hardcodes its reported version — it reads
  `version` from `package.json` at the same relative path in both the
  source tree and an installed npm package, so `repobd --version` cannot
  drift from the package version again.
  **Phase 6C-1 — pre-public readiness audit — COMPLETE.** Full-history
  `gitleaks` scan (39 commits, all refs): no leaks. `repobd.com` zone
  confirmed active, on the same Cloudflare account as the production
  Worker/D1, no conflicting DNS for `api.repobd.com`. npm package name
  `repobd` confirmed still unregistered; no npm session authenticated in
  this environment (2FA readiness remains an unverified Human
  prerequisite). GitHub repo confirmed private, zero Actions secrets,
  branch protection uninspectable while private (platform constraint).
  Identified the Wrangler Custom Domain mechanism as the correct approach
  and confirmed a `wrangler deploy` (not a DNS-only action) is required to
  attach it.
  **Phase 6C-2-A — production custom domain — COMPLETE.**
  `wrangler.production.jsonc` gained a `routes` entry attaching
  `api.repobd.com` as a Worker Custom Domain, plus explicit
  `"workers_dev": true"` and `"preview_urls": false`. A first deploy
  attempt (without the explicit `workers_dev` field) unexpectedly disabled
  `workers.dev` — Wrangler's default for an *omitted* `workers_dev` turns
  out to be `false`, not `true`, once a `custom_domain` route exists,
  contradicting the Phase 6C-1 source-reading. Corrected same-Gate, before
  proceeding, and redeployed; both `https://api.repobd.com/health` and
  `https://repobd-worker.shinya-bj.workers.dev/health` now return
  `200 ok`.
  **Phase 6C-2-B — CLI default-origin change — implemented, uncommitted.**
  `DEFAULT_SERVER_ORIGIN` in `src/cli/secret-client.ts` changed from
  `http://localhost:8787` to `https://api.repobd.com`; `REPOBD_SERVER_URL`
  remains the explicit override for local development (including the
  loopback-HTTP exception), with no change to `checkOriginPolicy`/
  `parseServiceOrigin`, repo-guard ordering, crypto, or lifecycle
  semantics. `README.md` now describes `api.repobd.com` as the live
  default, with `REPOBD_SERVER_URL` framed as an advanced override, not a
  requirement. Real default-origin production E2E (send/pull against the
  new default with no override set) is Phase 6C-2-C, not yet run. No npm
  publish, no GitHub visibility change.

Phases 0–4 each closed with a Codex security review at blocker 0 / major 0.

## Known open items

- **Phase 6C-2-B is implemented but not yet reviewed.** The CLI
  default-origin change (`src/cli/secret-client.ts`,
  `test/cli.secret-client.test.ts`, a wording fix in
  `test/cli.send.test.ts`, `README.md`) is locally validated but has not
  passed Codex review or the Phase 6C-2-B commit gate.
- **Real default-origin production E2E is still pending — Phase 6C-2-C.**
  A synthetic send/pull round trip against `https://api.repobd.com` with
  no `REPOBD_SERVER_URL` override set has not yet been run.
- **npm account 2FA readiness is an unverified Human prerequisite.** No
  npm session is authenticated in the development environment; this
  cannot be checked without one, and none has been created.
- **Deferred post-v0.1 by decision, not omission:** a web sender and any
  environment metadata channel. There is no TTL flag and no `--server` flag,
  and neither is planned for v0.1.
- **Release documentation — largely addressed by Phase 6B/6C, still not
  fully complete.** The v0.1 boundaries — one `KEY=value` per delivery,
  the conservative `.env` subset, and the absence of a shell-`source`
  guarantee — are stated in `README.md` and `docs/MVP_REQUIREMENTS.md`,
  and are recorded as marked release requirements in the module headers of
  `src/apply/payload.ts`, `env-file.ts` and `target.ts`. `SECURITY.md` and
  a `README.md` install/quick-start pass are committed as of Phase 6B.
  Still missing: privacy/terms for the hosted service, and an actual
  disclosure process beyond what `SECURITY.md` currently states (private
  reporting opens once the repository is public — Phase 6D). The
  repository is private and nothing is published, so none of it is on a
  deadline.
- **`cli.smoke.test.ts` is load-sensitive.** Both of its cases spawn
  `npx tsx src/cli/index.ts` with no per-test timeout, against vitest's 5s
  default. One local full-suite run has failed on it under load; it has not
  failed in CI. Phase 0 code, untouched since. Fixing it needs its own
  authorized cycle.
- **Production infrastructure exists and now has a stable public origin,
  but the repository/package are not yet public.** `repobd-production` D1
  and the `repobd-worker` Worker are live at both `api.repobd.com` and
  `workers.dev` (see "Phase status" above), but GitHub is still private
  and nothing is on npm — see Phase 6 for what remains before that
  decision.

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

1. Send the Phase 6C-2-B working tree to Codex for review: default-origin
   implementation, origin-policy regression check, docs accuracy, and
   package/tarball evidence.
2. Human commit gate: decide whether to commit the Phase 6C-2-B change.
3. Phase 6C-2-C (real synthetic send/pull against the live default
   origin) and the Human Public Release Gate (GitHub visibility, GitHub
   Private Vulnerability Reporting, first `npm publish`, tag/release)
   each remain separately, explicitly authorized steps — not implied by
   this cycle.

Production Cloudflare resource creation, deployment, DNS changes, and npm
publication all still require explicit user approval; no part of Phase
6C-2-C or the Public Release Gate has been authorized yet.
