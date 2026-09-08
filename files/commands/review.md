---
description: Run a risk-based code review on a change, file, or directory
---

Delegate to the `reviewer` agent to perform an independent code review using the `code-review` skill.

## Scope

**Requested scope:** `$ARGUMENTS`

Resolve the scope as follows:

* No arguments:
    * Review staged changes using `git diff --cached`.
    * Include the staged file list and relevant staged tests/configuration.
* `recent`:
    * Review changes introduced by `HEAD` using `git diff HEAD^ HEAD`.
    * If `HEAD` has no parent, review all tracked files in `HEAD` and state that this is an initial-commit review.
* A commit, branch, tag, range, or revision expression:
    * Review the diff represented by that revision or range.
* One or more file paths:
    * Review the current contents of those files.
    * Also inspect relevant callers, callees, tests, types, configuration, and interfaces as needed to make a defensible assessment.
* A directory path:
    * Review the current contents of source files within that directory.
    * Exclude generated files, dependencies, build artifacts, vendored code, and lockfiles unless they are directly relevant to the requested review.

If the supplied scope is ambiguous, choose the interpretation that reviews the most relevant change with the least unrelated code, and state the interpretation in the review scope.

## Reviewer Instructions

The reviewer must:

1. Load and follow the `code-review` skill as the sole authority for review methodology, finding classification, and output format.
2. Read applicable repository guidance such as `AGENTS.md`, contribution documentation, local conventions, and the relevant task or change description when available.
3. Establish the intended behavior and risk profile before judging the implementation.
4. Inspect enough surrounding context to support findings; do not evaluate changed lines in isolation.
5. Prioritize evidence-backed defects and material complexity introduced by the change:
    * Incorrect or incompatible behavior.
    * Security, privacy, data-integrity, availability, and operational risks.
    * Leaky abstractions, shallow modules, duplicated policy, unnecessary dependencies, and change amplification.
    * Missing or misleading tests, contracts, comments, and error handling.
6. Keep review comments proportionate:
    * Block only confirmed Critical or Major findings.
    * Clearly label non-blocking findings, strong concerns, investigation questions, suggestions, and nits.
    * Do not invent positive observations.
    * Do not report generic checklist advice without a concrete, change-specific consequence.
7. Do not modify files.

Return the complete review exactly in the `code-review` skill’s output format.
