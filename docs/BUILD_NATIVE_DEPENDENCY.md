# RepoBD Build / Native / Dependency Matrix

## Development rule

RepoBD should not build solved infrastructure unless there is a demonstrated product requirement.

Security correctness comes first, then the smallest maintainable implementation.

## Initial decisions

This table records the decisions as made during planning, before
implementation. See "Delivered vs. initial candidate" below for what was
actually shipped — several initial candidates were not carried through.

| Capability | Preferred approach | Rationale |
|---|---|---|
| authenticated encryption | Web Crypto API / native Web Crypto | standard primitive; no custom crypto |
| random key/IV generation | native crypto | avoid custom randomness |
| CLI command parsing | `commander` | mature, focused CLI parsing |
| CLI prompts / confirm / selection | `@clack/prompts` | avoid building terminal UX primitives |
| open browser from CLI | `open` | cross-platform behavior already solved |
| `.env` parsing | `dotenv` where parsing is needed | mature parser; do not reinvent syntax |
| precise existing `.env` editing | minimal purpose-built logic only if required | preserve comments/order; avoid parse-and-rewrite surprises |
| Git repository detection | Git CLI via Node process API | native authoritative tool; no Git abstraction needed initially |
| Git remote normalization | small RepoBD pure function | product-specific equivalence logic; easy to test |
| HTTP/API runtime | Cloudflare Workers native APIs | small endpoint surface; avoid framework until needed |
| persistence | Cloudflare D1 native binding | simple short-lived records; avoid ORM initially |
| ORM | none for v0.1 | unnecessary abstraction for a small schema |
| Worker tests | Vitest + Cloudflare Workers Vitest integration | official runtime-oriented testing |
| generic unit tests | Vitest | shared test runner |
| AI/provider secret classification | none for v0.1 | not core; avoid inference complexity |
| repo fact discovery | deterministic local filesystem/code search | local evidence, no server/AI analysis required |
| logging framework | none initially | minimize exposure and dependencies; log only safe metadata |

## Delivered vs. initial candidate

As shipped in the v0.1.1 release, the runtime dependency set is narrower than
the initial candidates below:

- **`commander`** — delivered, unchanged from the initial candidate.
- **`@clack/prompts`** — not delivered. CLI prompts/confirmation use plain
  stdin/stdout instead; no terminal-UX dependency was added.
- **`open`** — not delivered. There is no web sender and nothing for the CLI
  to open in a browser.
- **`dotenv`** — not delivered. RepoBD deliberately implements no general
  dotenv parser; `src/apply/env-file.ts` recognizes a conservative,
  purpose-built single-line `.env` subset instead (see
  `docs/MVP_REQUIREMENTS.md` §7). A general parser was rejected on purpose,
  not merely unbuilt.

The shipped runtime dependency is `commander` only.

## Initial dependency candidates

Runtime/CLI candidates, as planned before implementation (see "Delivered vs.
initial candidate" above for what actually shipped):

- `commander`
- `@clack/prompts`
- `open`
- `dotenv`

Development candidates:

- `typescript`
- `wrangler`
- `vitest`
- Cloudflare Workers Vitest integration package current at implementation time

Web dependencies are selected only after deciding the minimum UI scaffold.
The current product decision is that the landing page is a separate project
(`repobd/repobd-lp`), not part of this repository — see `docs/ARCHITECTURE.md`
and `HANDOVER.md`.

## Explicit non-default choices

Do not add by default:

- crypto libraries
- Git abstraction libraries
- GitHub SDK
- ORM
- DI/container framework
- state-management library
- form framework
- logging framework
- provider-specific secret SDKs
- AI inference for secret classification

## New dependency checklist

Before adding a dependency, answer:

1. Which current v0.1 requirement requires it?
2. Can stdlib/native platform solve the same problem safely?
3. Is the dependency mature and maintained?
4. Does it expand the supply-chain/security surface materially?
5. Is the dependency smaller/safer than the code we would otherwise own?
6. Can it handle secret data without unexpected logging/telemetry?

Document material dependency changes in this file or an ADR before implementation proceeds.
