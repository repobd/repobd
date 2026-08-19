# RepoBD Handover

## Current state

RepoBD requirements and initial development-policy documents have been reviewed by the user and are approved as the baseline for MVP implementation.

Repository:
- GitHub: `repobd/repobd` (private during MVP development)
- Local path: `/Users/shinya/Desktop/repobd`
- Domain: `repobd.com`
- npm account: `repobd`
- Email aliases: `hello@repobd.com`, `support@repobd.com`, `security@repobd.com`, `abuse@repobd.com`

## Product direction

RepoBD is a lightweight secret handoff tool focused on preventing accidental application of secrets to the wrong repository.

Core positioning:

- **Secrets should travel with context.**
- **Wrong repo. No secret.**
- RepoBD is not a Secret Manager.
- AI parallel development makes an old assumption weaker: human visual/context checks no longer scale with the number of repos, terminals, agents, and environments.
- RepoBD also supports human-to-human handoff; AI is an accelerator of the problem, not the only use case.

## Confirmed MVP principles

- Client-side encryption.
- Server never receives plaintext secret content.
- Decryption key never reaches server.
- Text payload only, maximum 64 KiB.
- Repository identity is the hard machine check for v0.1.
- Git `origin` is used for repository identity and normalized across supported URL forms.
- Branch is not part of v0.1 binding.
- Environment is metadata shown for explicit confirmation in v0.1; do not invent unreliable automatic environment detection.
- Target/variable mapping may be suggested from facts found locally in the repository, but suggestions must be labeled as suggestions unless directly evidenced.
- Existing `.env` value replacement requires confirmation.
- No commit/push/deploy from RepoBD.
- On local failure, discard local plaintext/temp state; do not consume the remote secret until successful apply.
- Repository mismatch blocks apply but does not consume the remote secret.
- One-time semantics and TTL are required.
- Abuse protection should rely on Cloudflare controls and metadata/traffic patterns, not plaintext inspection.

## Planned stack

- Domain/DNS/email routing: Cloudflare
- Web/API: Cloudflare Workers / static web app
- Database: Cloudflare D1
- Crypto: Web Crypto API / native platform crypto
- CLI: Node.js + TypeScript + npm package `repobd`
- Tests: Vitest + Cloudflare Workers Vitest integration

See `docs/BUILD_NATIVE_DEPENDENCY.md` before adding dependencies.

## Herdr development layout

- Pane 1: Claude Code — implementation, default Sonnet 5
- Pane 2: Codex — read-only review, gpt-5.6-sol / High
- Pane 3: test terminal — no AI required
- Pane 4: Wrangler/dev runtime terminal — no AI required

Security-sensitive tasks may escalate Claude Code to Opus 5 and Codex to maximum available effort.

## Implementation sequence

Authoritative phase plan: `docs/IMPLEMENTATION_PLAN.md`.

Completed:

- **Phase 0 — repository scaffold** (`94d96d1`). Minimal TypeScript
  workspace: CLI and Worker skeletons, Vitest, local-only Wrangler config.
  No product behavior, no production Cloudflare resources.
- **Phase 1 — crypto envelope, local-only proof** (`7e4b30c`). Client-side
  AES-256-GCM in `src/crypto/envelope.ts`. Final Codex security review:
  blocker 0 / major 0 / minor 0 / nit 0, PASS.
- **Governance hardening.** `docs/AI_WORKFLOW.md` and the surrounding
  documents are finalized and in force.
- **Phase 2 — Worker + D1 short-lived ciphertext transport** (`de073a9`,
  `28772ba`, `4e2733b`). Local D1 schema and migrations, create/claim/
  consume/release lifecycle, claim leases, TTL, one-time semantics, and
  request validation in `src/worker/`. Local-only: no production
  Cloudflare resources exist and nothing is deployed.
- **Phase 3A — hosted repository identity binding** (`8885e38`).
  `src/repo/identity.ts` canonicalizes supported hosted remotes to
  `<host>/<path>`; `src/repo/binding.ts` serializes, parses, and compares
  the binding descriptor. Pure, no I/O.
- **Phase 3B — safe local repository resolution** (`89f46f4`).
  `src/repo/git.ts` reads the current repository's identity through three
  read-only Git commands, strips repository-selection environment
  variables from the child, and never returns the raw origin URL.

In progress:

- **Phase 3C — CLI guard integration.** Implemented and validated, awaiting
  the full Phase 3 Codex security review. `src/cli/link.ts` parses and
  builds delivery links, `src/cli/guard.ts` runs the ordered repository
  check, `src/cli/secret-client.ts` is the only network code, and
  `src/cli/commands.ts` wires `pull` and `send`. Not committed.

  One correction cycle has been applied against the first Codex review
  (blocker 0 / major 2 / minor 2): Git origin values with surrounding
  whitespace now fail closed instead of being trimmed into validity; the
  delivery link is read from a stdin prompt rather than argv; the fragment
  grammar is exact (one `k`, one `b`, no repeats, no unknown fields); and
  the secret id must match the Worker's canonical capability grammar.

Not started:

- **Phase 4 — safe local apply.** `pull` currently claims and then
  releases the delivery unused; decrypting, mapping, writing, and consume
  all belong to Phase 4.
- **Phase 5 — end-to-end send/pull UX.** `send` reports the repository a
  link would be bound to; it does not yet encrypt or create a delivery.

## Phase 3 guarantee, as implemented

- Repository binding is a **context guardrail, not authentication**. The
  binding is unsigned; a compromised OS, modified local Git, modified CLI,
  or a deliberately rewritten fragment is out of scope.
- Supported hosted profiles are **github.com, gitlab.com, bitbucket.org**;
  their common HTTPS and SSH clone forms normalize to one identity.
- Unsupported or ambiguous repository setups **fail closed**.
- The exact repository check completes **before any network secret
  retrieval**. A mismatch submits no claim and fetches no ciphertext.
- The **server never receives repository identity** — it lives only in the
  delivery link fragment.

## Development workflow

Human-mediated, one active AI agent at a time:

```text
CC → Codex → user → GPT analysis → human decision → optional next CC cycle
```

Claude Code implements only an explicitly authorized cycle, sends the
review request to Codex, then goes idle. Codex reviews read-only and
reports in its own pane. Review results do not return to Claude Code, and
Claude Code never polls for them. Every new write cycle needs explicit user
authorization. See `docs/AI_WORKFLOW.md` for the authoritative detail.

## Next action

1. Complete the full Phase 3 (3A + 3B + 3C) Codex security review.
2. Decide on findings, then authorize any fix cycle explicitly.
3. Only then plan Phase 4 against `docs/IMPLEMENTATION_PLAN.md`.

Production Cloudflare resource creation and deployment still require
explicit user approval.
