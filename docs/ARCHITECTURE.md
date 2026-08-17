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
  ↓ fetch ciphertext
local repo verification
  ↓ local decrypt
safe local write
  ↓ verified success
consume / invalidate
```

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
- ciphertext
- crypto_version
- repo_identity
- environment
- target_file
- expires_at
- consumed_at / state
- created_at

Indexes and atomic-consume design must be reviewed before implementation.

### CLI

Responsibilities:

- `send` launcher/workflow
- `pull` workflow
- read current Git repo / origin
- normalize repository identity
- display context metadata
- locally inspect repository facts for variable/target suggestions
- local decrypt
- safe confirmed write
- request consume only after verified success

The CLI must not mutate Git or execute arbitrary follow-up commands.

## Repository identity

Use Git CLI first, rather than a Git abstraction library, unless a demonstrated need appears.

Likely facts:

- `git rev-parse --show-toplevel`
- `git remote get-url origin`

Normalize common equivalents, e.g. SSH vs HTTPS representation of the same remote.

Do not use folder name/path as repository identity.

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
