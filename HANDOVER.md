# RepoBD Handover

## Current state

RepoBD is at pre-implementation / requirements-definition stage.

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

## Next step

Complete and review the initial authoritative documentation. Do not scaffold Worker/D1/CLI until the user has reviewed the requirements set.
