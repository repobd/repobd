# RepoBD

> **Wrong repo. No secret.**

RepoBD is a CLI-first developer security tool: a secret transport with a repository context guardrail.

Its goal is simple: make it easy to hand a secret to another developer, and hard to apply it in the wrong repository.

RepoBD is in private MVP development. It is not published to npm, no production infrastructure is deployed, and it is not ready for external use.

## Product idea

**Secrets should travel with context.**

Git gives code a repository identity. Secrets are still commonly copied as contextless strings and matched to projects by human memory and a glance at the terminal title. RepoBD adds a repository-aware handoff step without becoming a Secret Manager.

RepoBD is **not** a generic secret manager, a file transfer service, a dotenv editor, or an arbitrary filesystem writer.

## What v0.1 does

One delivery carries exactly one assignment:

```env
OPENAI_API_KEY=value
```

`repobd send`, run inside the repository the secret belongs to, does this:

1. resolves the RepoBD service origin and this repository — either failing stops
   the run before anything is typed
2. prompts for the `KEY` and then the value, as two separate stdin lines, never
   from `argv`. The value is plain and unmasked in v0.1
3. validates the assignment against the same grammar the receiver applies,
   **before any network call**
4. generates a fresh key and encrypts locally
5. creates the delivery, sending the ciphertext envelope and a fixed 900-second
   TTL and nothing else — no plaintext, no key, no repository identity
6. prints one delivery link, whose fragment carries the key and the repository
   binding that no HTTP client transmits

`repobd pull`, run inside the intended repository, does this:

1. reads the delivery link from a terminal prompt — never from `argv`
2. compares the link's repository binding against this repository, **before any network call**
3. claims the delivery and decrypts it locally
4. validates that the payload is exactly one `KEY=value`
5. inspects `.env` at the verified work tree root
6. asks for confirmation only if an existing different value would be replaced
7. confirms with the server that it still holds the claim, immediately before writing
8. writes safely, reads the file back to verify it
9. only then consumes the delivery

A wrong repository produces no claim, no secret retrieval, no write and no
consume.

No failure before a verified write consumes the delivery. RepoBD also makes a
best-effort attempt to hand the claim back so it can be used again straight
away — but that is an attempt, not a guarantee: if the release cannot be
completed, or RepoBD cannot confirm it still holds the claim, an active lease
may keep the delivery unusable until the lease expires. Whether it can be used
again therefore depends on that release, the lease, and the delivery's own TTL.

## v0.1 boundaries

These are deliberate product boundaries, not gaps:

- **Payload** — exactly one `KEY=value` per delivery. Multiple assignments fail closed.
- **Target** — `.env` at the verified Git work tree root, and nowhere else. No `.env.local`, no `.env.production`, no caller-supplied path.
- **`.env` handling** — RepoBD is not a dotenv parser. It edits a file only when it can confidently read the one ordinary single-line assignment it needs. Ambiguous, multiline, duplicated, compound or loader-dependent syntax is refused with no write and no consume. RepoBD does not guess.
- **Shell** — RepoBD writes dotenv-style assignments. It does not guarantee equivalent behaviour when a `.env` file is executed as shell code (`source .env`).
- **Repository binding** — an accidental-safety guardrail, not authentication. It does not defend against a compromised machine, a malicious local user, or a deliberately rewritten binding.

## Implementation status

| Phase | Scope | Status |
|---|---|---|
| 0 | Repository scaffold | complete |
| 1 | Crypto envelope (AES-256-GCM, client-side) | complete |
| 2 | Worker + D1 short-lived ciphertext transport | complete |
| 3 | CLI repository identity guard | complete |
| 4 | Safe local apply, end to end | complete |
| 5A | CLI sender, local development | implemented, pending final review/commit gate |
| 5B | Production integration and real end-to-end | not started |

`repobd pull` and `repobd send` are both implemented; a send → pull round trip runs locally.

The service origin comes from `REPOBD_SERVER_URL` when it is set, and otherwise defaults to the local-development Worker at `http://localhost:8787`. HTTPS is required, with one narrow exception: plain HTTP is accepted only for a loopback development origin (`localhost`, `127.0.0.1`, `[::1]`). There is no configuration file and no `--server` flag.

A web sender and environment metadata are deferred post-v0.1.

No production Cloudflare resources exist and nothing is deployed. The Wrangler configuration is local-development only.

## Authoritative docs

Documentation navigation for human readers. This is not agent bootstrap: an
AI agent's read order and task routing are defined only in
[`AGENTS.md`](AGENTS.md), which stays the sole canonical routing authority.

For a human getting oriented, start with:

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

RepoBD is developed in Herdr with:

- Claude Code: primary implementer
- Codex: independent read-only reviewer
- plain test terminal
- plain Worker/dev runtime terminal

One AI agent works on the repository at a time, and every write cycle needs explicit human authorization. See [`docs/AI_WORKFLOW.md`](docs/AI_WORKFLOW.md) and [`HERDR_BOOTSTRAP.md`](HERDR_BOOTSTRAP.md).
