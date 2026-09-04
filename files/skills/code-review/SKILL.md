---
name: code-review
description: Risk-based code review focused on correctness, security, system design, and long-term code health
---

# Code Review Philosophy

## Objective

Review changes for evidence-backed defects and for avoidable complexity.

A review is successful when it:

- Prevents meaningful regressions.
- Preserves or improves the system's ability to be understood and changed.
- Gives the author actionable, proportionate feedback.
- Avoids speculative, preference-driven, or checklist-only noise.

Do not seek perfection. Approve when the change is safe enough for its risk level and improves net code health. Request changes only for material issues.

## When to Use

- Before reporting implementation completion.
- When explicitly asked to review code or using `/review`.
- As an independent audit after a meaningful code change.
- Before merging high-risk changes: public APIs, authorization, billing, data migrations, persistence, concurrency, destructive actions, or cross-service contracts.

## Review Preconditions

Before making findings:

1. Identify the change scope:
   - Changed files and generated files.
   - Intended behavior from the task, PR description, tests, and commit context.
   - Existing conventions and repository guidance, including `AGENTS.md`.
2. Identify risk:
   - User-data, security, availability, financial, compatibility, and rollback risks.
   - Whether the change modifies a public or widely used contract.
3. Establish evidence:
   - Read relevant callers, callees, types, tests, configuration, and error-handling paths.
   - Do not infer runtime behavior from a changed line alone when nearby context can verify it.
   - If tests or tools were not run, say so; do not imply that they were.

## Review Order

### 1. Intent and Contract

Verify that the implementation satisfies the stated behavior and preserves relevant existing contracts.

Check:

- Inputs, outputs, side effects, failure modes, and invariants.
- Compatibility of API, schema, event, and configuration changes.
- Boundary conditions: empty values, nullability, limits, retries, duplicates, ordering, partial failure, and cancellation.
- Whether tests demonstrate the meaningful behavior, not merely implementation details.

### 2. Design and Complexity

Treat complexity as a primary defect category. Look for code that increases:

- **Change amplification:** one conceptual change requires editing many places.
- **Cognitive load:** a developer must understand unrelated details to complete a task.
- **Unknown unknowns:** it is unclear where a behavior is implemented or what must change.

Review module and API design:

- Prefer deep modules: substantial capability behind a small, coherent interface.
- Flag shallow abstractions: wrappers, helpers, or classes that add indirection without hiding meaningful complexity.
- Flag information leakage: implementation decisions, data representations, protocols, validation rules, or business policies that must be known in multiple modules.
- Prefer decomposing around knowledge and responsibility, not merely runtime sequence or controller/service/repository ceremony.
- Pull complexity downward: callers should state their intent, while the module handles internal mechanics, sequencing, and routine error cases where practical.
- Prefer somewhat general-purpose interfaces that serve the problem domain without speculative over-abstraction.
- Check that layers provide different abstractions rather than repeating the same information at different levels.
- For consequential designs, compare the submitted structure with one plausible alternative. Report the concern only if the alternative materially reduces dependencies, interface complexity, or future change cost.

### 3. Correctness and Resilience

Check:

- Logic, state transitions, invariants, and algorithmic correctness.
- Error handling, cleanup, retries, idempotency, and partial-failure behavior.
- Type, nullability, bounds, overflow, encoding, time-zone, and concurrency hazards.
- Data loss, corruption, duplicate side effects, and unsafe migration or rollback paths.
- Tests for the changed behavior and its most likely failure modes.

### 4. Security and Privacy

Check according to the change's threat model:

- Authentication, authorization, tenancy, and object-level access control.
- Validation at trust boundaries and injection risks.
- Secrets, credentials, tokens, personally identifiable information, and sensitive logs.
- Unsafe deserialization, file access, redirects, SSRF, command execution, and dependency exposure.
- Security-relevant defaults, auditability, and failure behavior.

Do not suppress a plausible high-impact security concern solely because it cannot be proven through static review. Label it as an investigation item unless there is sufficient evidence to make it a finding.

### 5. Performance and Operations

Report only concrete, context-supported concerns.

Check:

- Query counts and unbounded scans on request paths.
- Expensive work in loops, hot paths, or synchronous user interactions.
- Memory retention, resource cleanup, backpressure, and concurrency limits.
- Caching only when its invalidation, consistency, and lifecycle are sound.
- Logging, metrics, tracing, alerts, feature flags, migrations, and rollback for operationally significant changes.

Do not report generic advice such as “add caching,” “use lazy loading,” or “reduce cyclomatic complexity” without a demonstrated consequence.

### 6. Documentation and Naming

Check whether comments and names communicate information that code alone cannot:

- Public interfaces explain what they do, their contract, and meaningful edge cases.
- Comments explain intent, rationale, invariants, non-obvious constraints, and trade-offs—not a line-by-line restatement of code.
- Names reflect the relevant domain concept and distinguish similar ideas.
- Cross-module decisions are discoverable where future maintainers will need them.

## Evidence, Confidence, and Severity

Classify every comment by both severity and evidence.

| Classification         | Meaning                                                                            | Merge Effect                                                   |
| ---------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Confirmed finding      | Directly supported by code, tests, specifications, or reproducible reasoning       | Block only if severity is Major or Critical                    |
| Strong concern         | Likely issue with clear reasoning, but one missing fact prevents confirmation      | Normally non-blocking; request verification or a targeted test |
| Investigation question | A high-impact possibility that cannot be established from available context        | Non-blocking unless project policy requires verification       |
| Suggestion             | Improvement that is not necessary for correctness, safety, or material code health | Non-blocking                                                   |
| Nit                    | Optional polish or educational note                                                | Non-blocking                                                   |

| Severity | Criteria                                                                                                  | Expected action                                |
| -------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Critical | Exploitable security flaw, data loss/corruption, broad outage, irreversible incompatible change           | Must fix before merge                          |
| Major    | Probable user-visible bug, authorization failure, serious resilience issue, or material design regression | Must fix before merge                          |
| Minor    | Real but limited maintainability, test, performance, or operational issue                                 | Fix now when cheap; otherwise track explicitly |
| Nit      | Non-material polish                                                                                       | Optional                                       |

Rules:

- A confirmed Major or Critical finding needs high confidence and a concrete explanation.
- Do not convert uncertainty into an assertion.
- Do not hide high-impact uncertainty: label it as a strong concern or investigation question.
- Do not use a numerical confidence percentage unless it adds decision-relevant meaning.
- Prefer a small number of high-signal comments over exhaustive low-value commentary.

## Comment Quality

Each blocking finding must include:

1. **Anchor:** `file:line`, symbol, API, test, or clearly identified code range.
2. **Observed behavior:** what the code does under specified conditions.
3. **Impact:** why it matters and who or what is affected.
4. **Reasoning:** the shortest evidence chain establishing the issue.
5. **Resolution direction:** a concrete fix, invariant, or question that would resolve the concern.

Use this form:

> **[Major][Confirmed]** `path/to/file.ts:42`  
> When `userId` is absent, this branch defaults to the requested record instead of rejecting the request. A caller can therefore access another user's record if it knows the identifier. Require an authenticated subject and enforce ownership before loading or returning the record.

For design feedback, name the principle and consequence:

> **[Minor][Confirmed]** `OrderController`, `OrderService`, `OrderValidator`  
> Validation rules for order state are duplicated across three layers. This leaks one business policy across modules, so adding a state will require coordinated edits and risks inconsistent behavior. Centralize state-transition validation behind the order-domain interface.

## Output Format

# Code Review

## Scope

- Files reviewed:
- Relevant surrounding code examined:
- Tests, linters, builds, or analysis run:
- Not verified:

## Verdict

`APPROVE` | `APPROVE_WITH_SUGGESTIONS` | `REQUEST_CHANGES` | `NEEDS_DISCUSSION`

## Assessment

Two to four sentences covering intended behavior, risk level, and the most important conclusion.

## Blocking Findings

List Critical and Major confirmed findings. If none, write `None`.

## Non-Blocking Findings

List Minor confirmed findings and Strong Concerns. Clearly label each.

## Investigation Questions

List only high-impact unknowns that need targeted verification. If none, omit this section.

## Suggestions and Nits

List optional improvements. If none, omit this section.

## Design Assessment

Address only applicable points:

- Interface simplicity and module depth.
- Information hiding or leakage.
- Dependency and change-amplification effects.
- Whether complexity is pulled into an appropriate boundary.
- Whether comments preserve non-obvious design intent.

## Positive Observations

Include only specific, evidence-based observations. Omit this section if none are warranted.

## What Not To Do

- Do not treat every checklist item as equally relevant.
- Do not make unverified claims about runtime behavior, security, or performance.
- Do not block a change over personal preference.
- Do not demand broad refactors without tying them to a material complexity or risk reduction.
- Do not praise generically or invent positive feedback.
- Do not modify files during a review unless explicitly asked to implement fixes.
- Do not approve a change without reviewing its scope, contract, risk, and relevant context.
