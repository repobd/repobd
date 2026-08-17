# RepoBD MVP Implementation Plan

## Purpose

This plan converts the reviewed MVP requirements into small implementation phases. It is intentionally conservative: each phase must preserve the security invariants and avoid unnecessary dependencies or abstractions.

## Phase 0 — Repository scaffold only

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

## Phase 1 — Crypto envelope and local-only proof

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

## Phase 2 — Worker + D1 short-lived ciphertext transport

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

## Phase 3 — CLI repository identity guard

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

## Phase 4 — Safe local apply

Goal: safely map and write received developer secrets after repository match.

Scope:
- detect `.env`-style multi-variable payloads
- for raw keys, derive candidate variable/target suggestions from local repository facts only
- label inference as suggestion unless directly evidenced
- confirmation before overwrite or target changes
- allowlisted target files only
- block path traversal, symlink targets, and repo-root escape
- do not print secret values
- local plaintext/temp state is discarded on failure

Consume semantics:
- do not consume on repo mismatch
- do not consume on user cancellation
- do not consume on operational/write failure
- consume only after successful local apply and verification

Stop point: targeted negative tests + Codex review.

## Phase 5 — End-to-end send/pull UX

Goal: complete the minimal user flow.

Sender:
- `repobd send` opens the RepoBD send page
- user enters text, repo, optional environment metadata/target, TTL
- client encrypts locally
- delivery URL is returned

Receiver:
- `repobd pull`
- URL entered in terminal prompt, not AI chat
- repo hard check
- show environment/target/mapping information
- explicit confirmation
- safe apply
- consume

No commit, push, deploy, shell command execution, or agent-side secret echo.

## Phase 6 — Release hardening

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
