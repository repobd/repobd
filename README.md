# RepoBD

> **Wrong repo. No secret.**

RepoBD is a lightweight secret handoff tool for developers.

Its goal is simple: make it easy to pass a secret and hard to accidentally apply it to the wrong repository.

RepoBD is currently in private MVP development.

## Product idea

**Secrets should travel with context.**

Git gives code a repository identity. Secrets are still commonly copied as contextless strings and matched to projects by human memory and visual checks. RepoBD adds a repository-aware handoff step without becoming a full Secret Manager.

## MVP principles

- client-side encryption
- server never sees plaintext secret content
- server never receives the decryption key
- repository mismatch blocks apply
- text payload only, max 64 KiB
- one-time / short-lived delivery
- no automatic Git commit/push/deploy
- minimal product surface and minimal dependencies

## Authoritative docs

Start with:

- [`AGENTS.md`](AGENTS.md)
- [`HANDOVER.md`](HANDOVER.md)
- [`docs/PRODUCT_CONCEPT.md`](docs/PRODUCT_CONCEPT.md)
- [`docs/MVP_REQUIREMENTS.md`](docs/MVP_REQUIREMENTS.md)
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)
- [`docs/SECURITY_INVARIANTS.md`](docs/SECURITY_INVARIANTS.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/AI_WORKFLOW.md`](docs/AI_WORKFLOW.md)
- [`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md)
- [`docs/BUILD_NATIVE_DEPENDENCY.md`](docs/BUILD_NATIVE_DEPENDENCY.md)

## Development workflow

RepoBD is planned to be developed in Herdr with:

- Claude Code: primary implementer
- Codex: independent read-only reviewer
- plain test terminal
- plain Worker/dev runtime terminal

See [`HERDR_BOOTSTRAP.md`](HERDR_BOOTSTRAP.md).

## Status

Requirements and security boundaries are being defined before implementation begins.
