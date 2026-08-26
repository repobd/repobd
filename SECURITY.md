# Security Policy

## Supported Versions

Security support currently applies to the `0.1.x` release line, once
released. No earlier public release exists.

## Reporting a Vulnerability

Please do not disclose security vulnerabilities in public GitHub Issues.

This repository is currently private, so GitHub's private vulnerability
reporting is not yet available; it will be enabled once the repository
becomes public. Until then, RepoBD has no established reporting channel for
external reporters.

When reporting, please do not include real credentials, secrets, delivery
links, or decryption material — RepoBD's threat model assumes reports can
be handled without ever seeing plaintext secret content, and a report
should not need to break that assumption either.

Reports will be reviewed as practical. Security-sensitive details should
stay private until a fix is available; this is not a contractual response
time or an SLA.

## Scope

RepoBD's security objective, what it defends against, and what it
explicitly does not (including that repository binding is a guardrail
against accidental misuse, not authentication against a malicious local
actor) are documented in
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) and
[`docs/SECURITY_INVARIANTS.md`](docs/SECURITY_INVARIANTS.md). Those
documented exclusions still apply to any report.
