# RepoBD

> **Wrong repo. No secret.**

**Repo-bound secret transport.** RepoBD creates a one-time secret delivery
bound to a repository identity. The receiving repository must match before
the secret is retrieved and applied — Git already gives code a repository
identity, and RepoBD carries that identity along with the handoff instead of
leaving it to memory and a glance at the terminal title.

**Status: v0.1.1 is the current public release.** `repobd@0.1.1` is published
on npm (`latest`), tagged `v0.1.1` on GitHub, and released as
[RepoBD v0.1.1](https://github.com/repobd/repobd/releases). The CLI,
production Cloudflare infrastructure, and a real production end-to-end run
are all complete and reviewed.

## Install

```bash
npm install -g repobd
```

or run without installing, prefixing every command with `npx`:

```bash
npx repobd send
npx repobd pull
```

(pin a version instead with `npx repobd@0.1.1 send` if needed.) The Quick
Start below assumes a global install — if you're using `npx` instead,
replace `repobd` with `npx repobd` in every command.

## Quick Start

In the repository the secret belongs to:

```console
$ cd my-service
$ repobd send
Secret name (KEY): DEMO_TOKEN
Secret value: TEST_VALUE
Delivery created. It can be used once, in that repository, within 15 minutes.
https://api.repobd.com/d/<id>#k=<key>&b=<binding>
```

The full delivery link is secret-bearing — share it only through a
private, trusted channel (never a public issue, ticket, chat room, log, or
document). In the receiving repository:

```console
$ cd my-service
$ repobd pull
Paste RepoBD link: https://api.repobd.com/d/<id>#k=<key>&b=<binding>
Repository verified: github.com/you/my-service
Will add DEMO_TOKEN to .env.
Applied DEMO_TOKEN to .env.
Delivery consumed.
```

Run from a different repository, `pull` refuses instead — see
[Wrong-repo behavior](#wrong-repo-behavior).

## How it works

`repobd send`, run inside the repository the secret belongs to, does this:

1. resolves the RepoBD service origin and this repository — either failing
   stops the run before anything is typed
2. prompts for the `KEY` and then the value, as two separate stdin lines,
   never from `argv`. The value is plain and unmasked in v0.1
3. validates the assignment against the same grammar the receiver applies,
   **before any network call**
4. generates a fresh key and encrypts locally
5. creates the delivery, sending the ciphertext envelope and a fixed
   900-second TTL and nothing else — no plaintext, no key, no repository
   identity
6. prints one delivery link, whose fragment carries the key and the
   repository binding that no HTTP client transmits

`repobd pull`, run inside the intended repository, does this:

1. reads the delivery link from a terminal prompt — never from `argv`
2. compares the link's repository binding against this repository, **before
   any network call**
3. claims the delivery and decrypts it locally
4. validates that the payload is exactly one `KEY=value`
5. inspects `.env` at the verified work tree root
6. asks for confirmation only if an existing different value would be
   replaced
7. confirms with the server that it still holds the claim, immediately
   before writing
8. writes safely, reads the file back to verify it
9. only then consumes the delivery

No failure before a verified write consumes the delivery. RepoBD also makes a
best-effort attempt to hand the claim back so it can be used again straight
away — but that is an attempt, not a guarantee: if the release cannot be
completed, or RepoBD cannot confirm it still holds the claim, an active lease
may keep the delivery unusable until the lease expires. Whether it can be
used again therefore depends on that release, the lease, and the delivery's
own TTL.

## Team secret handoff

The common case is two developers with separate local clones of the same
remote repository:

- **Developer A** runs `repobd send` in their clone and enters the secret.
  The full delivery link is secret-bearing — share it only through a
  private, trusted channel (a direct message or a private ticket the
  intended recipient already has access to), never a public issue, public
  channel, log, or document.
- **Developer B** enters their own clone of the same repository and runs
  `repobd pull`. RepoBD verifies the *canonical* repository identity — not
  the local path — and applies the value to their local root `.env`.

Different local paths are expected and fine:

```text
/Users/alice/project
/home/bob/project
```

Both match because they both originate from the same canonical remote
repository. RepoBD never compares filesystem paths.

## Multi-repo / AI coding workflow

Multiple agents. Multiple repositories. One wrong paste.

```text
Terminal A → Claude Code → repo-a
Terminal B → Codex       → repo-b
```

A delivery bound to `repo-a`:

- pasted and pulled from `repo-b` → rejected before secret retrieval
- pasted and pulled from `repo-a` → applied

RepoBD does not prevent a human or an orchestrator from selecting the wrong
terminal — that mistake is still possible. What it prevents is that mistake
placing the secret into the wrong repository. This has been verified as
real, working behavior operating the published npm package end to end from
both Claude Code and Codex — not a claim that RepoBD hides secrets from AI
agents in general, or isolates secrets across every possible workflow.

**Wrong repo. No secret.**

## Wrong-repo behavior

```console
$ cd some-other-repo
$ repobd pull
Paste RepoBD link: https://api.repobd.com/d/<id>#k=<key>&b=<binding>
Repository mismatch. Secret was not retrieved.
  bound to: github.com/you/my-service
  current:  github.com/you/some-other-repo
```

A wrong repository produces no claim, no secret retrieval, no write and no
consume — the check runs before any network call, so a mismatch leaves the
delivery untouched and still usable in the right place.

## Security model

- Encryption and decryption happen client-side, with a fresh AES-256-GCM key
  generated on every `send`.
- The delivery is one-time: a successful `pull` consumes it, and a repeat
  attempt is rejected.
- Every delivery has a fixed 900-second (15-minute) TTL.
- A wrong repository is rejected **before** secret retrieval — the check
  runs before any network call.
- A successful `pull` applies the value to this repository's root `.env`
  only — no `.env.local`, `.env.production`, or caller-supplied path. It is
  not a dotenv parser: it edits the file only when it can confidently read
  the one ordinary single-line assignment it needs, and refuses ambiguous,
  multiline, duplicated, compound, or loader-dependent syntax with no write
  and no consume. RepoBD does not guess, and does not guarantee equivalent
  behavior when `.env` is executed as shell code (`source .env`).
- The Worker/D1 backend stores only the encrypted envelope and non-secret
  lifecycle state (id, timestamps, claim/consume status) — the supported CLI
  flow never sends it the plaintext secret, the decryption key, or
  repository identity.
- Repository binding is an accidental-misuse guardrail, **not**
  cryptographic authentication, and it is not a defense against a
  compromised machine or a malicious local user.

See [`docs/SECURITY_INVARIANTS.md`](docs/SECURITY_INVARIANTS.md) and
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) for the complete boundary and
what is explicitly out of scope.

## What RepoBD is not

- Not a secret manager, vault, or production deployment secret store — and
  not a replacement for one.
- Not a dotenv editor or a general file transfer service.
- Not an identity or authentication system.
- Not protection against a compromised or malicious local machine —
  repository binding is a guardrail against accidental misuse, not
  authentication.

RepoBD is a secret transport plus a repository-context guardrail — nothing
more.

## Supported repository hosts

RepoBD resolves repository identity for:

- **github.com**
- **gitlab.com**
- **bitbucket.org**

Their common HTTPS and SSH clone forms normalize to one identity. An
unresolved repository or an unsupported host blocks `pull` before any
network call, the same as a mismatch.

## CLI reference

```text
repobd send   Create a one-time secret delivery bound to this repository
repobd pull   Retrieve and apply a delivery only if this repository matches
```

Run `repobd --help`, `repobd send --help`, or `repobd pull --help` for full
usage.

## Service origin

Ordinary v0.1 usage needs no configuration: `send` and `pull` talk to
RepoBD's public production service at `https://api.repobd.com` by default.
Nothing has to be set for normal use.

`REPOBD_SERVER_URL` is an advanced override, for local development and
testing against a different environment — for example:

```bash
REPOBD_SERVER_URL=http://localhost:8787 repobd send
```

HTTPS is required for any non-loopback origin, with one narrow exception:
plain HTTP is accepted only for a loopback development origin (`localhost`,
`127.0.0.1`, `[::1]`). There is no configuration file and no `--server`
flag.

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
| 6 | Release hardening | complete |

`repobd pull` and `repobd send` are both implemented and have been proven
against real production Cloudflare infrastructure, with synthetic test
data. RepoBD v0.1.1 is the current public release; core development is
closed unless a new task is explicitly scoped. A web sender and environment
metadata are deferred post-v0.1.

## Security

See [`SECURITY.md`](SECURITY.md) to report a vulnerability.

## License

MIT — see [`LICENSE`](LICENSE).

## Development

To build and run from source instead of installing the npm release, clone
this repository and see [`AGENTS.md`](AGENTS.md) and
[`docs/AI_WORKFLOW.md`](docs/AI_WORKFLOW.md) for the development setup.

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
