# Tracker-neutral issue draft

Use one draft for the investigation. Mark it **Draft—not submitted** and never
invent an issue URL, ID, owner, severity, or confirmed cause.

```markdown
# [Concise observed failure]

Status: Draft—not submitted

## Scope and environment
- Account/project:
- Workcell/OpenCode/tool versions:
- OS and relevant runtime:
- Observation cutoff and timezone:
- Expected:
- Actual:
- Observed impact:

## Reproduction status
- Executed reproduction: yes/no (command and result)
- User-reported behavior:
- Proposed but not executed probe:

## Timeline
- [timestamp, timezone] event or change

## Evidence
- E1 — source, timestamp, command or stable URL/path/line, bounded redacted snippet

## Sources and delegation
- Direct source:
- Delegation reference and question:
- Corroboration status:

## Analysis
- Facts:
- Inference and confidence:
- Supporting evidence:
- Conflicting, negative, or failed findings:
- Alternatives and unknowns:

## Probes and operational actions
- Exact command/target, native authorization outcome, effect, cleanup, artifact path:
- Denied observation, if any: exact tool/path/native error as observed; executing agent and relevant rule if available (otherwise unknown); unavailable evidence and independent allowed findings:
- Restart, if any: pre-restart evidence, interruption, timeout, before/after outcome, final process/application/user-service state:
- Network probes, if any: target-selection evidence, hostname, resolved/tested address, route/interface or unknown, port/protocol, DNS/TCP/TLS/HTTP outcomes, timeout/retry/traffic/output bounds, relevant resolver/proxy/remote-log exposure (no secrets):

## Next action
- Proposed observation or verification criteria (not an approved fix plan):
- If persistent source/configuration/dependency repair is needed: link to Build handoff; user switches to Build and requests implementation.
```

## Build handoff (only when persistent repair is needed)

This is a compact report section, not implementation or approval. Link it from
the issue draft's next action; do not automatically switch modes or dispatch
tools/repair children. Debug's task and plan tools remain denied.

```markdown
## Build handoff
Status: Not implemented—not an approved fix plan
- Failure: expected versus actual behavior:
- Evidence references and negative/failed findings:
- Root-cause confidence and remaining unknowns:
- Exact files/components requiring repair (or explicitly unknown):
- Proposed bounded repair requirements and constraints:
- Acceptance criteria and exact verification commands (mark unavailable commands/requirements unknown rather than inventing them):
- Operational actions already taken and post-operation process/application/user-service state (including stopped or unknown):
- Accepted-plan task references (only if supplied; otherwise omit—bounded user requirements suffice):
- Unverified risks:
- Next action: Switch to Build and request implementation of the bounded repair.
```

Do not call `plan_read`, invent task references, or mandate a plan to fill this
report. Include enough evidence and constraints for Build to assess the repair
without treating the handoff itself as an approved fix plan.

Before collection, minimize scope and sensitive data. The workflow does not
guarantee redaction before content enters a model transcript, so do not collect
secrets and do not paste raw sensitive receipts. Export to a specific
destination only with explicit approval, and never overwrite existing material.
