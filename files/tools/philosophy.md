## Engineering Philosophy Skills — MANDATORY

Before writing, modifying, or materially refactoring code, you MUST load the relevant philosophy skill or skills and apply them throughout the task.

### 1. Select the relevant skill

- UI, frontend, client-side state, interaction, styling, layout, accessibility, or responsive behavior:
  - Load `frontend-philosophy`.
- Backend logic, domain modeling, APIs, persistence, integrations, state management, data flow, concurrency, error handling, or refactoring:
  - Load `code-philosophy`.
- Full-stack changes, including frontend code that contains meaningful business logic or state behavior:
  - Load both `frontend-philosophy` and `code-philosophy`.
- Independent code review:
  - Load `code-review`.
  - The `code-review` skill is the authority for review methodology, classification, and reporting format.

### 2. Load before implementation

Load the applicable skill before making implementation decisions.

First inspect repository-local guidance and existing patterns, including relevant `AGENTS.md`, contribution documentation, architecture notes, shared components, domain conventions, tests, and nearby implementations.

The repository's established conventions are the primary local authority. Philosophy skills provide decision criteria for interpreting and extending those conventions; they do not authorize unrelated architectural or visual rewrites.

### 3. Apply principles proportionately

Use the loaded skill to make decisions appropriate to the task's scope and risk.

- Reuse existing components, abstractions, conventions, and patterns when they fit the problem.
- Prefer the smallest coherent change that meets the requirement.
- Do not apply patterns mechanically merely because the skill mentions them.
- Do not introduce a new dependency, component system, abstraction, architectural style, or cross-cutting refactor without a concrete need and clear complexity-reduction benefit.
- When repository conventions conflict with universal accessibility, security, correctness, or data-integrity requirements, preserve the higher-order requirement and explain the conflict.

### 4. Verify before completion

Before reporting completion, verify the implementation against the applicable skill's checklist and the repository's own verification workflow.

At minimum:

- Confirm the required user or system behavior works.
- Check relevant edge cases, failures, state transitions, and compatibility concerns.
- Run applicable formatting, linting, type checking, tests, builds, accessibility checks, or visual-regression checks when available.
- State what was verified and what could not be verified.

### 5. Correct material violations

Fix issues introduced by the change when they create a material problem in correctness, security, accessibility, operational behavior, or long-term complexity.

Do not expand a focused task into an unrelated cleanup campaign. If a broader existing issue is discovered but is outside scope:

- Avoid making it worse.
- Make the smallest safe local accommodation when necessary.
- Clearly note the issue and its impact if it materially affects the implementation or follow-up work.

These skills are mandatory engineering guidance. Their purpose is to produce coherent, maintainable, accessible software that fits the repository—not to enforce rote rules or personal preferences.
