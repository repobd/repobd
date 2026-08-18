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
- sending the completed working tree to the designated Codex reviewer

Sending the review request ends Claude Code's activity for that cycle: it
goes idle and does not retrieve, poll for, or wait on the result. See
"Single active agent per repository" below.

A Codex review result ends the current write cycle. Claude Code does not
edit files in response to a Codex finding — of any severity — until the user
explicitly authorizes the next write cycle. See "Human authorization gate"
below.

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
4. Validation for that unit runs — all of it, before the next step.
5. Claude Code sends the working tree to Codex, then goes idle. The
   implementation portion of this write cycle closes at this moment — see
   "Single active agent per repository" and "Review wait gate" below.
6. Codex performs independent read-only review. Claude Code does no
   repository work at all while that review is outstanding, including
   polling for the result.
7. Codex reports its result (BLOCKER/MAJOR/MINOR/NIT, any count, any
   severity) in its own pane and goes idle. The write cycle ends here — see
   "Human authorization gate" below.
8. The user takes the result, optionally works through it with GPT, and
   decides. Claude Code does not edit files in response to the findings
   before an explicit new authorization.
9. If a change is needed, the user authorizes a fresh scoped cycle and the
   cycle repeats from step 3.
10. User approves commit/push/deploy as applicable.

Lifecycle:

```text
approved implementation → validation → Codex review request
  → CC idle / Codex reviews → Codex result → both idle
  → user → GPT analysis → human decision
  → explicit user authorization → next write cycle
```

Commit gate: blocker 0 / major 0.

## Single active agent per repository

Governing principle: **for one repository/worktree, only one AI agent may
perform repository work at a time.**

This rule is absolute. Explicit user authorization does **not** override the
simultaneous-active prohibition. A user may choose *which* agent is active
and *when* it becomes active; a user cannot make both active at once.

RepoBD prioritizes security correctness and a deterministic development flow
over development speed. Overlapping agent activity — even when both agents
intend to respect their roles — creates state ambiguity about which working
tree is under review, whether validation happened before or during that
review, whether a result still corresponds exactly to the reviewed tree, and
whether a gate was actually reached. That ambiguity is not worth the
automation benefit.

### What counts as ACTIVE repository work

All of the following are ACTIVE repository work, whether or not they write
anything:

- file inspection for implementation or review purposes
- source analysis
- implementation
- validation
- review
- adversarial probes
- any other repository-specific investigation

**Read-only work still counts as ACTIVE.** A read-only Codex investigation
is not a neutral background activity — it is Codex being the active agent.

The inactive agent's Herdr pane and process may stay open; it simply must
not work on this repository during the other agent's active phase. Nothing
here requires terminating a pane or agent.

The permitted lifecycle:

```text
CC ACTIVE / Codex IDLE      implementation
  → CC IDLE / Codex ACTIVE  review
  → CC IDLE / Codex IDLE    human gate
  → (explicit user authorization)
  → CC ACTIVE / Codex IDLE  next cycle
```

`CC ACTIVE / Codex ACTIVE` must never occur for the same RepoBD working
tree.

### Implementation — Claude Code active, Codex idle

Claude Code implements only the currently approved write cycle, runs its
approved validation, and prepares the working tree for review.

Codex does not inspect, review, or investigate the repository during this
state — not even read-only, and not on user request. A user who wants a
separate Codex investigation must first move Claude Code to idle; see
"Separate Codex investigation" below. There is no form of user approval
that makes a concurrent Codex investigation permissible while Claude Code
is active.

### Review handoff

Claude Code sends the completed working tree to Codex. Once that request is
successfully sent, Claude Code becomes idle and must not:

- edit files,
- continue implementation,
- perform opportunistic fixes,
- begin another task or another phase,
- poll the Codex pane,
- repeatedly call `herdr agent read`,
- run background waiting loops,
- perform additional validation,
- or perform any other repository work while Codex reviews.

Claude Code is not responsible for polling Codex or for retrieving the
result. It stops.

##### Handoff output is concise

The review request sent to Codex stays as detailed as the review needs —
implementation scope, changed files, validation results, security concerns,
requested focus. That detail is *for Codex*, and must not be trimmed.

What Claude Code shows the **user** at handoff is only the state
transition, e.g.:

```text
Implementation complete. Validation PASS. Codex review sent. Claude Code is IDLE.
```

Do not replay to the user the implementation details, per-test
descriptions, mutation-test tables, changed-file narratives, or the review
prompt itself. The user can ask for any of it; volunteering all of it
duplicates what already went to Codex.

This is a workflow rule, not a permissions problem: do not widen
`.claude/settings.json` to make `herdr agent read` or other Herdr commands
automatically approved, and in particular never add a broad `herdr agent *`
allow rule.

### Review — Codex active, Claude Code idle

Codex inspects the approved review scope and performs allowed read-only
validation. Codex never edits or repairs files.

### After the review

Codex reports its result in the Codex pane and becomes idle. It does not
push the result to Claude Code, invoke a Claude Code turn, or wait for any
acknowledgement — and Claude Code never fetches it. Claude Code must not
poll for review completion, and no permission rule should be added to make
such polling convenient.

The result travels through people instead:

```text
Codex result → user → GPT analysis → human decision
  → (only if a change is needed) a scoped Claude Code prompt
  → explicit user authorization → Claude Code active again
```

GPT may analyse the findings, separate required fixes from optional
refinements, recommend repairing or accepting, define the next small
write-cycle scope, and draft the Claude Code prompt. GPT does not authorize
repository writes; the user does.

Claude Code needs no memory of the review. Its chat history is not an
authoritative record of RepoBD review history — the repository contents,
the authoritative governance and security documents, the committed history,
the current working tree, and the explicit scope of the current authorized
cycle are. A new cycle receives only the findings, constraints, and scope
that cycle needs, never the full Codex transcript. That keeps context small
and stops stale findings from leaking into unrelated work.

### Human gate — both idle

Once Codex has reported its result and gone idle, both agents are idle. The
user then decides what happens next. No agent begins another write cycle
until the user explicitly authorizes it.

### Next cycle

After explicit human authorization, Claude Code may become active again.
Codex stays idle until the next review handoff.

### Separate Codex investigation

The user may want Codex to perform a read-only investigation that is not the
review of a completed write cycle. That is allowed, but it is still Codex
becoming the active agent, so Claude Code must go idle first:

1. Claude Code stops all repository work.
2. Claude Code transitions to idle.
3. Any in-progress working-tree state is left exactly as it is — Claude Code
   does not tidy up, revert, or finish anything on the way out.
4. Only once Claude Code is idle may Codex become active.
5. Codex performs the explicitly requested read-only investigation.
6. Claude Code stays idle throughout.
7. Codex finishes and returns to idle.
8. Codex reports the result in its pane; the user reads it. Claude Code
   stays idle.
9. Resuming Claude Code repository work requires the appropriate explicit
   human authorization.

```text
CC ACTIVE / Codex IDLE → pause CC → CC IDLE / Codex IDLE
  → start Codex → CC IDLE / Codex ACTIVE
  → Codex finishes → CC IDLE / Codex IDLE
```

Never `CC ACTIVE / Codex ACTIVE`.

## Review wait gate

A write cycle has two distinct closing boundaries. This is the first of
them; the "Human authorization gate" below is the second.

Governing principle: **once review is requested, wait for review completion
before any further write.**

Once Claude Code sends the current working tree to Codex for review, the
implementation portion of that write cycle is closed.

This gate is an **unconditional prohibition, not an approval requirement.**
While a review is outstanding there is nothing for the user to approve: the
prohibition is not something user authorization can lift. Do not treat
"editing while a review is outstanding" as an action that merely needs
approval. User authorization becomes meaningful again only once the review
has ended — either by returning a result or by being explicitly cancelled.

Three states govern this:

### State A — a Codex review is outstanding

From the moment the review request is sent until the review ends, Claude
Code must not:

- edit any file,
- start another implementation task,
- make opportunistic fixes, however small,
- edit documentation,
- begin next-phase work,
- or mutate any file in any other way.

No user approval authorizes an edit while that review remains active. If the
user asks for a change during this window, say that a review is outstanding
and that it must complete or be explicitly cancelled first.

Claude Code is idle in this state, not merely non-writing. It does not poll
the Codex pane, call `herdr agent read` in a loop, or run background waiting
commands — see "Single active agent per repository" above. The result goes
to the user, not to Claude Code.

All validation belonging to the approved implementation cycle must be
completed *before* the review request is sent, not while the review is
outstanding. A review must describe a working tree that is not moving
underneath it.

The review must end in one of exactly two ways: it completes and returns a
result (State C), or it is explicitly cancelled or withdrawn (State B).

### State B — the review was explicitly cancelled or withdrawn

A deliberate cancellation ends the wait, but it does not produce a usable
review:

- Codex becomes idle.
- Any result that later arrives from the cancelled review is **stale**. It
  must not be treated as the authoritative review of a working tree that
  has since been modified.
- Claude Code does not resume automatically.
- A new write cycle may begin only after explicit user authorization.
- After that new write cycle, a fresh Codex review must be requested for
  the resulting working tree.

Cancellation is a state transition, not an exception to "Single active
agent per repository". It moves both agents to idle; it never licenses both
agents to be active at once.

### State C — the Codex review completed normally

The current write cycle ends. Codex reports the result in its pane and goes
idle; Claude Code is already idle and stays that way. No file edit may be
made in response to any BLOCKER, MAJOR, MINOR, or NIT finding until the user
explicitly authorizes a new write cycle. That transition is governed by the
next section.

## Human authorization gate

This section is authoritative. It replaces any earlier language that
authorized Claude Code to automatically fix Codex findings — that
authorization is revoked. No severity level (BLOCKER, MAJOR, MINOR, or NIT)
is an exception.

Governing principle: **automation covers implementation, validation, and
the Claude Code → Codex review handoff. Codex completing its review ends AI
automation: both agents go idle, and a human decides what happens next.**

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
   Codex reviewer, exactly once per cycle. Claude Code goes idle here, per
   the "Review wait gate" and "Single active agent per repository" above.
5. Codex reviews while Claude Code stays idle, then reports its result in
   its own pane for the user — Claude Code neither receives nor fetches it.

What requires explicit user authorization before it happens:

- Any file edit made in response to a Codex finding, regardless of
  severity (BLOCKER, MAJOR, MINOR, or NIT).
- Starting a new write cycle after a review has completed, or after one was
  explicitly cancelled.
- Scheduling `/loop`, a delayed wakeup, or any other automatic continuation
  that would cross this gate (i.e. that would cause a file edit to happen
  after a Codex result without an intervening human authorization).

Everything in this list presupposes that no review is currently
outstanding. While a review is outstanding, the "Review wait gate" above
applies instead and prohibits edits outright — user authorization does not
enter into it.

A completed review always ends the current write cycle. Claude Code has no
part in that step — it is already idle and has no responsibility to receive
or relay the result. It does not infer authorization from findings it may
happen to see, from its own prior messages, or from anything other than an
explicit instruction the user gives to start a new cycle.

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
Codex pane. The chain ends there; Claude Code goes idle and Codex becomes
the active agent.

Herdr must not automatically perform either of the two gated transitions:

- Codex review request → any further Claude Code activity. Claude Code is
  idle for the whole time the review is outstanding, per the "Review wait
  gate" and "Single active agent per repository" — it does not poll for or
  fetch the result.
- Codex result → Claude Code repair. That transition is human-gated, per
  the "Human authorization gate".

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
