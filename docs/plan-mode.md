# Plan mode

Plan mode defines scope, preserved behavior, and acceptance criteria before
implementation. Plans should identify the existing owner, the missing delta,
non-goals, verification boundary, and any approved compatibility reduction.
Material changes to an accepted plan require renewed approval.

Workcell supports a seamless plan workflow with the optional external
[Plannotator](https://github.com/backnotprop/plannotator) visual review
integration through explicit archive conventions: a user-selected plan can be
read from one exact Markdown file under the selected Plannotator archive, while
the shared root-session plan remains separate. Plannotator is not bundled, and
archive reads are read-only; they do not authorize implementation or replace
the shared plan.

Plan mode does not broaden filesystem access, list archives, select a latest
plan, or treat an `-approved.md` filename as approval. See the packaged
`files/skills/plan-protocol/SKILL.md` for the full format and path rules.
