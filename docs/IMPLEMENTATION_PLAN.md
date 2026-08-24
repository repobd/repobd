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
| 5 | End-to-end send UX | NOT STARTED — needs replanning |
| 6 | Release hardening | NOT STARTED |

Current HEAD: `266cc971c155b3f3d19ebcbb367677bd38450da2`,
`feat: complete safe secret apply flow`. CI run `32355153940` SUCCESS;
806 / 806 tests across 17 files, typecheck and build pass.

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

## Phase 5 — End-to-end send UX — NOT STARTED

`repobd send` currently resolves and reports the repository a delivery link
created here would be bound to. It does not accept a secret, encrypt it, create
a delivery, or produce a usable link.

**This phase needs replanning before implementation.** The scope originally
sketched here assumed a wider payload than v0.1 settled on — free text, a
`.env` document, environment metadata and target selection — and a web send
page. Now that one delivery carries exactly one `KEY=value` and the target is
fixed, what `send` must collect and how it should collect it are open questions,
not settled requirements.

Deliberately undecided, and to be resolved at a planning cycle rather than
assumed here:

- whether a web send page is part of the MVP at all, or whether `send` stays
  entirely in the CLI
- how the sender supplies the assignment, and how it avoids the argv and
  shell-history exposure that `pull` already avoids for the link
- whether environment metadata is added before the eventual v0.1 release —
  the current implementation carries no such channel, and this cycle does not
  decide whether that changes
- the slice boundaries within Phase 5

Fixed regardless of those answers, including that the receiver's target stays
`.env` at the verified work-tree root — target selection is not an open Phase 5
question for v0.1:

- client-side encryption; the server never receives plaintext or the key
- the binding is produced from the sender's own resolved repository
- the delivery link carries key and binding in the fragment only
- no commit, push, deploy, package install, or arbitrary command execution

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
