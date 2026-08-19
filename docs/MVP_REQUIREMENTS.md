# RepoBD MVP Requirements (v0.1)

## 1. Goal

Deliver encrypted secret text to the intended repository with minimal friction and block accidental application to a different repository.

## 2. Primary user flow

### Sender

1. Run a RepoBD send command or open the RepoBD send page.
2. Enter secret text (API key, `.env` content, password, or other short plaintext).
3. Specify intended repository.
4. Optionally specify environment metadata and intended target.
5. Choose TTL.
6. Browser/client encrypts the payload locally.
7. Server stores ciphertext and non-secret metadata.
8. RepoBD returns a short-lived delivery URL containing/pointing to the client-side decryption material in a form that is not sent to the server.

### Receiver

1. Run `repobd pull` / `npx repobd pull` from the intended local repository.
2. Paste the RepoBD delivery URL into the CLI prompt, not an AI chat.
3. CLI parses the delivery link and validates its repository binding locally.
4. CLI detects current Git repository and reads `origin`.
5. CLI normalizes and compares repository identity, before contacting the service.
6. Repository mismatch => hard block, no network retrieval, no write, no consume.
7. Repository match => fetch ciphertext, then show environment metadata, target, and any locally-derived mapping suggestions.
8. User confirms apply.
9. CLI decrypts locally and performs a safe write.
10. CLI verifies successful write.
11. Only then mark/consume the remote secret.

RepoBD performs no commit, push, merge, deployment, package install, or arbitrary command execution after apply.

## 3. Payload

- Plaintext text only.
- Maximum plaintext payload size: **64 KiB**.
- No file upload in v0.1.
- Core transport should not be hard-coded to `.env` only.
- Product UX should remain developer-secret focused in v0.1.

## 4. Repository binding

### Required

- Receiver must be inside a Git repository work tree.
- v0.1 repository identity is derived from the `origin` remote.
- Supported hosted profiles are **github.com, gitlab.com, and bitbucket.org**. Their common HTTPS, scp-like SSH, and `ssh://` clone forms normalize to the same identity.
- Folder name and absolute filesystem path are not repository identity.
- Branch is ignored for v0.1.
- Comparison is exact and case-sensitive.
- The binding travels in the delivery link's fragment. The server never receives repository identity.
- The delivery link is read from a terminal prompt on stdin, never as a command-line argument, so it does not reach shell history or process listings.
- The fragment grammar is exact: one `k`, one `b`, no repeated and no unknown fields.
- The repository check completes **before** any network secret retrieval. A mismatch submits no claim, fetches no ciphertext, and consumes nothing.
- A missing, malformed, or unknown-version binding blocks. There is no unbound delivery mode.

### Fails closed

These block rather than being resolved by guesswork:

- unsupported or self-hosted origin host
- no `origin` remote
- more than one configured `origin` URL
- non-default port, `git://`, plain HTTP, or an arbitrary SSH target
- an origin URL RepoBD cannot canonicalize, including one carrying credentials
- an origin URL with leading or trailing whitespace, which is never trimmed into validity
- a bare repository or a directory with no work tree
- a delivery link with a repeated or unknown fragment field, or a secret id that is not a canonical capability

### Out of scope for v0.1

- malicious local user deliberately rewriting Git configuration
- deliberate rewriting of the unsigned binding in the delivery link
- proving repository authenticity cryptographically
- a compromised OS, a modified local Git, or a modified RepoBD CLI
- GitHub/GitLab account authentication as a condition of pull
- branch-specific binding
- generic/self-hosted Git support

## 5. Environment handling

Environment is metadata, not a hard machine identity in v0.1.

Reason: there is no universal reliable standard local fact for `development`, `staging`, `preview`, or `production`.

Requirements:

- sender may provide environment metadata
- receiver sees it prominently before apply
- RepoBD must not claim automatic environment certainty unless backed by an explicit future mechanism
- production-like labels may receive stronger visual confirmation

Do not create persistent environment auto-binding in v0.1 solely to simulate certainty.

## 6. Target and variable mapping

RepoBD may locally inspect repository facts to suggest where a secret belongs.

Preferred evidence sources:

1. `.env.example`
2. `.env.sample`
3. `.env.template`
4. direct references such as `process.env.NAME`
5. direct references such as `import.meta.env.NAME`
6. explicitly supported configuration files

Rules:

- repository inspection happens locally
- repository content is not uploaded for analysis
- a suggestion must be labeled as a suggestion unless directly evidenced
- if no reliable mapping is found, ask the receiver for the variable name/target
- if the user rejects a suggestion, allow correction in the same flow; do not simply restart with the same suggestion
- `.env`-formatted payload preserves supplied variable names
- replacing an existing value requires confirmation

## 7. Safe write

Initial allowed targets may include:

- `.env`
- `.env.local`
- `.env.development`
- `.env.preview`
- `.env.staging`
- `.env.production`

Requirements:

- reject path traversal
- reject target outside allowed repository scope
- reject symlink targets
- reject `.git/**`
- reject executable/script targets
- do not rewrite unrelated files
- do not print secret values

Exact allowlist may be refined before implementation.

## 8. One-time and TTL behavior

- v0.1 default is one successful consume.
- expired secret cannot be applied.
- second successful pull cannot occur.
- mismatch does not consume the secret.
- cancellation before apply does not consume the secret.
- operational failure before successful verified write does not consume the secret.
- successful verified write is followed by consume/invalidation.
- concurrent pulls must not both succeed.

Future multi-recipient / N-pull support is not part of v0.1.

## 9. Error behavior

Principle:

> **Fail closed locally, retry safely remotely.**

On error:

- perform no unsafe write
- discard local plaintext/temp state as far as practical
- reveal no plaintext in error messages or logs
- preserve the remote ciphertext when no successful apply occurred, except expiry/explicit invalidation/already-consumed conditions

Errors to test include:

- not a Git repo
- no `origin`
- repository mismatch
- malformed URL/token
- expired secret
- already consumed
- decrypt/authentication failure
- payload too large
- invalid target
- path traversal
- symlink target
- existing value
- permission denied
- interrupted write
- network failure
- concurrent consume

## 10. Encryption and server visibility

- client-side encryption only
- use standard native cryptographic primitives
- no custom cryptography
- server stores ciphertext only
- server must never receive the decryption key
- server must never decrypt, inspect, log, or persist plaintext secret content

See `SECURITY_INVARIANTS.md`.

## 11. Backend / infrastructure

MVP target:

- Cloudflare-managed domain/DNS
- Cloudflare Workers
- Cloudflare D1
- Cloudflare rate limiting / WAF where appropriate
- no Supabase dependency for v0.1

Backend access pattern is expected to be many users with low per-user frequency and short-lived records.

## 12. Abuse controls

- max plaintext payload: 64 KiB (enforce corresponding encrypted request limits appropriately)
- short TTL options with a defined maximum
- request/rate limits for create/fetch/consume endpoints
- no public secret directory/search
- no permanent storage mode
- no file hosting
- ability to invalidate a delivery by server-side identifier when responding to service-level abuse reports
- content inspection is prohibited as an abuse-control dependency

## 13. Accounts and teams

Not in v0.1:

- account creation
- login
- team membership
- org management
- RBAC
- SSO
- audit dashboard
- billing

The lightweight handoff model should cover early multi-person use without becoming an enterprise management platform.

## 14. CLI

Initial public command surface should remain small.

Likely commands:

- `repobd send`
- `repobd pull`

Additional commands require demonstrated need.

CLI should be usable through npm/npx.

## 15. MVP acceptance criteria

MVP is functionally complete when all of these are true:

- correct repo + confirmed target => apply succeeds
- wrong repo => hard block
- expired => block
- already consumed => block
- second successful pull => block
- server never sees plaintext
- server never sees decryption key
- secret never appears in normal stdout/log output
- safe target rules hold
- traversal and symlink tests block
- operational failure does not consume before successful apply
- concurrent pulls cannot both consume successfully
- 64 KiB limit enforced
- required negative/security tests pass
