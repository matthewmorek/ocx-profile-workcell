# Debug mode

Workcell 0.3.1 makes `debug` the primary observation-first investigator. It
diagnoses project, macOS, and connected-service failures with direct bounded
tools plus narrowly assigned asynchronous research. It does not edit tracked
source, implement repairs, mutate remote services, publish, install, authenticate,
change the active project, or escalate privileges. The separate `debugger` child
remains the repair path and is not the investigation workflow.

The normal responsibility boundary remains: `plan` decides scope and acceptance,
`build` changes implementation, and `debug` investigates observed failures.
Debug also handles bounded log and process checks and, by default, may restart a
specifically identified user-owned local development process, desktop
application, or application-specific user-session service when existing
evidence, ownership, launch procedure, and limited impact are established. A
restart is a diagnostic intervention, not a persistent source or configuration
fix; Debug does not implement those fixes.

For networking failures, Debug may autonomously inspect relevant interfaces,
routes, neighbor entries, resolver/DNS and proxy state, and targeted project
endpoint configuration. It infers a small set of relevant LAN hosts and service
ports from the report, project configuration, and that local evidence; it does
not require a complete host list or enumerate every host. For each selected
target it can use existing non-privileged tools for bounded DNS resolution, TCP
reachability, TLS handshakes, and non-mutating HTTP checks. A diagnostic network
connection is an observation, not permission to log in, restart or reconfigure
a remote service, write data, change routes/DNS/proxies/firewalls, or perform
other remote mutations.

## Start a session

The pinned CLI accepts the agent selector:

```sh
opencode --agent debug
```

After configuration-time or profile installation changes, quit and restart
OpenCode. Existing sessions retain their previous instructions and are not hot
reloaded. For the installed profile, start a fresh session with
`ocx oc -p workcell`, then use the interactive agent selector. OCX argument
forwarding beyond the documented CLI selector is not asserted here.

Workcell notifications follow the same root-session boundary: only current
persisted `debug`, `plan`, and `build` roots can produce desktop, sound, cmux,
title, status, or animation output; child sessions and unknown or failed source
lookups are silent. This also covers permission/question and tool-question
events. The legacy `notifyChildSessions` option is deprecated and ignored. See
the [README notification notes](../README.md#notifications) for the ownership
contract and reload requirement. These documentation and repository checks do
not claim live UI verification.

## Investigation model

The primary first establishes scope and reads existing evidence. It then compares
known-good and failing cases, ranks falsifiable hypotheses, and selects the
smallest discriminating read or local scratch probe. For an in-scope operation,
Debug discloses the command or tool, target, bounds, exposure, and cleanup, then
invokes it without a duplicate conversational permission question. Native
permissions are the sole per-operation approval mechanism: normal mode prompts,
and Auto replies `once` to eligible native requests when the connected TUI is
running. Reproduction and a confirmed root cause are optional; a concise,
evidence-rich inconclusive report is a successful outcome.

Auto does not grant new capabilities or bypass safeguards. Explicit denies remain
blocked, and scope, privacy, effects, and high-impact confirmation requirements
still apply. A rejected or denied operation is not retried, rerouted, or delegated
around. `question` remains available for genuine unresolved decisions or essential
missing information; it is not automatically answered and may still pause an
investigation. Disconnected or headless use does not establish Auto approval
behavior, and custom/MCP handlers require exact reviewed opt-in without any
universal native-authorization guarantee.

Network probes use bounded defaults: at most three relevant hosts and two
evidence-supported ports per host per hypothesis, sequentially, with a
three-second connection timeout, ten-second per-probe timeout, no automatic
retries, and 60 seconds total per batch. Results are limited to 4 KiB/50 lines
per probe and 24 KiB per batch. Debug does not perform indiscriminate subnet or
port sweeps, credential guessing, exploit or load probes, disruptive traffic,
privileged capture, or persistent network changes. It records target-selection
evidence, hostname and resolved/tested address, route/interface when known,
protocol outcomes, failures, bounds, and relevant exposure; a TCP connection
alone does not establish application health. It avoids credentials, cookies,
URL secrets, private response bodies, unsafe action endpoints, and automatic
redirects.

For a local development restart, Debug captures bounded before evidence, verifies
the exact user owner, process/project identity, launch or restart procedure, and
limited impact, then records the command, target, expected interruption, timeout,
and before/after state. Unknown, production, system, privileged, shared, or
high-impact targets are not eligible for the default restart path. The same
bounded procedure applies to a disposable desktop-application or
application-specific user-session-service fixture; it never enables, disables,
or reconfigures a service. There are no broad kills or repeated restart loops;
Debug stops and reports unexpected effects or failed recovery.

For an external ordinary launcher or other required system/project read, the
primary performs the targeted read through the native external-directory
authorization path. Native hard denies are different from chat approval: Auto
cannot approve them, and Bash or a child cannot route around them. If a required
read is denied, record the exact available tool, target path, native error, rule,
and executing identity when available; otherwise mark missing details unknown.
Do not invent the denial cause or repeatedly default to asking the user to run
`cat` or paste the file. Continue with independent safe evidence and report the
unavailable observation. A fresh correct profile/session may be required after
an update, but it does not override a real native deny.

The original reported cause of the primary denial remains **UNCONFIRMED**. An
observed debugger/worker denial and the pinned runtime mechanism establish only
those observed layers; they do not prove the primary's denial cause. Preserve
that distinction in the draft and Build handoff.

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
When a persistent source or configuration repair is needed, the draft may include
a separate report-only **Build handoff** with evidence references, confidence and
unknowns, proposed bounded requirements, acceptance criteria and commands, known
plan references when supplied, and current operational/restart state. Accepted-
plan references are included only when supplied; bounded user requirements are
sufficient otherwise. The handoff is not approval, does not switch modes or
dispatch repair work, and tells the user to switch to Build and request
implementation.

Repository validation for this change is:

```sh
bun run build
bun run test
bun run smoke
```

Those checks verify packaging and the isolated install lifecycle; smoke does not
launch OpenCode, validate runtime agents/tools, activate DCP, or claim package
cache cleanup. They do not prove native permission or Auto runtime behavior.

Controlled runtime acceptance requires a fresh pinned OpenCode 1.18.25 session on
the supported Apple Silicon macOS baseline, with the TUI connected. Verify that
normal Debug operations use native prompts, Auto advances across several bounded
operations without duplicate permission questions, rejected operations are not
bypassed, and switching back to normal does not retain Workcell-managed approval
state. Also verify explicit denied capabilities, exact MCP opt-in/default-deny
behavior, genuine-question pauses, and bounded external-path or scratch probes.
For networking, use a disposable local controlled fixture to verify interface,
route/DNS inspection and bounded DNS/TCP/TLS/non-mutating HTTP observations,
including target and output limits and the distinction between a connection and
a remote mutation. Do not probe an actual LAN as part of repository validation.
Use an innocuous disposable local development process or desktop-application /
application-specific user-session-service fixture to verify a hypothesis-driven
restart only after capturing before evidence and checking user ownership, launch
procedure, bounded interruption, and limited impact; verify the after-state and
stop behavior without broad kills or loops. Also verify that unknown, production,
system, privileged, shared, session-wide, and high-impact restart targets are not
treated as default Debug operations, and that Debug does not enable, disable,
reconfigure, or make persistent source/config changes. Exercise an ordinary
launcher read and, if denied, verify exact denial reporting without claiming an
unobserved cause. Exercise a report-only Build handoff and verify its facts,
confidence, references, proposed bounded requirements, acceptance commands,
operational state, and constraints do not imply approval or automatically switch
to Build. Use disposable fixtures only; do not use credentials, destructive
actions, or private service data. Record platform/runtime checks that cannot be
performed. Real providers, credentials, catalogs, full plugin stacks, and model
report quality are not established by repository tests alone.
