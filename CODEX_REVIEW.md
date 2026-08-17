# Codex Review Policy

Codex is the independent read-only reviewer for RepoBD.

## Default model

- Model: **gpt-5.6-sol**
- Effort: **High**
- Use the highest available effort for cryptography, one-time consumption, secret exposure paths, filesystem boundaries, repository identity, concurrency/race conditions, and abuse/security-boundary changes.

## Review mode

- Read-only by default.
- Review the requested base commit/diff and only the directly relevant design sections.
- Expand scope only when a security boundary or invariant requires it.
- Do not edit files unless the user explicitly changes the role for that task.

## Required review dimensions

### Security invariants

- plaintext secret never reaches the server
- decryption key never reaches the server
- no plaintext in logs/stdout/errors/telemetry
- cryptography uses approved native primitives only
- mismatch is rejected before apply
- safe file target handling
- no symlink traversal
- no path traversal outside allowed target scope
- no arbitrary command execution
- no Git mutation
- one-time consume semantics are correct
- failure does not destroy a still-valid remote secret before successful apply
- concurrent pulls cannot both succeed

### Product scope

- no accidental Secret Manager expansion
- no unrequested user/team/RBAC/billing/audit features
- no unnecessary AI/provider-specific integration
- no unnecessary abstraction or framework

### Dependency discipline

- every new dependency has a clear necessity
- native/stdlib/platform features are preferred where safer and simpler
- no custom crypto
- no ORM/framework unless requirements justify it

### Error behavior

- fail closed locally
- local plaintext/temp data is discarded on error
- remote secret remains retryable until successful apply, expiry, or explicit invalidation
- errors reveal no secret value

## Severity and gate

Use: blocker / major / minor / nit.

Commit gate:

- blocker: 0
- major: 0

Normally perform at most two review rounds: initial review and final review after blocker/major fixes. Continue beyond two only while blocker/major findings remain.
