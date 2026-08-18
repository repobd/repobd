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

- Claude Code: plan, implement (within an approved cycle), test, send the
  working tree to Codex. Goes idle the moment the review request is sent —
  no repository work and no polling for the result — until that review
  finishes or is explicitly cancelled, and does not edit files in response
  to a Codex finding, of any severity, without a new, explicit user
  authorization.
- Codex: independent read-only review, adversarial/security review, scope
  and dependency review. Never edits or repairs files, and never inspects
  this repository while Claude Code is active — read-only investigation
  still counts as active work, and no user request makes it concurrent.
  Claude Code must go idle first.
- Test terminal: run tests/typecheck/security-negative cases (no lint tool is installed; see `docs/TEST_STRATEGY.md`).
- Runtime terminal: `wrangler dev`, local Worker/D1 runtime, local logs.
- User: approves important design decisions, commit, push, deploy, npm
  publish, security-boundary changes, and every write cycle that follows a
  Codex review result. See the "Human authorization gate" in
  `docs/AI_WORKFLOW.md`.

## Herdr automation boundary

Only one AI agent works on this repository at a time:

```text
CC ACTIVE / Codex IDLE → CC IDLE / Codex ACTIVE → both IDLE
  → (explicit user authorization) → CC ACTIVE / Codex IDLE
```

`CC ACTIVE / Codex ACTIVE` must never occur for this worktree, and no user
approval can authorize it. Read-only inspection counts as active work.
Panes may stay open; the inactive agent simply does no repository work.

Herdr automates exactly one cross-agent transition — the review handoff:

```text
herdr agent list                      # resolve the reviewer at runtime
herdr agent prompt <target> <text>    # submits text + Enter, invoking a turn
```

Resolve the target by agent kind; pane ids are not stable across sessions,
so never hardcode one, and note an agent's `cwd` may be its session's start
directory rather than the repository. `--timeout` requires `--wait`, and
both govern the sender's wait only — submission has already happened, so a
sender-side timeout does not mean the prompt failed to arrive.

The result does not come back this way. Codex reports it in its own pane
and the user carries it onward:

```text
Codex result → user → GPT analysis → human decision → optional new CC cycle
```

Claude Code never polls for it.

Herdr may automatically chain: Claude Code's approved implementation →
validation → review request to the designated Codex pane. The chain stops
there.

Two transitions are never automatic:

- review request → any further Claude Code activity. Claude Code is idle
  for as long as the review is outstanding, and does not poll for or fetch
  the result ("Single active agent per repository", "Review wait gate").
- Codex result → Claude Code repair. A human authorizes that transition
  every time ("Human authorization gate").

All are defined in `docs/AI_WORKFLOW.md`.

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
