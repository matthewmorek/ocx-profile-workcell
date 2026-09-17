---
description: Start, resume, inspect or close an isolated PR or local code review
agent: review
---

Call `review_start` with scope `$ARGUMENTS` and a `handoff` object: `requirements` (essential caller specification), `constraints` (bounded strings), and `evidence` (objects with `reference` and essential `summary`). On resume, supply a revised handoff only when the caller's brief changed. The new root cannot assume access to this conversation's shared plan. Return the review ID and dedicated session reference; do not delegate directly to `reviewer` from this entry or review in the initiating conversation.

No arguments means staged changes. `recent` means HEAD's change (all tracked files for an initial commit). A revision/range selects committed changes; file/directory scopes select current content. Bare numbers retain revision/path meaning. Use `path:<path>` or a path array when ambiguous.

A GitHub PR URL selects that exact PR. `pr <number>` (also `#123` or `pr:123`) selects a PR against this project's verified origin, never the current branch's implicit PR. Preserve the target and known repository identity in the handoff; request a PR URL when repository identity is ambiguous. The dedicated coordinator verifies identity, pins the PR head in private Git storage, and rechecks freshness before reporting. It never substitutes the initiating checkout for a mismatched PR head. Report unavailable or stale evidence explicitly; findings stay local. Standalone reviewer assignments retain their separate read-only GitHub evidence workflow.

Use `resume <ID>`, `status <ID>` or explicit `close <ID>` for retained reviews. Keep the response concise. Reporting does not close workspaces. Do not publish findings, change the source checkout/index/refs, or execute target code/tests.
