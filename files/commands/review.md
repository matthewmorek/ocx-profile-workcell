---
description: Start or resume an agent-guided isolated review
agent: review
---

For a new review, call `review_start(action="start", separate=true, request=<scope plus essential caller requirements/evidence>)` with scope `$ARGUMENTS`. This command creates a separate root even if invoked in another conversation using the review agent. Return the workspace/session IDs; do not delegate from this initiating turn.

For `resume <ID>`, call `review_start(action="resume", separate=true, id=<ID>, request=<new requirements or scope context>)` to resume that dedicated root rather than attach this initiating conversation. For `status <ID>`, return the workspace paths so the review primary can read its ledger with native tools. For explicit `close <ID>`, use `review_start(action="close", id=<ID>)`; preserve the final report in the conversation first. Never use development worktree deletion for review resources.

No arguments means staged changes; `recent` means HEAD's change (all tracked files for a root commit). Preserve revision/range, file/directory and `path:` scopes. Equal range endpoints mean an empty diff. PR URL or explicit `pr <number>` (`#123`/`pr:123` aliases) means the verified repository's PR, not the implicit current-branch PR. Bare numbers retain local revision/path meaning. The review agent resolves these scopes using native tools and the code-review skill, not a custom parser.
