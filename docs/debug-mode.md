# Debug mode

Workcell 0.3.0 makes `debug` the primary observation-first investigator. It
diagnoses project, macOS, and connected-service failures with direct bounded
tools plus narrowly assigned asynchronous research. It does not edit tracked
source, implement repairs, mutate remote services, publish, install, authenticate,
change the active project, or escalate privileges. The separate `debugger` child
remains the repair path and is not the investigation workflow.

The normal responsibility boundary remains: `plan` decides scope and acceptance,
`build` changes implementation, and `debug` investigates observed failures.

## Start a session

The pinned CLI accepts the agent selector:

```sh
opencode --agent debug
```

After configuration-time changes, restart OpenCode. For the installed profile,
start a fresh session with `ocx oc -p workcell`, then use the interactive agent
selector. OCX argument forwarding beyond the documented CLI selector is not
asserted here.

## Investigation model

The primary first establishes scope and reads existing evidence. It then compares
known-good and failing cases, ranks falsifiable hypotheses, and asks approval for
the smallest discriminating read or local scratch probe. Reproduction and a
confirmed root cause are optional; a concise, evidence-rich inconclusive report
is a successful outcome.

`explore` (OpenCode model `gpt-5.6-luna`) may answer independent repository
questions, and `researcher` (`gpt-5.6-terra`) may answer independent public,
version-sensitive questions. Both remain asynchronous with their existing
permissions. Debug sends each child a sanitized self-contained question and
reads the result only after notification. It never delegates system commands,
authenticated service access, privileged work, or approval bypass. Native
`task` remains denied.

## Tool safety

Unknown and custom/MCP tools are denied unless an exact reviewed capability is
explicitly opted in. No broad wildcard or MCP-prefix ask rule is used, and debug
cannot self-edit permissions or install servers. Shell and external paths remain
approval-gated; approved shell is not sandboxed and can write caches or contact
the network. No automatic sanitization guarantee exists for grep, MCP, or shell
output, so collection must be deliberately narrow.

## Report and acceptance checklist

The final artifact is the [tracker-neutral draft](../files/skills/debug-investigation/references/issue-report.md),
marked **Draft—not submitted**. It separates facts, inference, confidence,
contradictions, failed findings, unknowns, and proposed verification criteria.

Repository validation for this change is:

```sh
bun run build
bun run test
bun run smoke
```

Those checks verify packaging and the isolated install lifecycle; smoke does not
launch OpenCode, validate runtime agents/tools, activate DCP, or claim package
cache cleanup. Runtime acceptance should additionally cover the pinned
`opencode --agent debug` selector, fresh-session behavior, default-deny and exact
MCP opt-in cases, and reports for project/macOS, CI/no-access, inconclusive,
approved/rejected probe, malicious-log, and contradictory/failed-delegate
scenarios. Real providers, credentials, catalogs, full plugin stacks, and model
report quality are not established by repository tests alone.
