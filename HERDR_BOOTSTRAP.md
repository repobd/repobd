# HERDR_BOOTSTRAP.md — RepoBD Herdr startup guide

## Repository

- Local path: `/Users/shinya/Desktop/repobd`
- GitHub: `repobd/repobd`
- Default branch: `main`

## Recommended pane layout

```text
┌────────────────────────┬────────────────────────┐
│ Claude Code             │ Codex                  │
│ Sonnet 5                │ gpt-5.6-sol / High     │
│ implementation          │ read-only review       │
├────────────────────────┼────────────────────────┤
│ Test terminal           │ Runtime terminal       │
│ no AI required          │ wrangler/dev server    │
└────────────────────────┴────────────────────────┘
```

## Claude Code initial read order

1. `AGENTS.md`
2. `CLAUDE.md`
3. `HANDOVER.md`
4. `docs/AI_WORKFLOW.md`
5. `docs/SECURITY_INVARIANTS.md`
6. relevant section of `docs/MVP_REQUIREMENTS.md`
7. relevant section of `docs/ARCHITECTURE.md`
8. `docs/BUILD_NATIVE_DEPENDENCY.md` when adding or replacing dependencies

## Codex initial read order

1. `AGENTS.md`
2. `CODEX_REVIEW.md`
3. `HANDOVER.md`
4. `docs/SECURITY_INVARIANTS.md`
5. `docs/THREAT_MODEL.md`
6. relevant section of `docs/MVP_REQUIREMENTS.md`
7. requested base commit/diff

## Role split

- Claude Code: plan, implement, test, respond to review findings.
- Codex: independent read-only review, adversarial/security review, scope and dependency review.
- Test terminal: run tests/typecheck/lint/security-negative cases.
- Runtime terminal: `wrangler dev`, local Worker/D1 runtime, local logs.
- User: approves important design decisions, commit, push, deploy, npm publish, and security-boundary changes.

## Model escalation

Claude Code defaults to Sonnet 5. Use Opus 5 for cryptographic flow, trust-boundary changes, consume/race behavior, safe filesystem writes, or unresolved blocker/major findings.

Codex defaults to gpt-5.6-sol with High effort. Use maximum available effort for cryptography, plaintext-exposure paths, one-time consumption, filesystem boundaries, repo identity, concurrency, and abuse/security-boundary changes.

## Concurrency rule

Do not run multiple editing agents against the same worktree. RepoBD is small and security invariants cross component boundaries; parallelize implementation/review/testing/runtime, not independent feature implementation.

## Stop points

Every implementation instruction should include:

```text
Current HEAD:
Purpose:
Authoritative references:
Implementation scope:
Prohibited:
Validation:
Stop point:
```

Do not proceed past the declared stop point without user approval when approval is required.
