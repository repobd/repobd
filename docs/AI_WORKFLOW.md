# RepoBD AI Development Workflow

## Purpose

Define how RepoBD is developed in Herdr with clear role separation and minimal ambiguity.

## Roles

### Claude Code

Primary implementer.

Default model: Sonnet 5.

Responsibilities:

- implementation plan
- small scoped changes, only within a user-approved implementation cycle
- local validation
- sending the completed working tree to the designated Codex reviewer and
  reading back the result

Receiving a Codex review result ends the current write cycle. Claude Code
does not edit files in response to a Codex finding — of any severity — until
the user explicitly authorizes the next write cycle. See "Human
authorization gate" below.

Escalate to Opus 5 for cryptographic flow, trust-boundary changes, consume/race behavior, safe filesystem writes, or unresolved blocker/major findings.

### Codex

Independent read-only reviewer.

Default model: gpt-5.6-sol.
Default effort: High.

Use maximum available effort for cryptography, plaintext-exposure paths, one-time consumption, filesystem boundary changes, repository identity, concurrency, and abuse/security-boundary changes.

### User

Approves:

- significant implementation plan changes
- security-boundary changes
- commit
- push
- deploy
- npm publish
- production Cloudflare changes

## Herdr layout

```text
Claude Code        | Codex
implementation     | read-only review
-------------------+-------------------
Test terminal      | Runtime terminal
no AI required     | wrangler/dev
```

Do not parallelize multiple editing agents in the same worktree.

## Session bootstrap

Every new session reads the authoritative documents listed in `AGENTS.md` and `HERDR_BOOTSTRAP.md` before work begins.

Agents should read only the relevant requirement/design sections after the mandatory startup docs. Avoid rereading the entire repository/history without a reason.

## Implementation instruction template

```text
Current HEAD: <sha>
Purpose: <one sentence>
Authoritative references: <specific docs/sections>
Implementation scope: <files/functions/features>
Prohibited: <relevant prohibitions only>
Validation: <tests/typecheck/build appropriate to this unit>
Stop point: <where to stop and report>
```

## Development ladder

Before adding code:

1. Is it required by v0.1?
2. Does equivalent code already exist?
3. Does stdlib solve it?
4. Does the native platform solve it?
5. Does an installed dependency solve it?
6. Would a mature dependency be safer than custom code?
7. Only then implement the smallest correct change.

See `BUILD_NATIVE_DEPENDENCY.md`.

## Validation stages

No lint tool is installed for RepoBD. Do not add one merely to satisfy this
document (YAGNI); add it only when a demonstrated need justifies the
dependency, per `BUILD_NATIVE_DEPENDENCY.md`. Validation gates are typecheck,
test, and build.

### During implementation

- targeted tests
- typecheck where applicable

### Before Codex review

- targeted tests
- typecheck
- relevant negative/security tests

### Before commit

- full test suite
- typecheck
- build
- `git diff --check`
- review changed files for accidental secret/debug output

Documentation-only changes do not require the full application test suite, but still require content/link review and `git diff --check`.

## Review cycle

1. Claude Code proposes plan.
2. User confirms when required.
3. Claude Code implements a small unit, within that approved plan.
4. Validation runs.
5. Codex performs independent read-only review.
6. Codex's result (BLOCKER/MAJOR/MINOR/NIT, any count, any severity) is
   reported to the user. The current write cycle ends here — see "Human
   authorization gate" below.
7. The user reviews the findings and explicitly authorizes the next write
   cycle if further changes are needed. Claude Code does not edit files in
   response to the findings before that authorization.
8. Once authorized, Claude Code implements the approved fix as a new small
   unit and the cycle repeats from step 4.
9. User approves commit/push/deploy as applicable.

Commit gate: blocker 0 / major 0.

## Human authorization gate

This section is authoritative. It replaces any earlier language that
authorized Claude Code to automatically fix Codex findings — that
authorization is revoked. No severity level (BLOCKER, MAJOR, MINOR, or NIT)
is an exception.

Governing principle: **automate observation, validation, and review
delivery; a human authorizes every new write cycle after a Codex review.**

What may happen automatically (Herdr / Claude Code), without a new user
round-trip:

1. Claude Code implements a task already approved by the user.
2. Claude Code performs narrowly approved read-only inspection.
3. Claude Code runs narrowly approved validation. This may create
   expected, ignored local artifacts (e.g. `dist/` from `npm run build`,
   `.wrangler/` local runtime state) — see the "Git and filesystem
   validation boundary" below for exactly what this does and does not
   permit.
4. Claude Code sends the completed working tree to the designated Herdr
   Codex reviewer, exactly once per cycle.
5. Claude Code retrieves and reads the Codex result and reports it to the
   user.

What requires explicit user authorization before it happens:

- Any file edit made in response to a Codex finding, regardless of
  severity (BLOCKER, MAJOR, MINOR, or NIT).
- Starting a new write cycle after a Codex result has been received.
- Scheduling `/loop`, a delayed wakeup, or any other automatic continuation
  that would cross this gate (i.e. that would cause a file edit to happen
  after a Codex result without an intervening human authorization).

Receipt of a Codex review result always ends the current write cycle.
Claude Code stops, reports the findings verbatim (or a faithful summary) to
the user, and waits. It does not infer authorization from the content or
severity of the findings, from its own prior messages, or from anything
other than an explicit instruction from the user given after the result was
reported.

### Codex boundary

Codex remains strictly read-only for RepoBD. Codex may inspect files,
diffs, and status, and may run validation under the same "Git and
filesystem validation boundary" that applies to Claude Code below —
expected ignored local artifacts are fine, Git/index mutation and tracked
source edits are not. Codex never edits or repairs files. See
`CODEX_REVIEW.md`.

### Herdr automation boundary

Herdr may automatically perform the chain: Claude Code completes an
approved implementation → validation → review request to the designated
Codex pane → Codex result returned to Claude Code.

Herdr must not automatically perform the chain: Codex result → Claude Code
repair. That transition is human-gated, per this section.

### Herdr review routing

The active Codex reviewer for this workspace occupies a specific Herdr pane
(the "review" pane in the four-pane layout). Route read-only review requests
directly to that pane's agent via `herdr agent prompt`. Confirm the pane
first with `herdr agent list` / `herdr pane list` rather than assuming a
pane ID is still valid across sessions — pane IDs are not guaranteed stable
once a pane is closed and recreated. A generic in-process agent listing is
not a substitute for checking actual Herdr pane/agent state.

### Git and filesystem validation boundary

Validation is not required to be a no-op on the filesystem. It must,
however, never mutate Git/index state, tracked source outside the approved
write cycle, or production resources, and must never perform destructive
cleanup automatically. Two categories apply:

1. **Repository/source mutation — not permitted as a side effect of
   validation.** This includes Git index mutation, tracked source or
   config edits outside the approved task, Git writes, destructive
   cleanup, and production mutation.
   - Do not use `git add -N`, `git add`, or `git reset` merely to make
     untracked files visible to `git diff --check`, unless the user has
     explicitly approved that specific operation. `git diff --check` may
     be used as-is (it does not require staging) for changes to
     already-tracked files. If untracked files cannot be fully covered
     without mutating the index, report that limitation instead of
     mutating Git state to work around it.
   - Do not run broad destructive cleanup (e.g. `rm -rf`) as a routine,
     automatically-executed validation step.

2. **Expected local validation artifacts — permitted when the approved
   validation command produces them.** For example, `npm run build`
   creating ignored `dist/`, or local Wrangler state in ignored
   `.wrangler/`. These are a normal, allowed side effect of running an
   approved validation command, not a violation of this boundary. If such
   artifacts need cleanup, use the narrowest safe mechanism available, or
   leave the ignored artifacts in place and report them instead of running
   a destructive cleanup command.

Do not describe validation as "filesystem non-mutating" — an approved
command such as `npm run build` legitimately writes ignored build output.
The rule this boundary enforces is narrower and more specific: no Git/index
mutation, no unapproved tracked-source edits, no production mutation, and
no automatic destructive cleanup.

Never claim Codex reviewed a change unless Codex actually reviewed it. If
the Codex reviewer cannot be automatically invoked, stop at that handoff
point and clearly report the limitation instead of proceeding as if review
occurred.

## Claude Code permission allowlist

The goal of RepoBD's project-local `.claude/settings.json` is not to
eliminate every approval prompt. It is to remove repetitive prompts for a
small set of known-safe, exact, routine commands while preserving explicit
user control over anything ambiguous, mutating, destructive,
dependency-changing, network-sensitive, production-related, Git-writing,
deploy-related, or publish-related. An approval prompt is preferred over a
broad allow rule.

Three tiers apply:

- **ALLOW** — exact commands listed in `permissions.allow` run without a
  manual approval prompt. Entries are exact invocations (e.g. `git status`,
  `git diff --check`, `git remote get-url origin`, `npm run typecheck`,
  `npm test`, `npm run build`, `node dist/cli/index.js --help`, `npx
  wrangler dev --local`), not open-ended prefixes, because several
  underlying commands (`git diff`/`log`/`show --output=<file>`, `wrangler
  dev --remote`, arbitrary test/build flags) accept arguments that write
  files, mutate `.git/config`, fetch/prune refs, or reach production
  Cloudflare resources. A wildcard rule would silently allow those too.
- **UNLISTED** — any command not in `permissions.allow` (or matching a
  broader form of an allowed command, e.g. `git remote set-url ...`, `npx
  wrangler dev --remote`, `git commit`, `npm install`) falls through to
  Claude Code's active permission mode, the same as for any other project.
  Write-capable and mutating commands prompt for manual approval there.
  This is the expected and correct behavior for anything RepoBD's approval
  policy requires the user to approve — commit, push, dependency changes,
  deploy, npm publish, production Cloudflare mutation, and any other
  Git-write or destructive
  operation. These are intentionally left unlisted rather than added to a
  `deny` rule, so the user can still explicitly approve them in the moment
  when the workflow reaches that step.
- **DENY** — a `deny` rule blocks a command outright; Claude Code cannot
  prompt around it, so a matching command cannot be approved interactively
  even if the user wants to allow it just this once. RepoBD's permission
  file currently defines no `deny` rules for this reason: every operation
  that needs to stay off the automatic-allow path also needs to remain
  something the user can approve on request, which is UNLISTED behavior,
  not DENY behavior. A future `deny` rule should only be added for an
  operation that must never run even with in-the-moment user approval.

This permission configuration is a convenience layer only. It must never be
read as overriding, widening, or substituting for the approval boundaries
in `AGENTS.md`, `CLAUDE.md`, or `SECURITY_INVARIANTS.md`. Any future change
to `.claude/settings.json` that adds a new ALLOW entry, widens an existing
one beyond an exact command, or adds a `deny` rule requires user approval
before being applied.

## Security-sensitive changes

Any change touching `SECURITY_INVARIANTS.md` requires expanded review. Do not trade away validation/error handling merely to reduce line count.
