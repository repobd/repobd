# Claude Code Policy

Claude Code is the primary implementer for RepoBD.

## Default model

- Default: **Sonnet 5**
- Escalate to **Opus 5** only for security-sensitive or unusually complex work:
  - cryptographic flow
  - trust-boundary changes
  - one-time consume semantics
  - race/concurrency fixes
  - safe filesystem writes
  - path traversal / symlink handling
  - unresolved blocker/major findings from Codex

## Required behavior

Before implementation:

1. Read `AGENTS.md`.
2. Read `HANDOVER.md`.
3. Read `docs/AI_WORKFLOW.md`.
4. Read `docs/SECURITY_INVARIANTS.md`.
5. Read only the relevant sections of `docs/MVP_REQUIREMENTS.md` and architecture docs.
6. Propose a small implementation plan and stop for user confirmation when requested by workflow.

During implementation:

- Prefer the smallest correct diff.
- Reuse native platform capabilities and approved dependencies.
- Do not create abstractions, frameworks, provider integrations, or future-facing layers that are not required by the current task.
- Keep security checks explicit and testable.
- Do not read or print real secrets.

After implementation:

- Run only the validation appropriate to the current stage, as defined in `docs/AI_WORKFLOW.md`.
- Report changed files, tests run, known limitations, and stop point.
- Do not commit, push, deploy, or publish without explicit user approval.

Around a Codex review — two separate stops, both defined in
`docs/AI_WORKFLOW.md`:

- Finish the cycle's validation *before* requesting review, then send the
  completed working tree to the designated Codex reviewer.
- Once the request is sent, go idle. Not just "stop writing" — stop working
  on this repository entirely: no file edits, no other implementation task,
  no opportunistic fixes, no documentation edits, no starting the next
  phase, no further validation, and no polling — do not call `herdr agent
  read` to retrieve a pending result, do not run background waiting
  commands, do not use `/loop` or a delayed continuation. Results are
  pushed to you (`Codex → CC`), never pulled; if that delivery is
  unavailable the fallback is the user reading the Codex pane, never you
  polling. This is unconditional; user approval does not lift it. The
  review must first either finish or be explicitly cancelled; a cancelled
  review's later result is stale. ("Single active agent per repository",
  "Review wait gate")
- If a result is delivered to you, that is message delivery, not permission
  to resume. Receipt is not complete until you have actually read the
  delivered message and reported a concise, faithful summary to the user —
  counts, findings, gate status, and already-known unresolved items. That
  read-and-report step is communication only; it does not make you the
  active repository agent. Then stay idle: do not edit files, do not
  inspect files or diffs to plan a repair, do not prepare fixes, do not run
  validation, do not continue the workflow — at any severity, including
  NIT — until the user explicitly authorizes a new write cycle. ("Human
  authorization gate", "When receipt is complete")
- Do not schedule `/loop`, a delayed wakeup, or any other automatic
  continuation that would cause a file edit after a Codex result without an
  intervening human authorization.
