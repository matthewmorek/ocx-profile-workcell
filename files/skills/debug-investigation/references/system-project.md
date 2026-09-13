# System and project evidence

Use this reference for bounded local system, network, and project observations. The
current installed help and platform behavior win over remembered command syntax.
Record command, time window, timezone, bounds, and result for every collection.
Apply the skill's nonblocking disclosure and native tool authorization policy;
do not add a separate conversational permission gate.

## macOS and local runtime

- Start with existing crash reports, application logs, service output, and
  runtime artifacts already named by the report.
- The primary owns targeted launcher, log, and configuration reads through native
  read tools and normal external-path authorization. For example, inspect the
  specifically named `/usr/share/applications/vicinae.desktop` launcher and relevant
  application-specific user-service definition before considering a Vicinae restart;
  do not infer permission to edit either or delegate external reads to restricted
  children. On denial follow the skill's blocked-observation policy, not a shell or
  child workaround.
- Use native authorization for a narrow unified-log predicate and explicit time
  window; bound rows and output. Inspect relevant process, service, resource,
  DNS, and network state only when it discriminates a stated hypothesis.
- Use current command help before platform-sensitive tools. A historical command
  or flag is not evidence that the installed command supports it.
- Do not perform blanket home-directory or secret scans. Do not dump the full
  environment, keychain, tokens, or unrelated user data. Do not repair, attach to,
  or reconfigure a service. Stopping/restarting is limited to the local process/app
  exception below; system-service restarts remain outside default Debug scope.

## Project evidence

- Read the relevant files, configuration, lockfiles, generated outputs, logs,
  and recent history already in scope before invoking a new probe.
- Compare a working example with the failing path and record every meaningful
  difference: inputs, versions, configuration, dependencies, timing, process,
  account, and environment.
- Streams, test runners, scripts, and profiling commands are local probes, not
  presumed reads. Disclose the exact command, paths, duration, output,
  credentials, network exposure, and cleanup, then invoke through native
  authorization without waiting for a conversational reply. A bounded in-scope
  probe may use an ignored scratch directory, never tracked source or an active
  project switch. Cleanup covers only exact created items disclosed beforehand.
- Reproduction is optional. If it is unsafe, expensive, unavailable, or
  rejected, report that fact and continue with existing evidence.

## Local network diagnostic procedure

1. Inspect relevant interface/address state, routes, existing neighbor entries,
   resolver/search-domain configuration, and proxy presence/host/port without secrets.
   Use available non-privileged tools with installed help (for example `ip`,
   `ifconfig`, `route`, `arp`, `scutil`, or resolver utilities); do not install missing
   tools or use privileged capture/configuration commands. Read only targeted project
   endpoint settings; do not dump environments, proxy credentials, or unrelated data.
2. Select a small evidence-backed set of hosts and ports from the request, project
   endpoints, and local network findings. Record why each is relevant. Existing
   neighbor/route discovery is useful without asking for a complete host list; it is
   not permission for subnet enumeration, broadcast discovery, or broad port scans.
   Resolve names and check the actual destination route/interface, including IPv4,
   IPv6 scope and VPN/proxy involvement where relevant. Do not assume a private
   address is local or a configured endpoint is safe. If resolution or routing leads
   outside the scoped LAN, use safe local evidence or clarify the material ambiguity
   before that probe; existing separately scoped connected-service reads remain valid.
3. Disclose the selected tool/command, hosts, addresses, ports/protocols, endpoint,
   limits and exposure, then invoke under native authorization without per-host or
   per-connection conversational approvals. Default to at most 3 relevant hosts and
   2 evidence-supported ports per host per hypothesis, sequential probes, a 3-second
   connect timeout, 10-second total timeout per probe, no automatic retries, and
   60 seconds total for the batch. Bound each result to 4 KiB/50 lines and the batch
   to 24 KiB. Use stricter bounds for sensitive/fragile targets; any justified change
   must remain small, explicitly bounded and non-disruptive, not repeated batches
   that become a sweep. Use tool-supported limits or an available non-privileged
   wrapper; if bounds cannot be enforced, choose another safe observation.
4. Test the smallest discriminating layer: DNS resolution, a single TCP connection
   to the relevant port, TLS handshake with the intended hostname/SNI and certificate
   validation, then a known non-mutating HTTP endpoint if needed. Existing `dig`,
   `getent`, `nc`, `openssl`, or `curl` may fit; bounded ping/route diagnostics are
   optional only when the installed tool works without privilege and fits the same
   traffic budget. No credential guessing, exploitation, load tests or remote writes.
   Do not disable certificate checks to call TLS healthy. HTTP GET/HEAD is not
   automatically safe: avoid action URLs, logout/restart/admin triggers, and unknown
   endpoints with possible effects. Do not automatically follow redirects or forward
   credentials; assess each changed destination against the same target/route scope.
5. Record time, selection evidence, requested hostname, resolved and actually tested
   address, route/interface (or unknown), port/protocol, timeout/exit result, DNS/TCP/
   TLS/HTTP outcomes and failures. Record relevant DNS/proxy/remote-log exposure;
   normal probes reveal client address, hostname/SNI and request metadata and can
   create access logs. Minimize response collection before it enters the transcript;
   omit cookies, authorization, URL secrets, and private bodies. No automatic use of
   credentials or client certificates for LAN probes; any existing authenticated
   service read must satisfy the connected-tool policy. Stop on unexpected effects
   or denial; no tool substitution to bypass it. Distinguish a refused connection,
   timeout, resolution error, TLS failure and HTTP status from an inferred cause.

Diagnostic connections do not authorize remote restart, service mutation, persistent
DNS/proxy/route/firewall changes, or production/shared high-impact operations. Use
safe evidence or one essential scope question when uncertainty blocks safe probing;
native Auto approval is neither a scope expansion nor permission to repair.

## Local process and application restart procedure

Debug owns bounded log/process checks and eligible restarts; do not hand these
operations to Build. Restart only to test a stated hypothesis after less-invasive
observations, not as a routine first step or a claimed source fix.

1. Capture the failing behavior, relevant bounded logs, timestamps, and current
   process state before interruption; preserve evidence references for comparison.
2. Establish the exact user owner, PID/current process identity, executable/command,
   working directory, user session, application/project target, and relevant listener
   or application-specific user-session supervisor identity. A port
   number or process name alone is insufficient. Recheck identity immediately
   before stopping to avoid targeting a replaced process.
3. Verify the existing launch/restart procedure from project instructions, targeted
   launcher/service reads, and observed runtime state, including exact arguments,
   working directory, required environment, exact stop/start commands, and any
   supervisor behavior. Establish predictable limited impact: only the identified
   user-owned local development process or local desktop application/application-specific
   user-session service, no unsaved-work loss, shared users, production/system role,
   privilege requirement, destructive startup tasks, or other high-impact effects.
   Do not guess commands, dump environment secrets, edit configuration/source, or
   install/change dependencies to make the restart possible.
4. Disclose exact command and target, expected interruption, timeout, output and
   exposure bounds, and recovery/cleanup limits. Invoke through native bash
   authorization without an extra permission question. Honor rejection or denial;
   never route around it. Use a graceful stop/restart with a bounded wait; do not
   escalate a timeout to force-kill. No broad `pkill` or guessed kill targets.
5. Compare the same bounded failure/log/health observations afterward. Record
   commands, targets, interruption, timeout/exit result, before/after evidence,
   and final process/application/service state (including stopped or unknown). Stop on unexpected
   effects or failed recovery; report the state rather than running repeated
   restart loops. Recovery does not prove a persistent source defect is fixed.

Unknown ownership, identity, procedure, or impact means do not restart. Continue
safe inspection or report the gap. Never enable, disable, or reconfigure user
services. Session-wide services and production, system, privileged, shared, or
high-impact restarts require an appropriate operator and explicit authorization
outside default Debug scope; native Auto approval alone is insufficient.

Other operating systems are best effort; this reference does not create a new
support baseline.
