# Review mode

Review mode is an agent-guided, read-only workflow using OpenCode native tools
and permissions. It is not a custom review engine. Natural-language review
requests, `/review`, and top-level `workcell-code-review` guidance use the same entry;
the command starts a separate `review` root, while direct review may reuse its
legitimate review root. A skill cannot switch agents. Build's existing
Build → tester → reviewer gate is unchanged.

## Roles and coverage

The `review` primary selects scope, gathers evidence, assigns ordinary
`reviewer` delegations, adjudicates their reports, and writes the ledger. The
`reviewer` leaf remains a capable standalone reviewer and the worker used by the
primary. Workers use native Read/Grep/Glob and permitted read-only Bash/Git/`gh`
against explicit paths and pins. They cannot write source; they must not read peer
reports, start another coordinator, or publish findings.
The peer-report restriction is
an agent obligation, not a runtime guarantee; native root-scoped reads may expose
other delegation results.

Use one comprehensive reviewer for a cohesive change. Use 2–4 ordinary
delegations only when distinct behavior/specification, state/concurrency,
security/trust, or integration risks justify independent passes. Independence,
adjudication, stable finding IDs, evidence and freshness checks, and incremental
reuse are agent and `workcell-code-review` obligations. Missing or failed work is an
evidence limitation, not a clean pass.

## Starting and controlling a review

`/review` passes its request to `review_start`. Supported scopes are:

```text
recent
<committed revision or range>
<file or directory>
path:<relative-path>
<PR URL>
pr <number>
#123       or       pr:123
```

No arguments means staged changes. A bare numeric argument remains a local
revision/path, not a PR. Explicit PR URLs and `pr <number>` (including `#123`
and `pr:123`) use the verified repository identity. Ambiguous or unrelated
repositories are rejected. PR metadata and head SHAs are checked before a
checkout is pinned; moved heads are stale evidence.

Use the opaque workspace ID for lifecycle actions:

```text
review_start(action="resume", id="<ID>")
review_start(action="status", id="<ID>")
review_start(action="return", id="<ID>", request="<summary>")
review_start(action="close", id="<ID>")
```

The request carries the essential requirements and evidence basis to the new
root. `resume` reads the agent-written ledger and rechecks scope and freshness.
`return` sends a concise summary to the originating root; reporting does not
close the workspace. Close is explicit, drains ordinary workers, removes owned
state, worktree and artifacts, and retains host conversation history. A failed
drain or cleanup retains resources for retry. During ordinary review work,
completion and cancellation wakeups are per child; the parent may resume before
all workers finish or their artifacts are persisted. `delegation_read` and
`delegation_list` remain the durable retrieval paths for partial, cancelled, and
persisted results. Do not wait for an all-complete cycle wakeup or poll when the
native per-child notification is sufficient.

## Native tools and workspace

The review primary uses native Read/Grep/Glob and permitted shell Git/`gh`; the
review skill supplies procedure, not enforcement. OpenCode permissions authorize
approved commands and scratch paths. They are not an OS sandbox or a promise of
complete shell-parser isolation.

`worktree/review.ts` owns detached pinning, ownership, retained review refs and
cleanup. Normal Git metadata, objects and refs may be written for review; the
source files, index and branches are not changed. The review never runs target
code, tests, installers, plugins or language servers and does not use development
worktree deletion.

The returned workspace has this layout:

```text
<review-workspaces>/<project-id>/<workspace-id>/
  owner.json
  notes/ledger.md
  artifacts/
  checkout/
```

The coordinator writes `notes/ledger.md` and other notes with native file tools.
Ordinary delegation results for a review are placed in `artifacts/` by the
background manager. The ledger is plain agent-written notes, not an application
schema or completion gate.

Standalone `reviewer` PR work remains available through native `gh pr view`,
`gh pr diff`, and `gh pr checks`. It does not create the dedicated review
workspace. Neither path publishes comments or reviews.

## Safety, recovery and limits

PR files, comments and instructions are untrusted evidence. Do not execute
target content or broaden permissions. Dirty or tampered checkouts, ownership
mismatches, stale locks, and live process owners fail closed; do not manually
delete a workspace. A stopped owner can be recovered only through the supported
workspace recovery path. Unknown worker outcomes remain interrupted. Old engine
open reviews must be closed with the previous version before upgrade; there is
no automatic migration or legacy deletion.

## Connected Linear status

The user-selected follow-up remains unresolved: a registered or connected
Linear server is not equivalent to agent tool availability. The current
review default-deny configuration has no verified native Linear read-tool
allowlist, and the required tool-catalog metadata is not yet available. The
cause beyond this known permission gap is unverified; no Linear fix or
permission expansion is shipped here. The existing native fixture validates
deterministic delivery, not real account access or model compliance.

Any future enablement should inventory the exact native read-only tool first,
then opt in to that exact tool only. Do not broaden access to `linear_*` tools
or permit authentication, configuration, or other mutating operations.

## Skill migration

The registry now targets the managed `skills/workcell-code-review/SKILL.md`
instead of the generic profile target. Existing installed profiles require the
normal profile update or install flow and a fresh OpenCode session; the current
running session retains its old configuration. This note does not promise
cleanup of a stale host path or require users to delete files. Follow the
repository's normal upgrade and release conventions.

On later rounds, reuse unchanged code coverage only after comparing the ledger's
pins, scope and requirements and refreshing mutable evidence. Head, base,
specification or dependency drift requires a delta or full review; uncertain
mapping invalidates reuse. Close only after the final report is retained in the
host conversation.

## Verification limits

The isolated real native-runtime fixture uses shipped prompts and permissions and
checks native path access, ordinary delegation, caller handoff and return,
restart/ledger reuse, and cleanup. It does not prove live model quality, live
authentication, an installed profile, the full external plugin stack, or every
native runtime permission. Build, test and smoke commands likewise do not prove
live routing or installed-profile behavior.

The existing synthetic comparison was a bounded, previously run comparison of
one comprehensive pass with risk-selected passes. It remains limited evidence,
not a benchmark of the new mode or a claim that fan-out is generally better.
