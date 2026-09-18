# Grounded frontend guidance: manual evaluation cases

These four read-only, repository-only cases evaluate the brief **“Ground UI
planning and implementation in existing product structure.”** They are manual
behavioral probes, not implementation tests. Packaging and string checks are not
proof of model behavior; these controlled scenarios can test interpretation of
guidance, but cannot prove an installed Plan/Build runtime or real application
UX.

## Recording protocol

For each case, record:

1. model and runtime identifier;
2. instruction/profile revision and fixture revision;
3. the exact prompt;
4. the complete answer (including proposed plan, API changes, and caveats);
5. pass/fail reasoning against the evaluator-only rubric below.

Do not score exact wording, line count, or use of a mandatory abstraction.
Accept multiple justified solutions. Judge observable behavior separately from
structural fit, and record unknowns rather than inferring repository facts.

## Case A — original upload PRD, grounded in the fixture

**Fixture (hypothetical; not inspected Roboflow source).** A fictional React
repository already contains `MediaUploadMiniWidget` and
`DatasetUploadMiniWidget`. A shared upload-row state owner supplies each row's
`file`, `status`, `attempt`, `progress`, `error`, and stable upload id to the
rendering components. Existing Agent task context and its composed message are
the caller's responsibility and must remain intact. The upload service exposes
`uploadUrl`, `transfer`, and `finalize` stages; each stage can return a
transient or terminal failure. The original PRD requires each file to move
through `queued`, `uploading`, `retrying`, `succeeded`, and `failed`; bounded
transient retries with backoff at all three stages; no re-upload of successes;
idempotency that prevents duplicate attachments/assets; retry UI showing the
filename and attempt; and, after exhaustion, a list of every failed filename
with a useful error plus **Retry failed files**. Batch progress must accurately
represent successes, retries, and permanent failures. Agent task context and
the composed message must be preserved. A related persistent background
pipeline issue is provided as context only, not automatic scope.

The request is specifically the original PRD. Individual **Retry**/**Ignore**
controls are a later proposed clarification and are not accepted requirements
for this case; the model may ask for clarification or defer that extra proposal.

**Prompt (show only this to the model).** “Plan a small implementation for the
original-PRD scope described in this fixture. Explain how you would fit it into
the existing components without discovering or inventing more repository
facts. Do not silently add later proposals or unrelated product scope; you may
ask a clarification question or explicitly defer an extra proposal.”

**Evaluator-only rubric.** Pass when the answer:

- handles per-file state and accurate batch progress, preserving completed
  successes while other files retry or fail;
- uses bounded transient retry/backoff independently at URL, transfer, and
  finalize stages, with idempotent requests and stable filename/attempt data;
- exposes terminal filename and error, plus a **Retry failed files** action;
- preserves the Agent task and composed message rather than silently changing
  that contract; and
- distinguishes the original PRD from a later clarification proposing
  individual **Retry**/**Ignore** controls. The clarification is not a
  requirement here. The related background persistence issue is context, not a
  requirement.

Fail if it loses successful rows, retries forever, treats a batch as one
indivisible state, changes the Agent contract without authorization, or adds
either later clarification as original scope. A different state machine or
component placement can pass when it preserves these behaviors.

## Case B — two workflows, separate compositions

**Fixture.** The same fictional product has (1) a media-library import flow:
many files, previews, resumable progress, cancel, and batch completion; and
(2) a dataset-row import flow: one dataset record at a time, schema validation,
row-level errors, and a required “review before commit” step. Both flows use a
shared `useUploadTransport({ onProgress, onComplete, onError })` hook and a
shared accessible `UploadStatusRow`, but their owners, actions, and completion
policies differ.

**Prompt.** “Propose a grounded UI plan for these two workflows. Identify what
can be shared and how each composition should remain understandable in its
existing flow.”

**Evaluator-only rubric.** Pass when the answer recognizes genuinely different
user workflows, keeps separate compositions where their orchestration and
semantics differ, and reuses the stated transport/status parts where useful.
It may choose different valid boundaries. Fail when it forces both flows into
a mega-widget with mode flags, or duplicates all shared behavior without a
reason. A justified shared coordinator can pass if the workflow-specific
composition and ownership remain clear; exact component names are not tested.

## Case C — one error presentation, local extension

**Fixture.** An existing `MediaUploadMiniWidget` already owns upload-row
layout, keyboard behavior, labels, and its public props. The requested change
is one additional inline error presentation for terminal failures. Its parent
already supplies `onRetry(fileId)`; no other consumer requests a new upload
provider, compound-component API, or framework abstraction.

**Prompt.** “Plan the smallest grounded change that adds the requested terminal
error presentation while preserving existing behavior and accessibility.”

**Evaluator-only rubric.** Pass when the answer extends the existing component
locally, reuses its state/action path, preserves keyboard and accessible error
association, and avoids unrelated public API churn. A small shared presentational
helper may pass if concrete reuse requires it. Fail when it automatically
introduces a provider, compound API, generic UI framework, or broad refactor
without evidence that the fixture needs one. Do not require a particular JSX
shape or helper name.

## Case D — preserve an established React API

**Fixture.** `UploadPanel` is a React 18 component. Its established API is a
`children` render prop: `children({ files, progress, retryFailed })`. The
`UploadPanel` invokes the caller-provided render function with those data and
actions; the caller receives them rather than supplying them through the
callback. Some consumers use the supported React `useContext` API for
unrelated upload configuration. Existing tests and consumers rely on React 18
compatibility. The requested UI addition only needs to display an extra
progress summary.

**Prompt.** “Plan this UI addition while fitting the established API and React
18 support in the fixture. Call out any migration only if it is necessary.”

**Evaluator-only rubric.** Pass when the plan retains the data-supplying render
prop and React 18 compatibility, uses the existing `files`, `progress`, and
`retryFailed` contract, and treats supported `useContext` as valid rather than
as a defect. A migration can pass only if the answer demonstrates necessity,
defines compatibility/rollout impact, and explicitly treats it as requiring
authorization. Fail when it replaces the render prop by default, upgrades or
breaks React compatibility, or “fixes” `useContext` merely because another
pattern is preferred.

## Scope and interpretation

These fixtures are hypothetical and intentionally self-contained; no case
claims to have been run, and none establishes the behavior of a real product.
The evaluator should reward evidence-based reuse, correct state and failure
handling, accessibility, and API preservation while rejecting unrequested
product scope. An answer may fail for missing behavior even if its structure
looks familiar, or pass with an unfamiliar structure when its behavior and
integration reasoning are sound.

Earlier evidence used an incomplete version of Case A, with key requirements
withheld from the model; rerun Case A before treating it as acceptance evidence.
Cases B–D have only favorable single read-only interpretation samples. They are
not an installed Plan/Build result, comparative efficacy study, or full
behavioral pass, and Case A has not been rerun here.
