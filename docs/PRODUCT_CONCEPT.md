# RepoBD Product Concept

## One-line definition

RepoBD is a lightweight secret handoff tool that helps prevent developers from accidentally applying a secret to the wrong repository.

## Core idea

**Secrets should travel with context.**

Code already carries repository identity through Git. Secrets are still commonly copied as contextless strings and matched to projects by human memory and visual checks.

RepoBD binds handoff metadata to the secret and verifies the current repository before apply.

Tagline:

> **Wrong repo. No secret.**

## Why now

The traditional secret workflow was reasonable when one developer commonly worked in one project context at a time.

AI-assisted and parallel development changes that assumption:

- multiple repositories open at once
- multiple terminals and multiplexers
- Claude Code, Codex, Cursor and other agents working in parallel
- multiple environments and credentials

Development throughput increased; human attention did not.

RepoBD treats the final human context check as an avoidable source of mistakes when a reliable machine fact is available.

## Human-to-human and human-to-local use

RepoBD is not only an AI-development tool.

Typical handoff paths include:

- developer → own local repository
- developer → another developer
- client/company → contractor
- team member → team member
- developer → AI-assisted local development workflow

The sender does not need to be hierarchically above the receiver. The sender states where the secret belongs; RepoBD does not dictate how the receiver must work.

## What RepoBD is

- secret transport
- client-side encrypted handoff
- repository context binding
- short-lived / one-time delivery
- safe local application assistance

## What RepoBD is not

- enterprise Secret Manager
- vault replacement
- RBAC/IAM system
- credential governance platform
- SSO/SCIM platform
- Git hosting management tool
- automatic deployment tool

Enterprise organizations with established secret-management policies should continue to use those systems.

## Product philosophy

### Simple and hard to misuse

The best RepoBD flow should be competitive with copy/paste in effort, while removing avoidable manual context checks.

### Automate facts, not guesses

Repository identity can be read from Git. RepoBD should enforce it.

Environment identity has no universal reliable local source. The current
implementation carries no environment metadata at all — the delivery has no
channel for it, and repository identity is the only context RepoBD checks.
Whether that changes before the eventual v0.1 release is an open Phase 5
question. If environment is added, it must be displayed and confirmed, never
auto-detected.

### Minimize product surface to minimize attack surface

A smaller product has fewer dependencies, fewer privileges, fewer deployment surfaces, and fewer failure paths.

### Protect the handoff, not inspect the content

RepoBD must not require plaintext visibility for moderation, analytics, support, or product features.

Abuse controls should use request patterns, rate limits, short retention, payload limits, and manual invalidation—not plaintext inspection.

## Social value hypothesis

A secret-handling mistake can become:

- a financial incident
- a data exposure incident
- a service incident
- a trust/reputation incident

RepoBD does not claim to prevent all secret leaks. It exists to remove one avoidable class of handoff and wrong-context mistakes.

## Initial audience

- individual developers
- vibe coders
- AI-assisted developers
- small development teams
- freelancers and contractors
- agencies / production companies
- OSS contributors

The product strategy favors broad adoption across many low-frequency users rather than high-frequency usage by a small number of enterprise users.
