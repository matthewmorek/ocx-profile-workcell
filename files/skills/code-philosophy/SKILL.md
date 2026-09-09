---
name: code-philosophy
description: Repository-led software design principles for reducing complexity, preserving clear contracts, and building maintainable systems
---

# Code Philosophy

## Objective

Design and modify software so that it remains easy to understand, change, test, operate, and recover.

The primary goal is to reduce overall system complexity, not to maximize local cleverness, functional purity, file count, abstraction count, or adherence to a universal architecture.

A successful change:
* Satisfies the required behavior and preserves relevant existing contracts.
* Fits the repository's established architecture, conventions, and domain model.
* Makes common use clear and keeps incidental complexity behind appropriate boundaries.
* Limits dependencies, duplicated knowledge, special cases, and hidden side effects.
* Makes failures, invariants, ownership, and recovery behavior understandable.

## When to Use

Use this skill for:
* Implementing or modifying application logic, APIs, services, domain models, state management, persistence, integrations, and background work.
* Refactoring code or deciding whether to split, join, generalize, or localize a module.
* Designing validation, error handling, data flow, concurrency, transaction, and retry behavior.
* Reviewing an implementation for maintainability and long-term code health.

## Repository Discovery Comes First

Before making structural decisions, inspect the repository for local guidance and existing patterns.

Look for:
* `AGENTS.md`, `CONTRIBUTING.md`, architecture documentation, ADRs, and module-level documentation.
* Existing domain terminology, ownership boundaries, and established abstractions.
* Error, logging, observability, retry, transaction, authorization, and validation conventions.
* Existing interfaces, call sites, tests, fixtures, migrations, schemas, and integration contracts.
* Language-specific conventions for nullability, type modeling, effects, asynchronous work, and resource management.

Follow the nearest applicable convention unless it demonstrably creates a material correctness, security, operational, or complexity problem.

Do not introduce a new architectural style, dependency, abstraction framework, state-management pattern, or error model merely because it is generally fashionable.

## The Complexity Test

Treat complexity as anything in the system's structure that makes it harder to understand or modify.

Before adding or changing structure, ask whether it reduces at least one of these:

* **Change amplification:** Will one conceptual change require edits in many unrelated places?
* **Cognitive load:** Must a developer understand unrelated implementation details to use or modify this code?
* **Unknown unknowns:** Is it unclear where a behavior, policy, or invariant is implemented?

Avoid changes that improve one local file while increasing the complexity imposed on callers, neighboring modules, operations, or future modifications.

## Module and API Design

### Create Deep, Coherent Modules

A module may be a function, class, package, service, hook, component, or subsystem. Its purpose is to provide a useful abstraction: substantial capability through an interface that is small, coherent, and easy for callers to understand.

Prefer a boundary that:
* Owns a coherent piece of domain knowledge or a meaningful implementation concern.
* Provides the operations callers need without exposing internal sequencing, storage, protocol, or representation details.
* Handles routine internal mechanics where doing so makes callers simpler.
* Makes the common case easy and discoverable.
* Has an interface that can be understood from its declarations, types, and documentation without reading its implementation.

Do not create shallow abstractions:
* Wrappers that only rename or pass through a small number of values.
* Layers that repeat the same abstraction at different names and locations.
* Generic helpers with many flags, callbacks, or configuration options but little encapsulated behavior.
* Separate classes or files created solely because a method became long.
* “Service,” “manager,” “util,” or “helper” modules that combine unrelated responsibilities without a clear domain concept.

### Hide Information Deliberately

Keep implementation decisions local whenever callers do not need to know them.

Examples of knowledge that often belongs behind a boundary:
* Persistence format, query strategy, cache mechanics, retries, pagination, or transport protocol.
* Internal state transitions and sequencing.
* Validation details that implement a single domain policy.
* Formatting, parsing, normalization, and representation conversion.
* Provider-specific API behavior and error shapes.

Information leakage occurs when the same decision, rule, representation, or workaround must be understood and coordinated in multiple modules.

When a decision appears in more than one place:
1. Identify whether it is one shared policy or genuinely separate behavior.
2. Centralize it behind the module that owns the relevant knowledge when appropriate.
3. Preserve only the information callers truly need in the public interface.

Do not hide information that callers need to make a legitimate domain decision. Expose it clearly as part of the contract rather than forcing callers to infer it from side effects or implementation details.

### Split or Join Based on Complexity

Split modules when separation:
* Hides a distinct body of knowledge.
* Gives callers a simpler interface.
* Removes an undesirable dependency.
* Separates general-purpose capability from feature-specific orchestration.
* Makes testing or operational ownership materially clearer.

Join modules when combination:
* Eliminates duplicated knowledge or coordination.
* Avoids exposing an internal protocol between two modules.
* Gives callers one simpler, more complete operation.
* Keeps closely related state, invariants, and lifecycle behavior together.

Do not split or join code based only on file length, method length, line count, a generic layering rule, or a cyclomatic-complexity threshold.

## Data, Invariants, and State

### Validate at Boundaries, Preserve Invariants Inside

Identify trust boundaries, such as:
* User input, HTTP requests, CLI arguments, webhooks, queues, files, environment configuration, and third-party APIs.
* Database reads when schema history, migrations, external writers, or corruption make assumptions unsafe.
* Cross-service, cross-version, and cross-process communication.

At a boundary:
* Parse, normalize, validate, and authorize untrusted data.
* Convert it into a representation suitable for the local domain.
* Return actionable validation failures at the layer able to communicate them.

Inside a trusted domain boundary:
* Prefer types, constructors, schemas, state transitions, and encapsulation that make invalid use difficult.
* Keep checks that remain necessary because of mutation, concurrency, persistence, version skew, partial failure, or untrusted re-entry.
* State important invariants close to the code that establishes or depends on them.

Do not claim that a type makes an invalid state impossible when runtime inputs, casts, deserialization, database state, or external systems can still violate it.

### Make State Ownership Explicit

For mutable or asynchronous state, make clear:
* Which module owns the state.
* Who may read and change it.
* Which transitions are valid.
* Which operations are atomic, idempotent, cancellable, or retryable.
* What happens under concurrent requests, duplicate delivery, timeout, and partial failure.

Prefer a single owner for each important policy or state transition. Avoid parallel sources of truth unless synchronization, precedence, and recovery are explicit.

Use immutable data or pure functions when they simplify reasoning, testing, or concurrency. Use controlled mutation when it better expresses ownership, lifecycle, performance, or an established repository pattern.

## Control Flow and Effects

### Prefer Clarity Over Mechanical Flattening

Use guard clauses when they make preconditions, error cases, or early completion easier to see.

Keep nesting when it accurately communicates dependent decisions, shared cleanup, or a coherent happy-path structure.

Choose the structure that makes these easiest to answer:
* What conditions must hold before the main work begins?
* What is the normal path?
* Which branches are exceptional, and why?
* Which cleanup, transaction, lock, or resource-lifecycle work must always happen?

Do not refactor solely to reduce indentation. Do not introduce multiple early returns if they bypass required cleanup, obscure result construction, or make resource ownership unclear.

### Make Effects Explicit and Bounded

A function may read, write, mutate, perform I/O, emit an event, update UI state, start a transaction, or allocate a resource. Effects are not inherently bad.

For each meaningful effect:
* Make its ownership and ordering understandable.
* Keep it close to the boundary that needs it, or encapsulate it in a module that owns the concern.
* Avoid surprising hidden effects in functions whose interface implies a query, predicate, conversion, or calculation.
* Avoid duplicate effects under retries, re-renders, concurrent execution, or repeated message delivery.
* Ensure resource acquisition, cleanup, cancellation, and rollback behavior are explicit where relevant.

Prefer a pure core and imperative boundary when that division clarifies the domain. Do not force this pattern where it merely adds indirection or duplicates state.

## Errors and Recovery

### Define Avoidable Errors Out of Existence

Where semantics allow, design APIs and state models so callers do not need to handle routine, harmless special cases.

Examples may include:
* Idempotent operations whose desired end state is already true.
* Empty collections instead of nullable collections where “none” is a normal result.
* A zero-length selection instead of separate “selection exists” state.
* Defaults that express the safe, expected behavior.

Do not redefine an error away when callers need to distinguish the outcome for correctness, security, billing, auditing, recovery, or user communication.

### Handle Errors at the Right Boundary

For each possible failure, decide which layer can do the most useful work.

* **Recover locally:** handle transient or implementation-specific failure inside the module when callers do not need to know the detail.
* **Translate:** convert low-level errors into stable domain or user-facing outcomes at a boundary.
* **Aggregate:** handle related failures in one appropriate higher-level path rather than duplicating handlers throughout the call stack.
* **Propagate:** preserve a failure when the caller must retry, rollback, select an alternative, notify a user, or maintain integrity.
* **Fail fast:** reject violated programmer assumptions or impossible internal states when continuing would corrupt state or conceal a defect.

Never silently discard an error that changes the truth of a user-visible operation, data integrity, security posture, or operational outcome.

Errors must preserve useful context without exposing secrets or unstable infrastructure details to inappropriate layers.

## Naming and Comments

### Name Domain Concepts Precisely

Names should reveal the role and meaning relevant to their scope.

* Use the repository's domain vocabulary.
* Distinguish concepts that have different lifecycles, units, ownership, or semantics.
* Make boolean names describe the condition being tested.
* Include units, time basis, or representation when ambiguity is possible.
* Use short names for small, obvious local scopes; use more descriptive names as scope and lifetime increase.
* Avoid generic names such as `data`, `item`, `result`, `handle`, `process`, `manager`, or `util` when a specific domain concept is available.

Do not expand names merely to make them read as English. Precision and meaningful distinction matter more than prose-like syntax.

### Use Comments to Preserve Non-Obvious Knowledge

Comments are required when code alone cannot communicate the necessary information.

Write or update comments for:
* Public interfaces: behavior, inputs, outputs, side effects, error conditions, and caller obligations.
* Important state: meaning, ownership, allowed values, units, lifecycle, or invariants.
* Non-obvious decisions: why this approach exists, why an alternative is unsafe, and what constraint it preserves.
* Cross-module behavior: protocol, ordering, compatibility, or shared policy that cannot be understood from one file.
* Workarounds: the external issue, limitation, removal condition, and relevant reference.

Do not write comments that merely restate syntax or narrate obvious control flow.

Keep comments close to their code and document each significant design decision in one authoritative place. Update comments whenever the associated behavior or contract changes.

## Design It Twice for Consequential Changes

Before committing to a hard-to-reverse decision, briefly consider at least one credible alternative.

Use this for:
* New public APIs or widely used abstractions.
* Cross-module workflows and shared state.
* Persistence schemas, event formats, and integration contracts.
* Authorization boundaries, transaction boundaries, retries, and failure models.
* New framework-level utilities or component primitives.

Compare alternatives by:
* Interface complexity for ordinary callers.
* Information hiding and dependency reduction.
* Number of special cases and duplicated policies.
* Compatibility, observability, testing, rollout, and rollback costs.
* Expected ease of the next likely change.

Do not create a formal design document for routine, local, low-risk changes. The purpose is to avoid prematurely committing the system to a weak boundary.

## Change Discipline

Keep a change focused on one coherent behavioral or structural objective.

Before adding code:
* Search for existing functionality or patterns that already solve the problem.
* Prefer extending the correct owner over duplicating behavior.
* Identify the contract, invariants, failure modes, and affected callers.
* Avoid speculative generalization for hypothetical future users.

When modifying existing code:
* Preserve behavior that callers rely on unless the task intentionally changes the contract.
* Remove obsolete paths, stale comments, dead flags, and duplicate logic when safely within scope.
* Avoid opportunistic rewrites that expand risk without reducing a concrete source of complexity.
* Add or update tests at the level that proves the required behavior and likely failure modes.

## Verification Checklist

Before completing a change, verify:

* [ ] The implementation follows applicable repository guidance and local architectural conventions.
* [ ] The behavior, contract, inputs, outputs, side effects, and failure modes are clear.
* [ ] The change reduces or at least does not materially increase change amplification, cognitive load, or unknown unknowns.
* [ ] Important knowledge, policy, and representation details have one clear owner.
* [ ] Interfaces expose what callers need but do not leak internal mechanics.
* [ ] State ownership, mutation, asynchronous behavior, retries, and cleanup are understood where applicable.
* [ ] Error handling occurs at the layer that can recover, translate, aggregate, or correctly propagate the failure.
* [ ] Names and comments preserve domain meaning, contracts, invariants, and non-obvious rationale.
* [ ] Relevant happy paths, edge cases, failure paths, compatibility concerns, and operational behavior are tested or explicitly noted as unverified.
* [ ] No new abstraction, dependency, or architecture was introduced without a concrete complexity-reduction justification.

## What Not To Do

* Do not optimize local neatness at the cost of a more complex public interface.
* Do not add abstractions that hide no meaningful complexity.
* Do not duplicate domain policies, validation, representation knowledge, or error translation across modules.
* Do not apply guard clauses, immutability, pure functions, dependency injection, classes, layers, or patterns mechanically.
* Do not use exceptions for routine control flow when an API can express the normal outcome more simply.
* Do not swallow failures that affect correctness, integrity, security, observability, or user intent.
* Do not equate “self-documenting code” with “no comments.”
* Do not pursue speculative generality; make abstractions somewhat general-purpose only when that simplifies the present domain and likely nearby uses.
* Do not introduce a new architectural style without first understanding and respecting the repository's existing design.
