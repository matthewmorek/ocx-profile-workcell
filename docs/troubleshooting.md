# Troubleshooting

## Profile changes are not visible

Installation and updates do not change an already running session. Quit and
start a fresh `ocx oc -p workcell` session. When switching profiles, explicitly
restart the managed daemon; CLI reuse does not apply later OCX configuration.

## Delegation tools are missing

First check the resolved Workcell `plan` identity. A stale or different plan
can look like a tool failure.

- If `delegate`, `delegation_read`, and `delegation_list` are all missing, the
  plugin likely failed during bootstrap or import.
- If `delegate` exists but rejects a request, the registered delegate rejected
  an unsupported child-agent route.

## Managed server failures

Lifecycle operations require an authenticated same-host PID check and a managed
server started with Workcell's configuration. Private, standalone,
unsupported-host, and mismatched-server cases must fail clearly; do not bypass
the check with a custom launcher or global configuration change.

## DCP and notifications

DCP 3.2.0 is external and separately fetched. Repository smoke does not launch
OpenCode or verify DCP activation, but focused runtime verification confirmed
compression and `/dcp-compress` with an explicit fixture `compress` allowance.
The shipped profile retains its original wildcard-deny policy with no
`compress` grant; the fixture allowance is not a general unrestricted-
compression claim.
For cmux requirements and preserved legacy settings, see
[Notifications](notifications.md).

The `/dcp` panel opens and closes with Escape. Keyboard navigation remains
incomplete, and at a 60x16 viewport the panel shows only its chrome. These are
known display and interaction limitations, not a claim that the panel is fully
verified.
