# RepoBD Architecture (Initial)

## Overview

RepoBD v0.1 should remain a small system with one repository and one public domain.

```text
Browser / Sender
  ↓ client-side encryption
Cloudflare Worker API
  ↓ ciphertext + metadata only
Cloudflare D1

Receiver CLI
  ↓ parse delivery link locally
local repo verification
  ↓ exact match only
fetch ciphertext (claim)
  ↓ local decrypt
safe local write
  ↓ verified success
consume / invalidate
```

Repository verification precedes the network. A mismatch, an unreadable
binding, or an unsupported local repository ends the run before a claim token
is submitted or any ciphertext is fetched.

## Components

### Web — NOT IMPLEMENTED; Phase 5

No web surface exists. Whether one is part of the MVP at all is an open Phase 5
question, not a settled requirement.

Recorded as the original sketch, should a web surface be chosen:

- minimal product/landing page
- send form
- client-side encryption
- delivery URL generation

Whether environment metadata is added before the eventual v0.1 release is a
Phase 5 question this document does not decide; the current implementation
carries no such channel. The receiver's target is settled, not deferred: v0.1
always applies to `.env` at the verified work-tree root, and a sender-selected
target is a future / post-v0.1 possibility at most, not a Phase 5 decision
within v0.1. If a web surface is built, the landing page and product UI should
live in the same project rather than a separate repository.

### Worker API

Responsibilities:

- accept ciphertext and approved non-secret metadata
- enforce request/payload limits
- create delivery records
- hand the stored envelope to a caller holding a valid claim
- take, renew and release claim leases
- perform atomic consume/invalidation
- enforce expiry
- expose no plaintext handling path

Implemented endpoints:

```text
GET  /health
POST /api/secrets
POST /api/secrets/:id/claim
POST /api/secrets/:id/consume
POST /api/secrets/:id/release
```

There is no `GET /api/secrets/:id`. The envelope is returned by `claim`, which
takes a lease at the same time — reading and holding are one step, so a
delivery cannot be fetched without also being claimed. A successful claim also
reports `lease_remaining_ms`, measured on the server's clock, so a receiver
never compares a server timestamp against its own.

Claiming is idempotent for the same token and doubles as lease renewal.
Consume and release are idempotent in the same way, so a lost response followed
by a retry is indistinguishable from a first success.

### D1

Initial record needs are small and short-lived.

Likely fields:

- id
- ciphertext (encrypted envelope)
- expires_at
- consumed_at / state
- claim state
- created_at

**Repository identity is not one of them.** The binding travels in the delivery
link's fragment and is never transmitted, so no table column, request payload,
server log, or server-side state holds it.

### CLI

Responsibilities:

- `send` launcher/workflow
- `pull` workflow
- parse the delivery link locally
- read current Git repo / origin
- normalize repository identity
- compare with the binding, before any network access
- local decrypt
- validate exactly one KEY=value
- inspect the target file and state the intended change, naming the key only
- confirm with the user only when an existing different value would be replaced
- confirm claim ownership with the server immediately before writing
- safe write, then read back to verify
- request consume only after verified success

The CLI must not mutate Git or execute arbitrary follow-up commands.

## Delivery link

```text
https://<repobd-host>/d/<secret-id>#k=<key>&b=<binding-json>
```

Everything before the `#` is what a request may be addressed to. Everything
after it is client-side only: an HTTP client never transmits a fragment, so
the decryption key and the repository binding stay on the two developers'
machines.

The binding is `{"bv":1,"repo":"<host>/<path>"}` — a version and a canonical
repository identity, nothing more. It is **not signed and not bound to the
ciphertext**: whoever holds the link can rewrite it, and already holds the key.
It prevents the accident, not the attacker.

The fragment grammar is exact: one `k`, one `b`, no repeated fields and no
unknown fields. First-value-wins is deliberately not used — a link carrying two
bindings would read as one repository and bind to another. The secret id must
satisfy the same canonical capability grammar the Worker enforces (22
characters, canonical base64url, no padding), checked locally.

Parsing is local and fails closed: non-HTTPS links, embedded credentials, an
unexpected query, a malformed path or secret id, a missing or invalid key, a
duplicated or unknown fragment field, and a missing, malformed, or
unknown-version binding all block. A missing binding is never treated as an
unbound delivery.

The link is **read from stdin at a prompt, never taken as a command-line
argument** — argv is retained by shell history and visible in process
listings, and the fragment carries the decryption key.

If a link is supplied on the command line anyway, RepoBD must not reflect it
back. All CLI diagnostics pass through one redacting boundary
(`src/cli/diagnostics.ts`) installed on the argument parser before any command
is defined, so every command inherits it. The rule is an allowlist: RepoBD's
own command and option names print normally, and every other argv token — plus
the value half of any `--opt=value` — is replaced with `<redacted>`. Tokens are
never parsed or validated to decide this, so malformed input redacts as
reliably as well-formed input. `repobd pull <link>` additionally gets a
friendlier fixed message, which is UX rather than the boundary.

Scope: this stops *RepoBD* from echoing the link. It does not stop the shell
from recording a link that was typed as an argument — that value is already in
shell history and process listings before RepoBD runs, which is why the
supported flow is the prompt.

## Repository identity

Git CLI, read-only, four commands: `rev-parse --is-inside-work-tree`, the
configured `remote.origin.url` values via `config -z --get-all`, the effective
`remote get-url origin`, and `rev-parse --show-toplevel` for the work tree
root. The exact list is pinned in `GIT_COMMANDS` in `src/repo/git.ts` and
asserted by test, so a fifth command cannot appear without a deliberate change.
`.git/config` is not parsed by hand and `insteadOf` rewriting is left to Git.
RepoBD never mutates Git.

Repository-selection environment variables are stripped from the child
process, so an inherited `GIT_DIR` cannot redirect the answer — including the
work tree root, which is where a secret would be written.

The effective origin URL is used exactly as Git returns it, minus the single
terminal line ending Git frames its output with. Only that one LF is removed:
a pathname or URL that still carries a CR or LF is malformed and fails closed
rather than being normalized into a different value. Surrounding whitespace is
never trimmed into validity.

Canonical identity is `<lowercase-host>/<case-preserved-path>`. Supported
hosted profiles in v0.1 are **github.com, gitlab.com, and bitbucket.org**; the
common HTTPS, scp-like SSH, and `ssh://` clone spellings of one repository
normalize to the same identity. Everything else — self-hosted servers,
arbitrary SSH targets, `git://`, plain HTTP, non-default ports — **fails
closed as unsupported**, as does a repository with no `origin` or with more
than one configured origin URL.

Comparison is exact and case-sensitive. Folder name and absolute filesystem
path are never repository identity.

## Environment

**Current implementation: no environment metadata channel exists** — the
delivery record carries ciphertext, TTL and lifecycle state and nothing else.
Whether one is added before the eventual v0.1 release is an open Phase 5
question; this document does not decide it. If it is added later it is display
and confirmation metadata, never a machine identity.

Do not introduce unreliable local environment auto-detection simply to claim
full context automation.

## Secret mapping

**Not part of v0.1.** The payload carries its own variable name, so there is
nothing to infer, and RepoBD inspects no repository facts to guess a target.

Recorded as future options only, should a later phase ever deliver a bare value
with no key: `.env.example`, `.env.sample`, `.env.template`, `process.env.*`,
`import.meta.env.*`. Any such mechanism stays local — no repository upload, no
server-side code analysis, no AI inference.

## Safe apply

The only path RepoBD writes is `.env` at the verified work tree root, composed
from the root that repository resolution returned and never from a caller.

`src/apply/payload.ts` holds the `KEY=value` grammar; `src/apply/env-file.ts`
recognizes a conservative single-line subset of `.env` as an allowlist and
refuses anything outside it; `src/apply/target.ts` is the only code in RepoBD
that writes a secret anywhere.

The two share one value alphabet, which is what makes the round trip a property
rather than a hope: anything RepoBD writes, RepoBD reads back with the same key
and literal value, so a successful apply can never leave a file its own retry
refuses.

RepoBD writes dotenv-style assignments and does not guarantee equivalent
behaviour when a `.env` file is executed as shell code.

## Cloudflare

Target infrastructure:

- Registrar / DNS: Cloudflare
- Web/API: Cloudflare Workers / static assets as appropriate
- DB: D1
- abuse controls: Cloudflare rate limiting / WAF where appropriate
- email receipt: Cloudflare Email Routing

Keep Worker permissions and bindings minimal.

## Deployment philosophy

Minimize the number of deployable surfaces. A small number of components reduces attack surface and operational ambiguity.
