# RepoBD AI Development Workflow

## Purpose

Define how RepoBD is developed in Herdr with clear role separation and minimal ambiguity.

## Roles

### Claude Code

Primary implementer.

Default model: Sonnet 5.

Responsibilities:

- implementation plan
- small scoped changes
- local validation
- fixes based on review

Escalate to Opus 5 for cryptographic flow, trust-boundary changes, consume/race behavior, safe filesystem writes, or unresolved blocker/major findings.

### Codex

Independent read-only reviewer.

Default model: gpt-5.6-sol.
Default effort: High.

Use maximum available effort for cryptography, plaintext-exposure paths, one-time consumption, filesystem boundary changes, repository identity, concurrency, and abuse/security-boundary changes.

### User

Approves:

- significant implementation plan changes
- security-boundary changes
- commit
- push
- deploy
- npm publish
- production Cloudflare changes

## Herdr layout

```text
Claude Code        | Codex
implementation     | read-only review
-------------------+-------------------
Test terminal      | Runtime terminal
no AI required     | wrangler/dev
```

Do not parallelize multiple editing agents in the same worktree.

## Session bootstrap

Every new session reads the authoritative documents listed in `AGENTS.md` and `HERDR_BOOTSTRAP.md` before work begins.

Agents should read only the relevant requirement/design sections after the mandatory startup docs. Avoid rereading the entire repository/history without a reason.

## Implementation instruction template

```text
Current HEAD: <sha>
Purpose: <one sentence>
Authoritative references: <specific docs/sections>
Implementation scope: <files/functions/features>
Prohibited: <relevant prohibitions only>
Validation: <tests/typecheck/lint appropriate to this unit>
Stop point: <where to stop and report>
```

## Development ladder

Before adding code:

1. Is it required by v0.1?
2. Does equivalent code already exist?
3. Does stdlib solve it?
4. Does the native platform solve it?
5. Does an installed dependency solve it?
6. Would a mature dependency be safer than custom code?
7. Only then implement the smallest correct change.

See `BUILD_NATIVE_DEPENDENCY.md`.

## Validation stages

### During implementation

- targeted tests
- typecheck where applicable

### Before Codex review

- targeted tests
- lint
- relevant negative/security tests

### Before commit

- full test suite
- typecheck
- lint
- build
- `git diff --check`
- review changed files for accidental secret/debug output

Documentation-only changes do not require the full application test suite, but still require content/link review and `git diff --check`.

## Review cycle

1. Claude Code proposes plan.
2. User confirms when required.
3. Claude Code implements a small unit.
4. Validation runs.
5. Codex performs independent read-only review.
6. Claude Code addresses blocker/major findings.
7. Codex performs final confirmation.
8. User approves commit/push/deploy as applicable.

Commit gate: blocker 0 / major 0.

## Security-sensitive changes

Any change touching `SECURITY_INVARIANTS.md` requires expanded review. Do not trade away validation/error handling merely to reduce line count.
