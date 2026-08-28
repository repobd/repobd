# RepoBD MVP Requirements (v0.1)

## 1. Goal

Deliver encrypted secret text to the intended repository with minimal friction and block accidental application to a different repository.

## 2. Primary user flow

### Sender — CLI implemented and released (v0.1.1)

`repobd send` accepts a secret, encrypts it locally, creates the delivery and
prints a usable link. The steps:

1. Run `repobd send` from the repository the secret belongs to. CLI only; a web
   send page is deferred post-v0.1.
2. The CLI resolves the service origin and this repository. Either failing
   stops the run before anything is typed.
3. The CLI prompts for `KEY` and then the value, as two separate stdin lines.
   The value is plain and unmasked in v0.1. Neither is ever a command-line
   argument.
4. The assignment is validated against the same grammar the receiver re-applies
   after decrypting — exactly one `KEY=value`, the existing payload grammar, no
   new one — before anything reaches the network.
5. TTL is fixed at 900 seconds. There is no flag, prompt or environment
   override.
6. The CLI generates a fresh key and encrypts locally.
7. The create request carries the ciphertext envelope and the TTL, and nothing
   else: no plaintext, no key, no repository identity.
8. The CLI prints one delivery link. Its fragment carries the key and the
   repository binding, which no HTTP client transmits.

Not part of v0.1: environment metadata, a web sender, a target selection, and
any TTL input surface. The receiver's target is settled: v0.1 always applies to
`.env` at the verified work-tree root. Any broader target is a future /
post-v0.1 possibility.

Service origin: `REPOBD_SERVER_URL` when set, otherwise the shipped production
default `https://api.repobd.com`. HTTPS is required, with one narrow
exception — plain HTTP is accepted only for a loopback development origin
(`localhost`, `127.0.0.1`, `[::1]`), reached through the `REPOBD_SERVER_URL`
override. There is no configuration file and no `--server` flag.

Fixed: client-side encryption only; the server never receives plaintext, the
key, or repository identity; the key and binding travel in the link fragment.

### Receiver

1. Run `repobd pull` / `npx repobd pull` from the intended local repository.
2. Paste the RepoBD delivery URL into the CLI prompt, not an AI chat.
3. CLI parses the delivery link and validates its repository binding locally.
4. CLI detects current Git repository and reads `origin`.
5. CLI normalizes and compares repository identity, before contacting the service.
6. Repository mismatch => hard block, no network retrieval, no write, no consume.
7. Repository match => claim the delivery and fetch the ciphertext.
8. CLI decrypts locally and validates that the payload is exactly one assignment.
9. CLI inspects the target file at the verified work tree root and states the intended change, naming the key and never the value.
10. CLI asks for confirmation only if an existing different value would be replaced.
11. CLI confirms with the server that it still holds the claim, immediately before writing.
12. CLI performs a safe write and reads the file back to verify it.
13. Only then mark/consume the remote secret.

RepoBD performs no commit, push, merge, deployment, package install, or arbitrary command execution after apply.

## 3. Payload

One delivery carries **exactly one assignment**:

```env
OPENAI_API_KEY=value
```

- Plaintext text only. No file upload in v0.1.
- Maximum plaintext payload size: **64 KiB**, enforced by the crypto layer.
- Exactly one `KEY=value`. A payload carrying several assignments **fails
  closed** — it is not split, and neither the first nor the last is chosen.
- Key: `[A-Za-z_][A-Za-z0-9_]*`.
- Value: one or more printable-ASCII characters, none of them whitespace and
  none of `"` `'` `\` `#` `$` backtick `;` `&` `|` `<` `>`. RepoBD writes values
  verbatim and adds no quoting, so a value that would not survive verbatim is
  refused rather than escaped.
- Not a dotenv document, not an arbitrary text bundle, not a general-purpose
  password or note transfer.

Known and intentional v0.1 limitation: values containing spaces, newlines,
quotes, `#`, `$`, `;` or `&` — a PEM block, a connection string with query
parameters — cannot be delivered.

Multi-assignment delivery is a possible future direction. It is not v0.1.

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

**Current implementation: no environment metadata channel exists.** The
delivery record carries the ciphertext, TTL and lifecycle state, and nothing
else. Repository identity is the only context RepoBD checks.

Environment metadata is **deferred post-v0.1**. The Phase 5A sender does not
offer it and no metadata channel is approved. If it is added later, these
constraints stand:

- environment is metadata, not a machine identity — there is no universal
  reliable local fact for `development`, `staging`, `preview` or `production`
- a sender may supply it; a receiver sees it before apply
- RepoBD must not claim automatic environment certainty without an explicit
  mechanism behind it
- production-like labels may warrant stronger visual confirmation

Do not create persistent environment auto-binding merely to simulate certainty.

## 6. Target and variable mapping

**Not implemented in v0.1, and not required.** The payload names its own
variable, so there is nothing to infer: the key travels inside the delivery and
the target is fixed. RepoBD reads no `.env.example`, greps for no
`process.env.NAME`, and makes no suggestion.

The variable name is taken verbatim from the payload, and replacing an existing
different value requires explicit confirmation (see §7).

If a later phase delivers a bare value with no key, mapping inference becomes
necessary and these constraints apply:

- repository inspection happens locally; repository content is never uploaded
- a suggestion must be labelled a suggestion unless directly evidenced
- with no reliable mapping, ask the receiver for the variable name
- a rejected suggestion must be correctable in the same flow, not re-offered

Evidence sources such as `.env.example`, `.env.sample`, `.env.template`,
`process.env.NAME` and `import.meta.env.NAME` are recorded here as future
options only.

## 7. Safe write

### Target

The only path RepoBD v0.1 may write:

```text
<verified Git work tree root>/.env
```

Not `.env.local`, `.env.development`, `.env.preview`, `.env.staging`,
`.env.production`, any other suffix, any relative path, any absolute path, or
any caller-selected file. The path is **constructed** from the verified root and
never accepted from a caller, so path traversal is structurally absent rather
than filtered.

The root comes from the repository resolution that passed the binding check —
never from the process's working directory. Running from a subdirectory writes
the root `.env`; running in a linked worktree writes that worktree's `.env`.

### Supported `.env` subset

RepoBD implements **no general dotenv parser**. It modifies an existing file
only when it can confidently read the one ordinary single-line assignment it
needs. The recognized subset is an allowlist:

- a blank line
- a full-line comment; a commented-out key such as `# API_KEY=old` is
  historical text, never an active assignment, and is never deleted or rewritten
- one assignment on one physical line, optionally `export`-prefixed, with
  space/tab spacing only, whose value is either a bare run of the payload
  character set or a simple single-line quoted run, optionally followed by a
  comment separated by at least one space or tab

Anything outside that subset is refused with **no write and no consume**:

- duplicate active target key
- a target value spanning more than one line
- several assignments on one physical line, whitespace- or punctuation-separated
- loader-dependent syntax
- exotic whitespace in a syntactic position
- quoting RepoBD does not read confidently
- any line whose structure it cannot resolve

RepoBD does not guess.

### Existing value

- key absent → append
- exactly one supported active assignment whose value is **literally identical**
  to the payload's → no write;
  this counts as a successful apply and the delivery is consumed, which is what
  lets a retry converge after a lost consume
- exactly one supported active assignment whose value **differs literally** →
  explicit human confirmation, naming the key and never a value. Approval is
  bound to the exact filesystem state inspected; if the file changes after the
  answer, the approval is invalid and nothing is written.

Comparison is **literal**, and deliberately so. RepoBD reads a supported quoted
assignment such as `KEY="abc"`, but it does not unquote, trim, or otherwise
reinterpret what it finds. A payload of `KEY=abc` against an existing
`KEY="abc"` is therefore a **different** value and asks for confirmation
rather than reporting a no-op.

That is conservative on purpose: deciding that two spellings of a secret are
the same secret is a judgement RepoBD should not make on someone's behalf, and
asking costs a keystroke while guessing wrong costs a silent mismatch. RepoBD
only ever writes the plain `KEY=value` form, so its own writes always compare
equal on a retry.

### File safety

- reject symlink targets, of any kind, pointing anywhere
- reject directories, FIFOs, sockets and device files
- never write `.git/**`, an executable, a script, or an unrelated project file
- never rewrite an unrelated line
- preserve the file's line endings, trailing-newline shape and UTF-8 BOM
- create a new file owner-only; never change an existing file's permissions
- a replacement preserves the original's uid, gid and POSIX mode, or fails
  closed. RepoBD does not claim to preserve ACLs, extended attributes or exotic
  filesystem metadata.
- never print a secret value

### Shell compatibility

RepoBD writes dotenv-style assignments. It guarantees its documented safe
subset and its own round trip: anything RepoBD writes, RepoBD reads back with
the same key and literal value. It does **not** guarantee equivalent behaviour
when a `.env` file is executed as shell code, including `source .env`.
Shell-source compatibility is outside v0.1.

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
- request/rate limits for the create, claim, consume, and release endpoints
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

- correct repo + one valid assignment => apply succeeds and the delivery is consumed
- wrong repo => hard block, with no claim and no secret retrieval
- payload carrying more than one assignment => block
- unsupported or ambiguous target-file syntax => no write, no consume
- existing same value => no write, apply succeeds, delivery consumed
- existing different value => explicit confirmation required, and the approval
  is invalid if the file changes after it
- expired => block
- already consumed => block
- second successful pull => block
- server never sees plaintext
- server never sees decryption key
- secret never appears in normal stdout/log output
- the only written path is the target file at the verified work tree root
- symlink and special-file targets block
- operational failure does not consume before successful apply
- concurrent pulls cannot both consume successfully
- 64 KiB limit enforced
- required negative/security tests pass
