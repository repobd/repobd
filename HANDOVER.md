# RepoBD Handover

## Current state

Phases 0 through 4 are complete, committed and pushed. `repobd pull` runs the
whole delivery lifecycle. `repobd send` is not complete.

- branch: `main`
- HEAD: `266cc971c155b3f3d19ebcbb367677bd38450da2`
- commit: `feat: complete safe secret apply flow`
- CI: run `32355153940`, SUCCESS
- validation at that commit: 806 / 806 tests, 17 files; typecheck PASS; build PASS

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
- **Phase 5 — end-to-end send UX.** NOT STARTED, and needs replanning against
  the narrowed v0.1 boundary before implementation.

Every phase closed with a Codex security review at blocker 0 / major 0.

## Known open items

- **`repobd send` is incomplete.** It resolves and reports the repository a
  link created here would be bound to. It does not accept a secret, encrypt
  it, create a delivery, or produce a usable link. A delivery must currently be
  created by other means to exercise `pull` end to end.
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

1. Plan the remainder of the MVP against the narrowed v0.1 boundary — in
   particular what `send` must do now that a delivery carries exactly one
   `KEY=value`.
2. Decide the open product questions that planning surfaces, at the Human Gate.
3. Only then authorize a Phase 5 implementation cycle.

Production Cloudflare resource creation, deployment and npm publication all
still require explicit user approval.
