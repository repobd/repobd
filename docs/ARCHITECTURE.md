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

### Web

Responsibilities:

- minimal product/landing page
- secret send form
- repository/environment/target/TTL metadata input
- client-side encryption
- delivery URL generation

The landing page and product UI should live in the same project. Do not split into a separate LP repo for v0.1.

### Worker API

Responsibilities:

- accept ciphertext + approved metadata
- enforce request/payload limits
- create delivery records
- return delivery metadata/ciphertext to valid requests
- perform atomic consume/invalidation
- enforce expiry
- expose no plaintext handling path

Likely endpoints may resemble:

- `POST /api/secrets`
- `GET /api/secrets/:id`
- `POST /api/secrets/:id/consume`

Exact API contract is intentionally deferred until implementation planning.

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
- display context metadata
- locally inspect repository facts for variable/target suggestions
- local decrypt
- safe confirmed write
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

Git CLI, read-only, three commands: is-inside-work-tree, the configured
`remote.origin.url` values, and the effective `git remote get-url origin`.
`.git/config` is not parsed by hand and `insteadOf` rewriting is left to Git.
RepoBD never mutates Git.

The effective origin URL is used exactly as Git returns it, minus the single
terminal line ending. Surrounding whitespace makes it malformed and it fails
closed rather than being trimmed into validity.

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

Environment is display/confirmation metadata in v0.1.

Do not introduce unreliable local environment auto-detection simply to claim full context automation.

## Secret mapping

Mapping suggestions are local-only and evidence-based.

Potential deterministic sources:

- `.env.example`
- `.env.sample`
- `.env.template`
- `process.env.*`
- `import.meta.env.*`

No repository upload, server-side code analysis, or AI inference is required for v0.1.

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
