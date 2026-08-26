# RepoBD

> **Wrong repo. No secret.**

RepoBD is a CLI-first developer security tool: a secret transport with a repository context guardrail.

Its goal is simple: make it easy to hand a secret to another developer, and hard to apply it in the wrong repository.

**Status: v0.1 release candidate — pre-public release preparation.** The CLI, production Cloudflare infrastructure, and a real production end-to-end run are all complete and reviewed. RepoBD has not yet been published to npm and this repository is not yet public.

## What RepoBD is

A CLI that encrypts a secret locally, hands it off as a link bound to a specific Git repository, and refuses to apply it anywhere else.

## What RepoBD is not

- Not a generic secret manager, vault, or dotenv editor.
- Not a file transfer service or an arbitrary filesystem writer.
- Not a defense against a compromised machine or a malicious local user — repository binding is an accidental-safety guardrail, not authentication. See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) for exactly what RepoBD does and does not defend against.

## Product idea

**Secrets should travel with context.**

Git gives code a repository identity. Secrets are still commonly copied as contextless strings and matched to projects by human memory and a glance at the terminal title. RepoBD adds a repository-aware handoff step without becoming a Secret Manager.

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
consume — the check runs before any network call, so a mismatch leaves the
delivery untouched and still usable in the right place.

No failure before a verified write consumes the delivery. RepoBD also makes a
best-effort attempt to hand the claim back so it can be used again straight
away — but that is an attempt, not a guarantee: if the release cannot be
completed, or RepoBD cannot confirm it still holds the claim, an active lease
may keep the delivery unusable until the lease expires. Whether it can be used
again therefore depends on that release, the lease, and the delivery's own TTL.

## Example

A synthetic round trip, run once in each repository:

```console
$ cd my-service            # the repository the secret belongs to
$ repobd send
Secret name (KEY): DEMO_TOKEN
Secret value: TEST_VALUE
https://api.repobd.com/d/<id>#k=<key>&b=<binding>
```

```console
$ cd my-service            # the same repository, on the receiving side
$ repobd pull
Paste RepoBD link: https://api.repobd.com/d/<id>#k=<key>&b=<binding>
Repository verified: github.com/you/my-service
Applied DEMO_TOKEN to .env.
Delivery consumed.
```

Run from a different repository, `pull` refuses before any secret is retrieved:

```console
$ cd some-other-repo
$ repobd pull
Paste RepoBD link: https://api.repobd.com/d/<id>#k=<key>&b=<binding>
Repository mismatch. Secret was not retrieved.
```

## Repository binding

The delivery link's fragment carries a binding to the sender's repository
identity — never sent to the server. `pull` compares it against the current
repository before any network call, and blocks on any mismatch, unresolved
repository, or unsupported host. Supported hosted profiles in v0.1 are
**github.com, gitlab.com, and bitbucket.org**; their common HTTPS and SSH
clone forms normalize to one identity. This is a guardrail against
accidental misuse, not cryptographic authentication — see
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## `.env` boundary

RepoBD writes only `.env` at the verified Git work tree root — no
`.env.local`, `.env.production`, or caller-supplied path. It is not a
dotenv parser: it edits a file only when it can confidently read the one
ordinary single-line assignment it needs, and refuses ambiguous, multiline,
duplicated, compound, or loader-dependent syntax with no write and no
consume. RepoBD does not guess, and it does not guarantee equivalent
behavior when `.env` is executed as shell code (`source .env`).

## Privacy and security model

Encryption and decryption happen client-side, with a fresh key generated on
every `send`. The Worker/D1 backend stores only the encrypted envelope and
non-secret lifecycle state (id, timestamps, claim/consume status) — the
supported CLI flow never sends it the plaintext secret, the decryption key,
or repository identity. See
[`docs/SECURITY_INVARIANTS.md`](docs/SECURITY_INVARIANTS.md) and
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) for the complete boundary and
what is explicitly out of scope.

## Service origin

RepoBD's v0.1 public service is intended to run at `https://api.repobd.com`.
That endpoint is not live yet — it will be activated as part of release
preparation, before RepoBD is published. Once it is live, this will be the
default the CLI talks to.

For local development today, the service origin comes from
`REPOBD_SERVER_URL` when set, and otherwise defaults to a local-development
Worker at `http://localhost:8787`. HTTPS is required, with one narrow
exception: plain HTTP is accepted only for a loopback development origin
(`localhost`, `127.0.0.1`, `[::1]`). There is no configuration file and no
`--server` flag.

## Installation

RepoBD has not been published to npm yet. Once `0.1.0` is published, the
intended install path is:

```bash
npx repobd
```

or a global install:

```bash
npm install -g repobd
repobd
```

`npm install repobd` does not work from the registry today.

To try RepoBD before then, clone this repository and see
[`AGENTS.md`](AGENTS.md) and [`docs/AI_WORKFLOW.md`](docs/AI_WORKFLOW.md)
for the development setup.

## Implementation status

| Phase | Scope | Status |
|---|---|---|
| 0 | Repository scaffold | complete |
| 1 | Crypto envelope (AES-256-GCM, client-side) | complete |
| 2 | Worker + D1 short-lived ciphertext transport | complete |
| 3 | CLI repository identity guard | complete |
| 4 | Safe local apply, end to end | complete |
| 5A | CLI sender, local development | complete |
| 5B | Production integration and real end-to-end | complete |
| 6 | Release hardening | in progress |

`repobd pull` and `repobd send` are both implemented and have been proven
against real production Cloudflare infrastructure, with synthetic test
data. A web sender and environment metadata are deferred post-v0.1.

## Security

See [`SECURITY.md`](SECURITY.md) to report a vulnerability.

## License

MIT — see [`LICENSE`](LICENSE).

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

RepoBD is developed with an AI implementer (Claude Code) and an independent
AI reviewer (Codex) under human-authorized write cycles; see
[`docs/AI_WORKFLOW.md`](docs/AI_WORKFLOW.md) and
[`HERDR_BOOTSTRAP.md`](HERDR_BOOTSTRAP.md) for that workflow.
