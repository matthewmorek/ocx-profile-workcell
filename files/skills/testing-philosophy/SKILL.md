---
name: testing-philosophy
description: Test design philosophy for application changes. Create focused, durable tests only for meaningful behavior, contracts, and regression risks; avoid coverage-driven and implementation-coupled testing.
---

# Testing Philosophy: Confidence Without Test Bloat

**Role:** Principal Engineer for test design while writing application code.

**Philosophy:** Tests are production code. They must provide meaningful confidence at a lower cost than the regressions they prevent. Do not optimize for coverage, assertion count, or exhaustive branch enumeration.

A healthy test suite protects important behavior while allowing ordinary refactors, copy edits, UI redesigns, and implementation improvements to happen cheaply.

## The 5 Laws

### 1. Test Contracts, Not Construction

- **Concept:** Implementation details are not product behavior.
- **Rule:** Assert what a user, caller, or external system can rely on through a natural interface.
- **Practice:** Test an authorization result, returned value, persisted state, or completed user action—not hook calls, prop forwarding, DOM nesting, helper calls, or callback order.
- **Defense:** A reasonable refactor must not require rewriting unrelated tests.

### 2. Test the Risk, Not Every Branch

- **Concept:** More tests do not automatically create more confidence.
- **Rule:** Add tests for meaningful business rules, state transitions, validation, privacy, authorization, persistence, external contracts, and reproducible regressions.
- **Practice:** Use representative valid, boundary, and invalid cases for a rule. Do not mechanically test every permutation that proves the same thing.
- **Defense:** Prefer types, constrained state models, and clear APIs that eliminate invalid states over large defensive test matrices.

### 3. Put Deterministic Logic Below the UI

- **Concept:** UI-heavy tests are often expensive, brittle, and poor at explaining failures.
- **Rule:** Keep business rules, parsing, transformations, validation, and state decisions in small deterministic modules where practical.
- **Practice:** Unit-test the extracted rule precisely. Add a UI test only when it protects a distinct user interaction or browser-visible risk.
- **Defense:** Do not compensate for logic embedded in a React component by creating a large mock-heavy component test suite.

### 4. Treat Tests as a Maintenance Liability Until Proven Useful

- **Concept:** Every test adds code, runtime, review burden, and refactoring cost.
- **Rule:** A test must catch a specific failure that matters and that is not already covered by types, static checks, existing tests, or cheaper verification.
- **Practice:** Prefer extending an existing focused test over creating a new suite, factory system, snapshot collection, or framework-heavy test harness.
- **Defense:** Do not add a test solely to improve coverage or demonstrate diligence.

### 5. Match Assertions to the Kind of Behavior

- **Concept:** Deterministic and probabilistic systems need different forms of confidence.
- **Rule:** Use exact assertions for deterministic contracts. Use stable properties and acceptance criteria for probabilistic behavior.
- **Practice:** For model-driven behavior, verify schemas, required fields, bounds, safety restrictions, evidence requirements, and safe failure behavior—not exact wording or internal reasoning.
- **Defense:** Do not pretend that string snapshots prove quality for stochastic output.

---

## Write Tests For

Tests are normally justified for:

- Business rules, calculations, parsing, mapping, and non-obvious transformations.
- Meaningful valid, invalid, and boundary behavior.
- State transitions, idempotency, ordering, and concurrency where they matter.
- Privacy, security, authorization, and tenant boundaries.
- Persistence, transactions, database constraints, and data integrity.
- Stable public, provider, framework, API, or protocol contracts.
- Important user workflows that cannot be tested more cheaply below the UI.
- Reproducible defects, when a regression test fits a natural boundary.

## Usually Do Not Write Tests For

Tests are usually not justified for:

- Ordinary copy, headings, product descriptions, helper text, or marketing prose.
- CSS classes, styles, layout, visual polish, animations, or DOM nesting.
- Exact component structure, prop forwarding, local state representation, hook use, or internal helper calls.
- Trivial wrappers, obvious wiring, generated code, and framework behavior.
- Every loading, empty, success, and error rendering permutation.
- Mechanical refactors with no externally observable behavior change.
- Exact generated text, ordering, or reasoning from probabilistic systems.
- Large snapshots whose failures do not clearly identify a meaningful regression.

Exact text assertions are appropriate only when text itself is a functional
contract: for example, legal wording, protocol output, a required accessible
name, or a stable locator with no better semantic alternative.

## Choosing a Test Level

| Behavior                                                                                    | Default test level                                                    |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Pure rule, validation, calculation, or transformation                                       | Unit test                                                             |
| Database constraint, transaction, lock, query, or persistence behavior                      | Real database integration test                                        |
| API or provider contract                                                                    | Integration or contract test                                          |
| Important user interaction                                                                  | Focused UI test                                                       |
| Next.js render pipeline, browser-only behavior, metadata, or provider-bound browser request | Narrow browser test                                                   |
| Styling, layout, copy, and visual polish                                                    | Manual or intentional visual review                                   |
| Model-driven output quality                                                                 | Schema/property checks, curated evaluation cases, sampling, or review |

Use the lowest layer that proves the distinct risk. Do not duplicate the same
assertion at several levels unless each level catches a genuinely different
class of failure.

## Decision Rule

Before writing a test, answer all of these:

1. What exact regression would this test catch?
2. Why would that regression matter?
3. Is this the smallest natural boundary that can catch it?
4. Would the test survive a reasonable refactor?
5. Is the confidence already provided by types, linting, existing coverage, or manual verification?
6. Is the test proportionate to the behavior and risk it protects?

If the answers are weak, do not add the test.

When a meaningful risk remains unautomated because an available test would be
brittle, misleading, redundant, or disproportionate, record the verification
performed in the change summary when useful. Do not invent low-value tests to
avoid explaining that judgment.

---

## Adherence Checklist

Before completing a code change, verify:

- [ ] **Concrete risk:** Can I name the meaningful regression protected by each new test?
- [ ] **Natural boundary:** Does each test use a public or otherwise stable interface?
- [ ] **Behavior over implementation:** Does no test depend on incidental markup, copy, styles, call order, or private structure?
- [ ] **Minimal layer:** Is the test lower and simpler than an equivalent UI or E2E test where possible?
- [ ] **No duplication:** Does existing coverage, typing, linting, or manual verification already provide the same confidence?
- [ ] **Deterministic assertions:** Are exact assertions used only for deterministic contracts?
- [ ] **Probabilistic assertions:** Are model-driven features tested through stable properties rather than exact output?
- [ ] **Maintenance cost:** Would this test remain useful after a reasonable refactor?
