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
- `docs/IMPLEMENTATION_PLAN.md` — phase sequence and implementation status
- `docs/AI_WORKFLOW.md` — Herdr / Claude Code / Codex workflow
- `docs/TEST_STRATEGY.md` — required validation and adversarial tests
- `docs/BUILD_NATIVE_DEPENDENCY.md` — build vs native vs dependency decisions
- `HANDOVER.md` — current state and next work

## Bootstrap and document routing

This is the single, canonical definition of what to read and when. No other
file defines a competing read order; other files link here instead. If a
summary elsewhere (README, HANDOVER, an agent guide) disagrees with an
authoritative document, the authoritative document wins.

### Tier 0 — auto-loaded agent-specific policy

- **Claude Code:** `CLAUDE.md` is auto-loaded by Claude Code's project
  instructions in this environment. Do not schedule a separate explicit
  re-read of it.
- **Codex:** read `CODEX_REVIEW.md` explicitly at session start — this
  environment does not guarantee it is auto-loaded — and review from the
  requested base commit/diff only unless a security boundary requires wider
  review.

### Tier 1 — every repository work session

1. `AGENTS.md` (this file) — priority, universal prohibitions, this routing.
2. `HANDOVER.md` — current checkpoint, current phase, unresolved items,
   current/next task.

### Tier 2 — task-routed authoritative documents

Read the document(s) the current task actually needs, and only the relevant
sections where practical. Not every authority is read every session.

| Task type                          | Authority                          |
|-------------------------------------|-------------------------------------|
| Current repo state                  | `HANDOVER.md`                      |
| Product behavior / v0.1 scope       | `docs/MVP_REQUIREMENTS.md`         |
| Security invariant                  | `docs/SECURITY_INVARIANTS.md`      |
| Threat / protection boundary        | `docs/THREAT_MODEL.md`             |
| Architecture / component boundary   | `docs/ARCHITECTURE.md`             |
| Phase planning / status             | `docs/IMPLEMENTATION_PLAN.md`      |
| Review / handoff / authorization    | `docs/AI_WORKFLOW.md`              |
| Test design / validation            | `docs/TEST_STRATEGY.md`            |
| Dependency / native decision        | `docs/BUILD_NATIVE_DEPENDENCY.md`  |

`docs/IMPLEMENTATION_PLAN.md` is on-demand: read it for phase planning, phase
status, implementation sequence, or next-phase planning, not for every task.

`docs/AI_WORKFLOW.md` opens with a concise normative-gates section; that
section — not the full document — is the normal bootstrap target for review,
handoff, and authorization questions. Read the detailed sections below it
only for a contested or unusual workflow case.

### Tier 3 — human/reference

- `README.md`
- `docs/REVIEW_GUIDE_JA.md` — historical Japanese reference, not
  authoritative; see its own header for the current authority map.

Read Tier 3 documents only when the task specifically concerns them.

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
- any file edit made in response to a Codex review finding, regardless of
  severity (BLOCKER, MAJOR, MINOR, or NIT) — see the "Human authorization
  gate" in `docs/AI_WORKFLOW.md`

Only one AI agent performs repository work at a time, and no user approval
overrides that — read-only inspection and investigation count as active
work, so a concurrent Codex investigation is not permissible while Claude
Code is active. While a Codex review is outstanding, Claude Code is idle:
file edits are prohibited outright rather than merely gated on approval, and
so is any other repository work, including polling the reviewer for its
result. Codex reports its result in its own pane, for the user — not to
Claude Code. Requesting review closes the implementation portion of that
write cycle; the review must first complete or be explicitly cancelled, and
any further work needs a fresh, explicitly authorized cycle. See "Single
active agent per repository" and the "Review wait gate" in
`docs/AI_WORKFLOW.md`.

## Product principle

**Automate only what RepoBD can determine reliably. Never replace human uncertainty with machine guesswork.**
