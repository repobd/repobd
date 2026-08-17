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

Current phase: **Phase 0 — repository scaffold only**.

Phase 0 must not implement product behavior. It may only establish the smallest runnable TypeScript/CLI/Cloudflare test scaffold required for later phases. No production Cloudflare resource creation or deployment is allowed without explicit user approval.

## Next action

1. Pull the latest documentation locally.
2. Open `/Users/shinya/Desktop/repobd` in Herdr with the four-pane layout.
3. Start Claude Code with Sonnet 5 and have it read the required bootstrap documents before proposing the Phase 0 plan.
4. Start Codex with gpt-5.6-sol / High, read-only, and have it confirm the same authoritative baseline before any review work.
5. Do not implement Phase 1 crypto until Phase 0 is complete and reviewed.
