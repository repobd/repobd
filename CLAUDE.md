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

After a Codex review:

- Send the completed working tree to the designated Codex reviewer, read
  back the result, and report it to the user.
- Stop. Do not edit any file in response to a Codex finding — of any
  severity, including NIT — until the user explicitly authorizes the next
  write cycle. See the "Human authorization gate" in `docs/AI_WORKFLOW.md`.
- Do not schedule `/loop`, a delayed wakeup, or any other automatic
  continuation that would cause a file edit after a Codex result without an
  intervening human authorization.
