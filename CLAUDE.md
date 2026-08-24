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

1. Read `AGENTS.md` — it owns bootstrap and document routing (mandatory
   per-session docs, and which authoritative document a given task routes
   to). Follow its routing rather than a separate read order.
2. Propose a small implementation plan and stop for user confirmation when requested by workflow.

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
  completed working tree to the designated Codex reviewer. Keep the review
  request itself detailed — it is what Codex reviews from — but report only
  the state transition to the user, e.g. "Implementation complete.
  Validation PASS. Codex review sent. Claude Code is IDLE." Do not replay
  implementation details, test descriptions, or the review prompt unless
  the user asks.
- Once the request is sent, go idle. Not just "stop writing" — stop working
  on this repository entirely: no file edits, no other implementation task,
  no opportunistic fixes, no documentation edits, no starting the next
  phase, no further validation, and no polling — do not call `herdr agent
  read` to retrieve a pending result, do not run background waiting
  commands, do not use `/loop` or a delayed continuation. The result is not
  coming to you: Codex reports it in its own pane and the user takes it
  from there. This is unconditional; user approval does not lift it. The
  review must first either finish or be explicitly cancelled; a cancelled
  review's later result is stale. ("Single active agent per repository",
  "Review wait gate")
- Your next cycle, if there is one, arrives as a fresh scoped prompt from
  the user. Do not expect or reconstruct the full review — you will be
  given the findings and scope that cycle needs. No finding of any
  severity, including NIT, justifies editing anything before that explicit
  authorization. ("Human authorization gate")
