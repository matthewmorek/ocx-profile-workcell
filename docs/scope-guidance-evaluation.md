# Scope-control guidance: manual evaluation cases

These three repository-only cases are interpretation samples for the profile's
scope guidance. Three single read-only samples were completed on 2026-09-21;
they are not harness tests. This is not an end-to-end Plan/Build evaluation or
comparative efficacy proof, and it does not claim live Linear access or future
model adherence.

## Recording protocol

For each sample, record the model/runtime, instruction and fixture revisions,
the exact prompt, the complete answer, and concise evidence for the rubric.
Do not score exact wording, line count, or use of a prescribed abstraction.
Accept a different design when it preserves the stated boundary and risk.

The samples used reviewer configuration `openai/gpt-6-astra` with native
Workcell delegation. The proposed guidance files were explicitly read: the
shared philosophy and, respectively, the frontend, code, and testing guidance.
The basis was G1 at commit `7f6fa7e360604575e3dca791bc7192a20f4c615a`, plus
the in-progress D1 skill-name and delivery edits. No application was executed,
and evaluator rubrics were withheld from the samples.

## Case A — small UI delta

**Prompt.** “Existing `UploadRow` receives `filename`, `status`, `attempt`,
`error`, and `onRetry`; `attempt` is already tracked by the parent and passed
but is not rendered. The row handles loading/error/success, uses existing
accessible status markup, and has an existing focused rendering test file.
Retry policy/state transitions are tested below the UI. Request: show ‘Attempt
N’ only while retrying, with no behavior/API changes. Propose the implementation
and proportionate verification.”

**Evaluator-only anchors.** Pass when the answer makes the narrow rendering
change in `UploadRow`, preserves the existing contract and accessibility
markup, and uses focused rendering verification while leaving lower-level retry
tests in their existing boundary. Fail when it changes behavior/API shape or
adds speculative architecture, unrelated test scope, or redundant lower-level
coverage.

**Observed sample.** The answer chose a local conditional Attempt label, with
no new component, state, provider, or API; it preserved parent ownership and
accessibility. It reused existing appear/update/disappear render coverage and
suggested absence checks across initial, error, and success states. This met
the stated scope criteria, with a caution that several absence checks may be
redundant; the sample does not prove an ideal minimal test selection.

## Case B — real backend invariant

**Prompt.** “An existing billing endpoint authorizes tenant access; then it
independently reads `request_receipts(tenantId,requestId)`, debits the account,
and writes the receipt/response. The datastore already supports transactions
spanning the account and receipt. Retries and concurrent duplicate requests
currently can double-debit; a successful response can be lost. Requirement:
at-most-once debit, the same result on retry, and authorization on every
request. Propose the smallest correction and verification using the described
repository capabilities.”

**Evaluator-only anchors.** Pass when the answer requires a transactional
same-key receipt plus effect, reauthorization on every request, and verification
of retries, concurrency, duplicate prevention, and result reuse. Equivalent
designs are acceptable when their guarantees are justified. Fail when it uses a
client-only or in-memory-only shortcut, a generic workflow framework, or a
design that can bypass authorization or separate the receipt from the effect.

**Observed sample.** The answer retained the existing account-and-receipt
transaction, same-key stored response, authorization on every replay, and
conflict/isolation checks, with focused real-concurrency, lost-response, and
authorization tests. It introduced no new service, store, or framework and
met the stated criteria.

## Case C — test-infrastructure proposal

**Prompt.** “Existing `StatusSummary` renders counts passed as props and invokes
the supplied `onRetry`; a render helper and component tests are already
available, and existing reducer tests own count arithmetic. The request is to
display the failed count and wire the existing retry callback. The proposed
implementation adds app-wide fetch mocking/new fixture ownership layer, tests
of the fixture, an SSR subprocess, and 1000/5000-item event-count benchmarks.
There are no network requests in the component and no changed scale/performance
requirement. Assess the proposed implementation/verification scope; choose what
should ship and explain the distinct risks.”

**Evaluator-only anchors.** Pass when the answer ships the focused prop/render
and interaction change with existing component evidence, leaves count arithmetic
to reducer tests, and rejects unrelated app-wide infrastructure, SSR, and
benchmarks absent a stated risk. Do not require zero tests: retain focused
render/interaction evidence. Fail when it accepts broad infrastructure without
need or dismisses all verification categorically.

**Observed sample.** The answer limited the change to failed-count display and
the existing callback, reusing render/interaction tests and arithmetic tests.
It rejected fetch mocks, fixture ownership/tests of the fixture, an SSR
subprocess, and 1000/5000-item benchmarks because the stated risks did not
justify them. It met the stated criteria.

## Status and limits

Record unknowns rather than inferring repository facts. Results must not be
presented as exact wording/LOC scores, as a live Plan/Build evaluation, or as proof
of real service access. They do not establish that future sessions will follow
the guidance or guarantee absence of test bloat.
