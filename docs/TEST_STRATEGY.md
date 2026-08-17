# RepoBD Test Strategy

## Principle

RepoBD must prove not only that correct operations succeed, but that incorrect operations reliably do nothing unsafe.

Negative and adversarial tests are first-class requirements.

## Test layers

### Unit tests

Target pure logic such as:

- repository URL normalization
- repository match/mismatch
- TTL evaluation
- target allowlist rules
- path normalization / traversal rejection
- `.env` key parsing/mapping logic
- payload-size validation

### Worker/API tests

Use Cloudflare's Vitest integration where possible.

Target:

- create
- fetch
- expiry
- consume
- already-consumed behavior
- atomic/concurrent consume
- invalid identifiers/tokens
- rate/payload boundary behavior where locally testable

### CLI integration tests

Use dedicated fixture repositories only.

Suggested fixtures:

- `test-alpha`
- `test-beta`

Use dummy secrets only, for example:

```env
API_KEY=TEST_ALPHA_123456
```

Never test MVP behavior using production BQmenu, Rescue Pet Card, or real production credentials.

## Required acceptance cases

### Positive

- Alpha secret → Alpha repo → success
- `.env` payload → confirmed allowed target → success
- single API key → evidenced/specified variable mapping → success

### Repository safety

- Alpha secret → Beta repo → BLOCK
- no Git repo → BLOCK
- no origin → BLOCK or explicit unsupported flow (v0.1 decision)
- SSH/HTTPS forms of same remote → MATCH after normalization

### Lifecycle

- expired → BLOCK
- consumed → BLOCK
- successful pull → second pull BLOCK
- cancellation before apply → secret remains available
- repository mismatch → secret remains available
- local write failure → secret remains available

### Concurrency

- two simultaneous pull/consume attempts → at most one succeeds

### File safety

- path traversal → BLOCK
- symlink target → BLOCK
- `.git/**` target → BLOCK
- unsupported file target → BLOCK
- existing value → confirmation required
- permission denied → no consume and no secret output

### Crypto/input

- wrong decryption material → decrypt/authentication failure
- malformed ciphertext → BLOCK
- tampered ciphertext → authenticated decryption fails
- plaintext payload > 64 KiB → reject

### Secret exposure

Tests/review must confirm that dummy secret values do not appear in:

- stdout
- stderr except intentionally masked/non-secret metadata
- Worker logs
- test snapshots
- HTTP error bodies
- normal telemetry

## Test terminals

Herdr Pane 3 is a plain test terminal. No permanent AI agent is required there.

## Commit gate

Before commit:

- full tests pass
- typecheck passes
- build passes
- `git diff --check` passes
- Codex blocker = 0
- Codex major = 0

No lint tool is installed for RepoBD; do not add one merely to satisfy this
document (YAGNI, see `docs/BUILD_NATIVE_DEPENDENCY.md`). Add lint only when a
demonstrated need justifies the dependency.

Security-sensitive changes require the relevant adversarial test group even when the normal happy-path tests pass.
