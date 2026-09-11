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

## Approved probes
- Exact probe, approval, effect, cleanup, and artifact path:

## Next action
- Proposed observation or verification criteria (not an approved fix plan):
```

Before collection, minimize scope and sensitive data. The workflow does not
guarantee redaction before content enters a model transcript, so do not collect
secrets and do not paste raw sensitive receipts. Export to a specific
destination only with explicit approval, and never overwrite existing material.
