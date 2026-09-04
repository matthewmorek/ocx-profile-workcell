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

Workcell 0.2.8 supports Apple Silicon macOS with Bun 1.4.1 and OpenCode
1.18.25. The registry targets OCX 2.0.14. Repository validation uses the OCX
2.0.15 CLI. Configured MCP servers are limited to Context7, Exa, and GitHub
Grep.

## DCP configuration and smoke verification

Workcell owns the profile-root `tui.jsonc`. It pins external AGPL-3.0-or-later
DCP 3.1.15 in both the server and TUI configuration.

Smoke verification uses production plugin metadata to prove that the exact DCP
spec was requested and version 3.1.15 resolved from npm at the exact scoped
package target. It does not prove plugin import, activation, `/dcp`
registration, rendering, or interaction.

## Migration and rollback

For a repository-only migration, install and validate Workcell 0.2.8 first. If
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

## Troubleshooting

Installing or updating Workcell does not change the profile of an already
running session. Launch a fresh session with `ocx oc -p workcell` to use the
installed profile.

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
