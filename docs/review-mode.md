# Review mode

Review mode is an isolated, incremental, read-only code-review workflow. Use it
for a natural-language review request, `/review`, or a top-level `code-review`
request. All three start the same dedicated `review` primary session; the
initiating conversation is not used as the review workspace.

## Roles and coverage

The `review` primary coordinates the review and adjudicates evidence. The
`reviewer` leaf is a capable standalone reviewer and is also the worker used by
the primary. A bound worker sees only its assignment and cannot read peer
findings, delegate, adjudicate, or use ordinary source/Git tools. Build's
existing Build → tester → reviewer gate remains unchanged; review mode does not
replace that gate or turn a standalone `reviewer` into an orchestrator.

Choose coverage adaptively:

- **1 reviewer:** one comprehensive pass for a small or cohesive change.
- **2–4 reviewers:** separate passes only for meaningful, distinct risks:
  behavior/specification; state/concurrency/failure; security/trust; or
  integration/compatibility/verification.

Focused parallel review can expose independent failures, but costs more and
can duplicate or fragment context. One comprehensive pass preserves context.
The implementation enforces a maximum of four slots; it does not require four.
Workers submit revision-bound findings, scenarios, evidence, severity,
confidence, contract and minimal remedy. Empty or failed coverage is reported
as incomplete, not as a clean pass. The primary verifies candidates, merges
root causes, and records accepted, rejected, duplicate or deferred outcomes;
reviewer count is not a vote.

### Bounded comparison (2026-09-17)

A parent-run blinded comparison used inline versions of the three cases in the
[evaluation fixture](../tests/review-evaluation.json). Expected findings were
withheld, and agents could not inspect the fixture or another agent's output.
One comprehensive reviewer handled all three cases in one invocation and found
three supported unique defects: incorrect exclusive endpoints, a tenant-blind
cache-hit disclosure, and an `items`/`records` compatibility break. The
adaptive side used three invocations: behavior covered all cases, security
covered the tenant case, and integration covered the cross-file case (one,
two, and two assigned lenses per case). Its six observations reduced to the
same three defects, two duplicate reports, and one producer-only test-coverage
gap merged into the compatibility finding. No seeded defect was missed and no
unsupported claim was made in this tiny single run. The security pass explained
the composite cache key more explicitly; that was not an additional defect.

This does not establish false-positive rates, cost, latency, or general
superiority: dispatch grouping was unequal and token telemetry was not
captured. Fan-out made more invocations without producing another unique defect
here. Retain one comprehensive reviewer for cohesive changes; fan out only
when distinct risks justify it. This compares bounded inline inputs, not
shipped review mode, live GitHub, or live-provider quality. The fixture remains
`prepared-not-run` for its planned in-mode/live-provider comparison, and the
current reviewer model/version and token usage were not captured.

## Starting and controlling a review

`/review` passes its arguments to `review_start`. No arguments means staged
changes. Supported scope forms are:

```text
recent
<committed revision or range>
<file or directory>
path:<relative-path>
<PR URL>
pr <number>
#123       or       pr:123
```

The tool also accepts a path array for a local path scope. PR URLs and explicit
`pr <number>` inputs (also `#123` and `pr:123`) are resolved against the current
project's verified origin. A bare numeric argument retains its revision/path
meaning and is not interpreted as a PR. A different repository is rejected
rather than cloned. PR heads, including fork PR heads, are pinned after identity
and SHA checks.

Committed ranges may omit an endpoint: `..HEAD` and `HEAD..` use `HEAD` for the
empty side. An unborn repository remains unsupported.

Callers can pass a bounded `handoff` with `requirements`, up to 16
`constraints`, and up to 16 evidence references with summaries. The handoff is
persisted with the review and included when a coordinator is resumed, so a
separate session does not lose the request's requirements, constraints or
evidence basis. A repeated request with a different handoff must resume with
the revised requirements rather than silently changing an existing review.
Changes to the handoff requirements or constraints, specification,
instructions, risk basis, or PR description invalidate reusable code coverage;
the next round must recheck or replace that coverage.

The tool returns a review ID and dedicated session reference. After a restart,
or from a new conversation in the same project, use the exact opaque ID:

```text
review_start("resume <ID>")
review_start("status <ID>")
review_start("recover <ID>")
review_start("close <ID>")
```

These are scope strings (or the equivalent `scope` argument), not shell
commands. `review_start("recover create")` is the separate recovery route for
a stopped owner of project-review creation. For a review ID, `recover` removes
only a lock proven to belong to a stopped owner; it does not steal a live or
unknown lock. Corrupt or incomplete inventory is reported as unavailable or
cleanup-pending; discovery does not delete it or use it to stop unrelated
sessions. `close` is explicit and owner authorized. `discard: true` is an
additional explicit authorization for a changed, owned checkout; it does not
authorize deleting an ownership-mismatched path.

Completion sends a concise notification that the report is ready. Retrieve the
full stored report with `status <ID>` in the initiating conversation before
closing. The runtime deliberately uses notification plus retrieval rather than
auto-injecting a full report into the original conversation. Close first drains
workers, ensures delivery/retrieval, retires managed sessions, and then removes
the owned review resources. A failed cleanup leaves a retryable record and
retains owned resources. Repeating close is safe. Conversation history and a
report already delivered to a conversation remain outside the cleanup
guarantee; cleanup is not forensic erasure.

Initialization is also fail-closed: if session binding fails after a
coordinator was created, the runtime retires that verified coordinator. If
private storage or cleanup cannot be verified, ownership markers and state are
retained. Use `recover create`, `list`, or the review ID's recovery path; do not
manually delete the scratch inventory.

## Trust boundaries and evidence

The coordinator remains in the trusted initiating project context. It does not
load plugins, configuration, or instructions from the PR checkout. PR files,
comments, and fetched instructions are untrusted evidence and cannot expand
permissions. Inspection is through bound `review_inspect` operations for the
diff, tree, files, literal search, history, and fixed GitHub evidence.

Each review owns a private scratch area, bare Git repository, detached checkout,
manifest and round state. The source working tree, index, branch, refs and
object store are not used for the review checkout and remain unchanged. Hooks,
filters, fsmonitor, external diff/text conversion, recursive submodules and
LFS payloads are disabled. The review never runs source code, tests, installs,
hooks or scripts, and never launches a terminal or OpenCode from the target
checkout. It cannot edit source, push, merge, publish findings or post GitHub
comments.

GitHub access is limited to bounded `gh api` GET requests for validated
repository metadata, comments, inline comments, reviews, checks and statuses.
Pagination is bounded and reports truncation. Authentication is delegated to
the host's `gh` credential helper; tokens are not placed in arguments or
review state. This is effective read-only behavior, not a general OS sandbox:
host-level plugins, logs and platform trust remain outside the review boundary.
Live authentication and provider availability are not proved by repository
tests, and CI/checks are evidence rather than proof of local execution.

Comments, inline comments, reviews, checks and statuses are auxiliary evidence.
If one cannot be retrieved, its result is stored as unavailable with `checkedAt`
and a sanitized category such as authentication, permission denied, rate
limited, not found, service unavailable, or network unavailable. That
limitation qualifies the stored and displayed report even if the coordinator
omits a warning. An unavailable source is not an empty successful result, and
there is no legacy `passingCI` claim. Evidence-only refresh or restoration can
update this record and requires a new summary when facts change; it does not
redispatch reviewers. Metadata, repository identity, pinned SHAs, programming
or schema failures, and safety/ownership failures remain fatal.

## Rounds, baselines and limits

Every round records its specification, repository instructions, test/CI
evidence, risks, coverage plan, worker outcomes, pinned base/head/merge-base,
findings, adjudications, freshness and limitations. A completed current round
is the reusable baseline. Unchanged committed input can reuse it without
redispatch. That reuse creates an evidence-only round: code coverage and the
stored code report are retained, mutable PR metadata/comments/checks/statuses
are refreshed, and a new summary is required without redispatching reviewers. A
reliable affected-scope assessment permits a delta review. A
force-push, rebase, base/specification change, missing objects, lost baseline,
or unreliable dependency mapping forces a full round or marks coverage stale.
Mutable staged/path scopes are fingerprinted and invalidate completion when
accessed content changes. Local directories exclude dependencies, generated
directories and lockfiles unless explicitly selected; file, snapshot, output
and search bounds are enforced. Symlink targets are metadata, not followed
outside the scope. Binary, LFS and submodule content can leave limitations.

An unborn repository (`HEAD` without an existing commit) is unsupported for
local review. There is no live-provider quality comparison in the repository:
the evaluation fixture is prepared, not run, and does not score exact wording
or claim that fan-out is universally better. The fixture compares one
comprehensive pass with risk-selected 1–4 passes across cohesive validation,
tenant cache/auth interaction, and a cross-file response contract; patches are
input and are never executed by the runtime.

## Recovery, installation and rollback

On interruption or restart, reconcile durable session IDs and treat unknown
work as interrupted, never successful. Use `status`, then interrupt/drain and
`retry` incomplete slots or prepare a new full round when pins or input no
longer match. Do not use development worktree deletion for review resources.

After an authorized profile installation or configuration change, quit and
restart OpenCode; the running session is not hot reloaded. The isolated real
native-runtime fixture uses the shipped agent prompts and permissions and
exercises the public review tools, local Git pinning, caller handoff, worker
submission, status retrieval, recovery and the deterministic end-to-end
workflow. It does not verify an installed profile or the full external plugin
stack, live authentication, live-provider model quality, or every native
runtime permission. `bun run build`, `bun run test`, and `bun run smoke`
likewise do not prove live routing or installed-profile behavior.

Rollback stops new reviews, retains/report open review IDs and owned artifacts
for a compatible cleanup path, and launches the prior known-good profile.
Reverting the profile does not authorize blind deletion of retained workspaces,
baselines or conversation history.

See [`tests/review-evaluation.json`](../tests/review-evaluation.json),
[`tests/review-runtime.test.ts`](../tests/review-runtime.test.ts), and the
focused review tests for the bounded evaluation fixture and runtime contracts.
The runtime test's evidence is intentionally scoped to those shipped prompts,
permissions, public tools, local Git and deterministic workflow checks.
