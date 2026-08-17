# RepoBD Threat Model

## Security objective

RepoBD is designed primarily to reduce accidental secret-handoff and wrong-context mistakes.

It is **not** designed to defend against a machine or local developer environment that is already maliciously compromised.

## In scope

RepoBD should defend against or reduce:

- applying a valid secret to the wrong Git repository by mistake
- exposing plaintext secret content to the RepoBD server
- exposing the decryption key to the RepoBD server
- accidental plaintext leakage through CLI output, logs, errors, telemetry, or debug traces
- unsafe writes outside approved target scope
- path traversal
- symlink-based target escapes
- double-consume / replay after successful use
- expired-secret use
- concurrent consume races that would permit more successful uses than configured
- abuse through oversized payloads or excessive request rates
- accidental provider/variable mapping mistakes where a local repository fact can provide safer guidance

## Out of scope

RepoBD v0.1 does not claim to defend against:

- a compromised operating system
- malware/keyloggers on sender or receiver machines
- a malicious local user with filesystem/Git-config control
- deliberate modification of `.git/config` to impersonate a repository
- a malicious or compromised RepoBD CLI binary installed on the local machine
- compromised npm/Git distribution infrastructure
- a repository whose code/content is itself malicious or incorrect
- a sender who intentionally binds the wrong repository
- a sender who intentionally labels the wrong environment
- excessive privileges already attached to a secret
- secret leakage caused later by application code
- phishing/social engineering outside the RepoBD flow
- enterprise identity/governance/compliance requirements

## Repository identity is a guardrail, not authentication

The v0.1 repository check relies on local Git metadata, primarily normalized `origin` remote information.

This is intended to prevent accidental context mismatch, not to establish a cryptographic trust boundary against an attacker controlling the local machine.

Documentation and marketing must not overstate this property.

Recommended language:

> RepoBD prevents accidental wrong-repository application. Repository identity is not intended as authentication against a malicious local user.

## Trust boundaries

### Sender client

Trusted to:

- receive plaintext from the sender
- encrypt locally
- generate/store client-side decryption material

Must not:

- send plaintext to the server
- send decryption key material to the server

### RepoBD server / Cloudflare

Treat as untrusted with respect to plaintext confidentiality.

Server may know operational metadata required for delivery, such as:

- record identifier
- ciphertext
- repository binding metadata
- environment label
- target metadata
- timestamps/expiry/consume state
- abuse/rate-limit metadata

Server must not know plaintext secret content or the decryption key.

### Receiver CLI

Trusted locally to:

- inspect Git repository facts
- receive the delivery URL
- fetch ciphertext
- decrypt locally
- inspect allowed local repository facts for mapping suggestions
- perform the explicitly confirmed safe write

Must not:

- execute the secret
- run arbitrary commands
- mutate Git
- expose plaintext through output/logging

## Abuse model

RepoBD cannot inspect plaintext by design. This invariant must not be weakened for moderation.

Abuse mitigation therefore focuses on service-level behavior:

- payload size limit
- short TTL / maximum retention
- no file upload
- no public directory/search
- rate limiting
- traffic/request-pattern controls
- manual server-side invalidation by delivery identifier where appropriate
- `abuse@repobd.com` reporting channel

RepoBD may prohibit unlawful use in Terms of Service while remaining unable to inspect encrypted plaintext.

## Key design stance

> **RepoBD protects the handoff. It does not police or authenticate the meaning of the secret.**
