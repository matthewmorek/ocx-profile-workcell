---
name: plan-protocol
description: Guidelines for creating and managing implementation plans with citations
---

# Plan Protocol

> **Load this skill** when creating or updating implementation plans.

## TL;DR Checklist

When creating or updating a plan, ensure:

- [ ] YAML frontmatter with `status`, `phase`, `updated`
- [ ] `## Goal` section (one sentence)
- [ ] `## Context & Decisions` table with provenance (user constraints, repository paths/sections, or `ref:delegation-id` for delegated research)
- [ ] Phases with status markers: `[COMPLETE]`, `[IN PROGRESS]`, `[PENDING]`
- [ ] Tasks with hierarchical numbering (1.1, 1.2, 2.1)
- [ ] Only ONE task marked `← CURRENT`
- [ ] Citations for all research-based decisions

---

## When to Use

1. Starting a multi-step implementation
2. After receiving a complex user request
3. When defining or substantively revising a multi-phase design
4. After research that informs architectural decisions

## When NOT to Use

1. Simple one-off tasks → use built-in todos instead
2. Pure research/exploration → use delegations only
3. Quick fixes that don't need tracking
4. Single-file changes with no dependencies

---

## Plan Format

Use `plan_save` with this exact markdown format:

```markdown
---
status: STATUS
phase: PHASE_NUMBER
updated: YYYY-MM-DD
---

# Implementation Plan

## Goal

ONE_SENTENCE_DESCRIBING_OUTCOME

## Context & Decisions

| Decision | Rationale | Source              |
| -------- | --------- | ------------------- |
| CHOICE   | WHY       | `ref:DELEGATION_ID` |

## Phase 1: NAME [STATUS_MARKER]

- [x] 1.1 Completed task
- [x] 1.2 Another completed task → `ref:DELEGATION_ID`

## Phase 2: NAME [IN PROGRESS]

- [x] 2.1 Completed task
- [ ] **2.2 Current task** ← CURRENT
- [ ] 2.3 Pending task

## Phase 3: NAME [PENDING]

- [ ] 3.1 Future task
- [ ] 3.2 Another future task

## Notes

- YYYY-MM-DD: Observation or decision `ref:DELEGATION_ID`
```

### Frontmatter Fields

| Field     | Values                                              | Description          |
| --------- | --------------------------------------------------- | -------------------- |
| `status`  | `not-started`, `in-progress`, `complete`, `blocked` | Overall plan status  |
| `phase`   | Number (1, 2, 3...)                                 | Current phase number |
| `updated` | `YYYY-MM-DD`                                        | Last update date     |

### Phase Status Markers

| Marker          | Meaning                   |
| --------------- | ------------------------- |
| `[PENDING]`     | Not yet started           |
| `[IN PROGRESS]` | Currently being worked on |
| `[COMPLETE]`    | Finished successfully     |
| `[BLOCKED]`     | Waiting on dependencies   |

---

## State Machine

### Plan Lifecycle

```
not-started → in-progress → complete
                         ↘ blocked
```

### Phase Lifecycle

```
[PENDING] → [IN PROGRESS] → [COMPLETE]
                         ↘ [BLOCKED]
```

### Task Lifecycle

```
[ ] unchecked → [x] checked
```

### Critical Rules

1. **Only ONE phase** may be `[IN PROGRESS]` at any time
2. **Only ONE task** may have `← CURRENT` marker at any time
3. **Treat markers as a saved snapshot**, not authoritative live execution progress
4. **Track routine progress separately** in task results and primary-session context; do not rewrite or delegate updates to the full plan for each completed task

The accepted shared plan is the design reference. Save substantive design revisions, not unchanged content or progress-only updates. Children read it directly with `plan_read` when context is missing or known to have changed; handoffs reference bounded task IDs or sections rather than copying the plan. Saving does not initiate review.

### Shared plan and explicit archive reads

Call `plan_read({ reason })` without `path` for the Workcell root-session shared
plan. For a user-selected Plannotator archive, call it with the exact absolute or
`~/` path and a reason, for example:

```text
plan_read({
  reason: "Review the user's approved archive plan",
  path: "~/.plannotator/plans/example-approved.md"
})
```

The explicit path selects one exact regular `.md` file under the startup-selected
default archive's `plans` directory. It supports absolute and `~/` paths only; it
does not list, glob, interpolate, or select the latest file. It rejects symlinks and
nonregular files, and rejects files over 1 MiB rather than truncating them. The
archive root is captured at startup from nonblank `PLANNOTATOR_DATA_DIR`
(`~` expansion; relative values use the process working directory), then an existing
`~/.plannotator`, then absolute `XDG_DATA_HOME/plannotator`, then
`~/.plannotator`; the reader appends `plans` to that root. This is intentionally
cross-project archive access for agents already permitted `plan_read`.

Archive content is returned as raw Markdown: it is not parsed by the shared-plan
reader, saved, automatically promoted or approved, or used to overwrite the shared
plan. A filename such as `-approved.md` is not authorization, and user scope
dominates. Report missing or conflicting sources rather than falling back to the
shared plan or guessing another source. Workers should use this custom reader with
the exact parent/user-selected path; do not use ordinary `Read` outside the
workspace or a no-path fallback.
Explore and researcher permissions remain unchanged. Custom archives and other
archive tools are deferred; arbitrary external filesystem access is not available.

Deliberate promotion with `plan_save` requires adapting the archive content to the
Workcell format while preserving approved scope. Material changes require renewed
approval. Reading, filenames, and saving do not authorize implementation.

---

## Citations & Delegations

### Where Citations Come From

Cite the actual basis of each decision: an explicit user constraint, an established repository convention with its path/section, or relevant research. These are valid provenance; not every decision needs external research. Request research only for material unresolved external or version-sensitive claims. Never manufacture citations or commission research merely to fill the Source column.

For delegated research, the flow is:

1. You delegate research: `delegate` to `researcher` or `explore`
2. Delegation completes with a readable ID (e.g., `swift-amber-falcon`)
3. You cite that research in the plan: `ref:swift-amber-falcon`

### When to Cite

| Situation                                | Action                           |
| ---------------------------------------- | -------------------------------- |
| Architectural decision based on research | Add to Context & Decisions table |
| Task informed by research                | Append `→ ref:id` to task line   |
| Implementation detail from research      | Inline citation in Notes         |

### How to Find Delegation IDs

- Reuse relevant delegation IDs and evidence already in context
- Use `delegation_list()` only when a relevant artifact ID is unknown
- Use `delegation_read("id")` when its content is missing and needed before citing

### ❌ NEVER

- Make up delegation IDs
- Cite without actually reading the delegation
- Skip citations for research-based decisions

---

## Examples

### ✅ CORRECT: Well-formed plan

```markdown
---
status: in-progress
phase: 2
updated: 2026-01-02
---

# Implementation Plan

## Goal

Add JWT authentication with refresh token support

## Context & Decisions

| Decision                | Rationale                                    | Source                   |
| ----------------------- | -------------------------------------------- | ------------------------ |
| Use bcrypt (12 rounds)  | Industry standard, balance of security/speed | `ref:swift-amber-falcon` |
| JWT with refresh tokens | Stateless auth, mobile-friendly              | `ref:calm-jade-owl`      |

## Phase 1: Research [COMPLETE]

- [x] 1.1 Research auth patterns → `ref:swift-amber-falcon`
- [x] 1.2 Evaluate token strategies → `ref:calm-jade-owl`

## Phase 2: Implementation [IN PROGRESS]

- [x] 2.1 Set up project structure
- [ ] **2.2 Add password hashing** ← CURRENT
- [ ] 2.3 Implement JWT generation

## Phase 3: Testing [PENDING]

- [ ] 3.1 Write unit tests
- [ ] 3.2 Integration tests

## Notes

- 2026-01-02: Chose bcrypt over argon2 for broader library support `ref:swift-amber-falcon`
```

### ❌ WRONG: Missing frontmatter

```markdown
# Implementation Plan

## Goal

Add authentication
```

**Error:** Plan must have YAML frontmatter with status, phase, updated.

### ❌ WRONG: Multiple CURRENT markers

```markdown
## Phase 2: Implementation [IN PROGRESS]

- [ ] **2.1 Task one** ← CURRENT
- [ ] **2.2 Task two** ← CURRENT
```

**Error:** Only one task may be marked CURRENT.

### ❌ WRONG: Decision without citation

```markdown
## Context & Decisions

| Decision  | Rationale | Source |
| --------- | --------- | ------ |
| Use Redis | It's fast | -      |
```

**Error:** This performance claim lacks supporting provenance. Cite relevant evidence with `ref:delegation-id` when research informed it; if the choice instead follows a user constraint or established repository convention, identify that actual source without inventing research.

### ❌ WRONG: Invalid phase status

```markdown
## Phase 1: Research [DONE]
```

**Error:** Use `[COMPLETE]`, not `[DONE]`. Valid markers: `[PENDING]`, `[IN PROGRESS]`, `[COMPLETE]`, `[BLOCKED]`.

---

## Troubleshooting

| Error Message              | Fix                                                                       |
| -------------------------- | ------------------------------------------------------------------------- |
| "Missing frontmatter"      | Add `---\nstatus: in-progress\nphase: 1\nupdated: 2026-01-02\n---` at top |
| "Multiple CURRENT markers" | Remove `← CURRENT` from all but the active task                           |
| "Invalid citation format"  | Use `ref:delegation-id` format (e.g., `ref:swift-amber-falcon`)           |
| "Missing goal"             | Add `## Goal` section with one-sentence description                       |
| "Empty phase"              | Add at least one task to each phase                                       |
| "Invalid phase status"     | Use `[PENDING]`, `[IN PROGRESS]`, `[COMPLETE]`, or `[BLOCKED]`            |

---

## Before Saving Checklist

Before calling `plan_save`, verify:

- [ ] **Frontmatter:** Has status, phase, and updated date?
- [ ] **Goal:** Is there a clear, one-sentence goal?
- [ ] **Provenance:** Are user/repository decisions attributed to their actual source, and delegated research-based decisions cited with `ref:id`?
- [ ] **Single CURRENT:** Is exactly one task marked `← CURRENT`?
- [ ] **Valid markers:** Do all phases use valid status markers?
- [ ] **Hierarchical IDs:** Are tasks numbered correctly (1.1, 1.2, 2.1)?
