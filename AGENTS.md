# RepoBD Agent Guide

RepoBD is a lightweight secret handoff tool. Its core promise is simple: **make it easy to pass a secret and hard to apply it to the wrong repository.**

## Priority order

1. Security correctness
2. Product-scope correctness
3. Data-loss avoidance
4. Simplicity / YAGNI
5. Developer convenience

## Authoritative documents

- `docs/PRODUCT_CONCEPT.md` — product philosophy and positioning
- `docs/MVP_REQUIREMENTS.md` — v0.1 scope and behavior
- `docs/THREAT_MODEL.md` — what RepoBD does and does not defend against
- `docs/SECURITY_INVARIANTS.md` — non-negotiable security rules
- `docs/ARCHITECTURE.md` — technical architecture
- `docs/AI_WORKFLOW.md` — Herdr / Claude Code / Codex workflow
- `docs/TEST_STRATEGY.md` — required validation and adversarial tests
- `docs/BUILD_NATIVE_DEPENDENCY.md` — build vs native vs dependency decisions
- `HANDOVER.md` — current state and next work

## Read first

### Every new implementation session

1. `AGENTS.md`
2. `HANDOVER.md`
3. `docs/AI_WORKFLOW.md`
4. `docs/SECURITY_INVARIANTS.md`
5. The relevant section of `docs/MVP_REQUIREMENTS.md`

### Claude Code

Also read `CLAUDE.md`.

### Codex

Also read `CODEX_REVIEW.md` and review from the requested base commit/diff only unless a security boundary requires wider review.

## Never

- Never send plaintext secret content to the server.
- Never send the decryption key to the server.
- Never log, print, persist, or expose plaintext secret content unnecessarily.
- Never invent cryptography.
- Never auto-commit, auto-push, auto-merge, or auto-deploy.
- Never execute arbitrary commands after applying a secret.
- Never write outside explicitly allowed targets.
- Never follow symlinks for secret writes.
- Never turn RepoBD into a full Secret Manager, enterprise IAM product, vault, or team-management platform without explicit product approval.
- Never weaken a security invariant for convenience.

## Ponytail / YAGNI development ladder

Before implementing code, stop at the first rung that works:

1. Does this need to exist at all?
2. Does RepoBD already have an implementation or pattern that can be reused?
3. Does the standard library already solve it?
4. Does the native platform already solve it? (Web Crypto, Git CLI, Cloudflare Workers/D1, Node APIs)
5. Does an already-installed dependency solve it?
6. Is a mature dependency safer and smaller than custom code?
7. Only then write the minimum implementation that works.

Security validation, error handling that prevents data loss, trust-boundary checks, and adversarial tests are never targets for simplification.

## Scope discipline

RepoBD v0.1 is **Secret Transport + Repository Context Binding**, not a Secret Manager.

Do not add without explicit approval:

- user accounts
- teams / organizations
- RBAC
- audit dashboards
- billing
- secret rotation
- SSO / SCIM
- GitHub App writes
- GitLab App writes
- MCP
- IDE plugins
- AI-specific secret broker features
- automatic cloud-provider integrations
- file uploads

## Git policy

Git is used to identify the current repository, not to mutate it.

Allowed purpose:

- detect whether the current directory is a Git repository
- read `origin`
- normalize supported remote URL forms

RepoBD itself must not commit, push, merge, create PRs, or modify Git configuration.

## Approval policy

User approval is required before:

- commit
- push
- deploy
- production Cloudflare resource changes
- schema/migration application to production
- npm publish
- any change that alters a security invariant or threat-model boundary

## Product principle

**Automate only what RepoBD can determine reliably. Never replace human uncertainty with machine guesswork.**
