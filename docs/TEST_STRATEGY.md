# RepoBD Test Strategy

## Principle

RepoBD must prove not only that correct operations succeed, but that incorrect operations reliably do nothing unsafe.

Negative and adversarial tests are first-class requirements.

## Test layers

### Unit tests

Target pure logic such as:

- repository URL canonicalization across supported clone spellings
- repository match/mismatch, exact and case-sensitive
- delivery link and fragment grammar
- payload grammar: exactly one `KEY=value`, and the safe value alphabet
- the supported `.env` subset, and what it refuses as ambiguous
- line-style and BOM detection
- TTL and lease evaluation
- payload-size validation

The target is fixed at `.env` in the verified work tree root and is composed
rather than accepted, so there is no allowlist to test and no user-supplied
path for traversal to occur in. What is tested instead is that the root comes
from repository resolution — a nested subdirectory and a linked worktree both
resolve correctly — and that a pathname RepoBD cannot read fails closed rather
than being normalized into a sibling.

Variable and target mapping are not part of v0.1 (see `MVP_REQUIREMENTS.md`
§6), so there are no mapping tests.

### Worker/API tests

Use Cloudflare's Vitest integration where possible.

Target:

- create
- claim, which both takes the lease and returns the envelope
- claim renewal with the same token, and the reported remaining lease
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

- Alpha secret → Alpha repo → apply succeeds → delivery consumed
- target file absent → created → consumed
- target key already present with the same value → no write → consumed
- target key present with a different value → confirmation → replace → consumed

### Repository safety

- Alpha secret → Beta repo → BLOCK
- no Git repo → BLOCK
- no `origin`, an unsupported host, or more than one origin URL → BLOCK. The
  binding cannot be established, so nothing is claimed, retrieved or written.
- SSH/HTTPS forms of same remote → MATCH after normalization

### Lifecycle

- expired → BLOCK
- consumed → BLOCK
- successful pull → second pull BLOCK
- cancellation before apply → not consumed; claim released where possible
- repository mismatch → not consumed, and never claimed
- local write failure → not consumed; claim released where possible
- ownership refresh unreachable → not consumed, not written, and **not**
  released, because the holder is unknown; the lease expiring is the fallback
- consume transport unreachable after a verified write → one direct idempotent
  retry, no second `.env` write, and the apply is reported as done even when
  consumption cannot be confirmed
- consume reports a claim conflict after a verified write → one same-token
  claim renewal, then one consume retry; no second `.env` write, no repeated
  renewal loop, and this path never chains into the unreachable-consume retry
  above

### Concurrency

- two simultaneous pull/consume attempts → at most one succeeds

### File safety

- symlink target → BLOCK
- directory / FIFO / special file target → BLOCK
- ambiguous or unsupported target-file syntax → no write, no consume
- duplicate active target key → no write, no consume
- multiline target value → no write, no consume
- same-line compound syntax → no write, no consume
- existing different value → confirmation required
- target changed after approval → approval invalid, no write
- permission denied → no consume and no secret output

### Payload

- exactly one KEY=value → accepted
- more than one assignment → BLOCK
- value outside the safe character set → BLOCK

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
