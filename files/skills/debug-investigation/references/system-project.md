# System and project evidence

Use this reference for historical, bounded macOS and project observations. The
current installed help and platform behavior win over remembered command syntax.
Record command, time window, timezone, bounds, and result for every collection.

## macOS and local runtime

- Start with existing crash reports, application logs, service output, and
  runtime artifacts already named by the report.
- With approval, use a narrow unified-log predicate and explicit time window;
  bound rows and output. Inspect relevant process, service, resource, DNS, and
  network state only when it discriminates a stated hypothesis.
- Use current command help before platform-sensitive tools. A historical command
  or flag is not evidence that the installed command supports it.
- Do not perform blanket home-directory or secret scans. Do not dump the full
  environment, keychain, tokens, or unrelated user data. Do not restart, repair,
  kill, attach to, or reconfigure a service as part of diagnosis.

## Project evidence

- Read the relevant files, configuration, lockfiles, generated outputs, logs,
  and recent history already in scope before requesting a new probe.
- Compare a working example with the failing path and record every meaningful
  difference: inputs, versions, configuration, dependencies, timing, process,
  account, and environment.
- Streams, test runners, scripts, and profiling commands are approved local
  probes only when the exact command, paths, duration, output, credentials,
  network exposure, and cleanup are approved. A probe may use an ignored scratch
  directory, never tracked source or an active project switch.
- Reproduction is optional. If it is unsafe, expensive, unavailable, or
  rejected, report that fact and continue with existing evidence.

Other operating systems are best effort; this reference does not create a new
support baseline.
