# Workcell

Workcell is a self-contained OCX profile sourced from `matthewmorek/workcell`.
Its registry is published at
`https://matthewmorek.github.io/ocx-profile-workcell`. The repository identity is
`matthewmorek/ocx-profile-workcell`; its private package name is
`ocx-profile-workcell`.

## Install and update

For a fresh global installation, initialize OCX if needed, add Workcell, then
launch it:

```sh
ocx init --global
ocx profile add workcell --source matthewmorek/workcell --from https://matthewmorek.github.io/ocx-profile-workcell --global
ocx oc -p workcell
```

To update an installed `workcell` profile, intentionally replace the current
installation. OCX 2.0.15 has no in-place named-profile update command, and
`profile add` has no `--force` or `--yes` option:

```sh
ocx profile remove workcell --global
ocx profile add workcell --source matthewmorek/workcell --from https://matthewmorek.github.io/ocx-profile-workcell --global
```

Removal is immediate and replacement is not atomic. `profile remove` fails if
`workcell` is the last global profile, so keep or add another profile first—for
example, the existing `ws` rollback profile where applicable. These commands
intentionally replace the current Workcell installation.

## Support baseline

Workcell 0.3.0 supports Apple Silicon macOS with Bun 1.4.1 and OpenCode
1.18.25. The registry targets OCX 2.0.14. Repository validation uses the OCX
2.0.15 CLI. Configured MCP servers are limited to Context7, Exa, and GitHub
Grep.

## DCP configuration and smoke verification

Workcell owns the profile-root `tui.jsonc`. It pins external AGPL-3.0-or-later
DCP 3.1.15 in both the server and TUI configuration.

Smoke verification uses an isolated sandbox and the local built registry. It
initializes OCX, installs and verifies Workcell, installs the profile-local
direct npm dependencies from the generated manifest under the sandbox npm
policy, verifies the exact profile, receipt, and direct-package state, removes
Workcell, verifies that its profile root is gone while the default profile
remains, and then cleans the sandbox. Smoke does not launch OpenCode, resolve,
import, activate, or render DCP, verify `/dcp`, validate runtime tools or
agents, or claim package-cache cleanup.

## Debug mode

Workcell uses an observation-first `debug` primary for bounded diagnosis; the
`debugger` child remains a distinct repair path. The primary reads existing
evidence, compares known-good behavior, ranks falsifiable hypotheses, and uses
native approvals for bounded shell, external-path, authenticated-service, and
local scratch probes rather than a duplicate conversational gate. Debug handles
bounded log/process checks and may restart an identified user-owned local
development process, desktop application, or application-specific user-session
service by default when ownership, launch procedure, before evidence, and impact
are established. It does not enable, disable, or reconfigure services, make
persistent source/configuration fixes, or mutate remote services. The primary
owns targeted launcher/system reads; a native external-directory hard deny is not
a chat approval and cannot be bypassed through Bash or children. Record exact
available tool, target, error, and rule evidence, marking unknown details unknown.
For networking failures, it also inspects relevant interfaces, routes, neighbors,
DNS/resolver and proxy state plus targeted project configuration, then infers
relevant LAN targets rather than enumerating a subnet. Bounded DNS, TCP, TLS,
and non-mutating HTTP checks use existing tools and native authorization without
a ritual approval question for each host or connection. Connections are not
remote mutations: no credential guessing, disruptive probes, remote writes,
configuration changes, or privilege escalation. Targets, ports, timeouts,
retries, concurrency, output, and exposure remain bounded; see
[docs/debug-mode.md](docs/debug-mode.md) for the limits and acceptance notes.
Persistent fixes use a separate report-only Build handoff with proposed bounded
requirements and operational state; the user switches to Build and requests
implementation. See
[docs/debug-mode.md](docs/debug-mode.md) and the packaged
[`debug-investigation`](files/skills/debug-investigation/SKILL.md) skill.

### Notifications

In Workcell 0.3.1, notifications are restricted to the current persisted root
session for the `debug`, `plan`, or `build` primary. Child sessions are always
silent. The restriction covers desktop notifications and sounds, cmux
notifications and status, and terminal title/status animations, including
permission and question events and tool questions. Session lookup is
fail-closed: unknown or unavailable session ownership suppresses the event, and
authorization is not retained in a stale positive cache. The plugin serializes
source processing and cleans up stale animation state it owns.

The optional `notifyChildSessions` setting in
`~/.config/opencode/kdco-notify.json` is deprecated and ignored; it cannot
enable child notifications. Ownership is checked from the current persisted
session returned by the pinned OpenCode 1.18.25 server; its installed legacy
SDK typing omits the wire-level `agent` field, so the plugin validates that
field from the response rather than trusting the legacy type. Because
historical event payloads do not always include an agent, this is a current-
session ownership contract rather than an absolute historical attribution
guarantee. After installing or changing the profile, quit and start a fresh
`ocx oc -p workcell` session; the plugin is not hot reloaded. Repository tests
cover the restriction, but no live notification UI verification is claimed
here.

The pinned selector is `opencode --agent debug`. After configuration-time changes
restart OpenCode; after installation launch a fresh `ocx oc -p workcell` session
and use the interactive selector. OCX argument forwarding beyond the documented
CLI selector is not asserted.

## Migration and rollback

For a repository-only migration, install and validate Workcell 0.3.0 additively
alongside the prior known-good profile first. If
DCP should be Workcell-only, optionally remove a duplicate user-global DCP TUI
declaration after validation. Do not make these machine-level changes as part
of repository changes.

If the global declaration was removed, restore it to roll back. Then launch or
reinstall the prior Workcell profile, or launch the existing `ws` profile.

## Releases and migration

1. Bump the version in both `registry.jsonc` and `package.json`.
2. Open a PR and wait for required `validate-pinned` to pass.
3. Merge the PR.
4. Switch to the merged, current `main` commit:

   ```sh
   git switch main
   git pull --ff-only origin main
   ```

5. As the only post-merge release action, create and push the annotated tag:

   ```sh
   git tag -a vX.Y.Z -m vX.Y.Z
   git push origin vX.Y.Z
   ```

## Workflow efficiency

Agents reference the shared saved plan rather than copying it into each handoff.
Plan saves do not trigger automatic review, and routine progress does not require
rewriting the plan. Independent verification and review apply to ready implementation
batches, not every intermediate child result. Reporting-only corrections reuse
existing evidence; missing or stale evidence still requires fresh verification.

## Shared and archived plans

`plan_read({ reason })` without a path reads the Workcell root-session shared plan.
An optional `path` reads one exact user-selected Markdown file from the default
Plannotator archive, intentionally across projects:

```text
plan_read({
  reason: "Review the user's approved archive plan",
  path: "~/.plannotator/plans/example-approved.md"
})
```

Archive reads return raw Markdown and do not replace the shared plan, save anything,
or authorize implementation. The `-approved.md` suffix is not authorization; user
scope and approval still govern the work. If sources are missing or conflict, report
that instead of guessing. Workers must use this exact-path reader, not ordinary
`Read` or a no-path fallback; ordinary `Read` outside the workspace remains denied.
Explore and researcher tool permissions are unchanged, so parents must provide
self-contained assignments.

The archive root is selected once at plugin startup: a nonblank
`PLANNOTATOR_DATA_DIR` (with `~` expansion and relative values resolved from the
process working directory), otherwise an existing `~/.plannotator`, otherwise an
absolute `XDG_DATA_HOME/plannotator`, otherwise `~/.plannotator`. Plans are read
under its `plans` directory. The selected path must be one exact regular `.md` file,
with no listing, globbing, interpolation, symlinks, or custom-save roots, and no
larger than 1 MiB; oversized files are rejected rather than truncated. Obsidian and
other custom archives/tools are deferred—there is no arbitrary external filesystem
access.

Deliberate promotion with `plan_save` requires Workcell-format Markdown and
preservation of the approved scope. Material changes require renewed approval.
There is no storage migration; existing archive artifacts are untouched.

Background delegations use deterministic titles and descriptions by default.
To opt into model-generated metadata, set `KDCO_BACKGROUND_METADATA=1` before
launching OpenCode. Only the exact value `1` enables enrichment; the setting is
read when the delegation manager is created. Enrichment sends result excerpts to
the configured metadata model and incurs additional model requests and potential
cost. It runs after result persistence and parent notification, with deterministic
metadata retained if enrichment fails.

## Troubleshooting

Installing or updating Workcell does not change the profile of an already
running session. Launch a fresh session with `ocx oc -p workcell` to use the
installed profile; the profile is not hot reloaded. After deploying or installing a
candidate through the normal authorized workflow, quit the running session and start
a fresh one. To roll back, restart the prior profile; archive artifacts are untouched.

If `delegate` is missing, check the resolved Workcell `plan` identity first. A
wrong or stale Workcell plan can look like a tool failure. If
`delegate`, `delegation_read`, and `delegation_list` are all missing, suspect a
plugin bootstrap or import failure. If `delegate` exists but rejects a request,
the requested child route may not be supported by the registered delegate.

## Notes

Some Workcell material is copied and modified from [KDCO OCX](https://github.com/kdcokenny/ocx)
and its Workspace material under the MIT terms described in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which preserves the relevant
copyright and license notices. DCP 3.1.15 is separately fetched
AGPL-3.0-or-later software and is referenced, not vendored. Workcell is
independent, not affiliated with, endorsed by, or sponsored by KDCO. The
project itself is MIT-licensed; see [LICENSE](LICENSE).
