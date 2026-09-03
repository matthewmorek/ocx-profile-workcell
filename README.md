# Workcell

Workcell is a self-contained OCX profile sourced from `matthewmorek/workcell`.
The repository identity is `matthewmorek/ocx-profile-workcell`, with the private
package name `ocx-profile-workcell` and Pages distribution URL
`https://matthewmorek.github.io/ocx-profile-workcell`.

## Quickstart

Initialize OCX, then install the profile persistently for the current user:

```sh
ocx init --global
ocx profile add workcell --source matthewmorek/workcell --from https://matthewmorek.github.io/ocx-profile-workcell --global
ocx oc -p workcell
```

For a non-persistent/direct install, omit `--global` from the profile command:

```sh
ocx profile add workcell --source matthewmorek/workcell --from https://matthewmorek.github.io/ocx-profile-workcell
```

## Architecture and contents

Workcell is a self-contained fork of the installed harness snapshot at
`.tmp/ws-gpt-snapshot/ws-gpt`, not a runtime dependency on an upstream workspace
bundle. The local aggregate is `workcell-bundle`; leaf components use the
`workcell-` prefix. The profile is laid out as:

```text
files/profiles/workcell/
├── ocx.jsonc
├── opencode.jsonc
└── AGENTS.md
```

The bundle packages the intended agents, skills, command, local plugins, and support
modules. Generic internal workspace/worktree names remain unchanged. Runtime plugins
are exact-pinned: `opencode-vibeguard@0.1.0`, `@plannotator/opencode@0.27.11`,
`@tarquinen/opencode-dcp@3.1.15`, and `@franlol/opencode-md-table-formatter@0.0.6`.
Notifications use the local notify plugin; no external notifier is included.

## Supported baseline and integrations

The supported baseline is Apple Silicon macOS with Bun 1.3.5, OCX 2.0.14, and
OpenCode 1.18.27. The configured MCP servers are limited to Context7, Exa, and
GitHub Grep.

## Migration, rollback, and updates

Install `workcell` side-by-side with existing `ws` users' setup, validate it, and
switch launch commands to `ocx oc -p workcell`. Rollback is launching or restoring
`ws`; remove it only after the Workcell migration is confirmed.

OCX 2.0.14 has no profile update command. To update Workcell, remove or move the
existing `workcell` profile and rerun the install command above. Releases bump the
registry and package versions, pass the required checks, then publish an annotated
tag; automation builds and deploys Pages and creates the GitHub Release. See
[AGENTS.md](AGENTS.md) for maintainer details.

## Provenance and affiliation

Some Workcell material is copied and modified from [KDCO OCX](https://github.com/kdcokenny/ocx)
and its Workspace material under the MIT terms described in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). DCP 3.1.15 is separately fetched
AGPL-3.0-or-later software and is referenced, not vendored. Workcell is independent,
not affiliated with, endorsed by, or sponsored by KDCO. The accepted Workcell name
collision with unrelated projects does not imply affiliation.

The project itself is MIT-licensed; see [LICENSE](LICENSE).
