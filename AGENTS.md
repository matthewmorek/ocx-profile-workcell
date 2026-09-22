# Maintainer instructions

This repository publishes Workcell, a self-contained OCX profile derived from the
installed harness snapshot at `.tmp/ws-gpt-snapshot/ws-gpt`. The public profile and
local profile name is `workcell`; its OCX source is `matthewmorek/workcell`.

## Architecture and identity invariants

- The aggregate component is `workcell-bundle`; leaf components use the `workcell-` prefix.
- The profile layout is exactly
  `files/profiles/workcell/{ocx.jsonc,opencode.jsonc,tui.jsonc,AGENTS.md}`.
- The profile depends only on the local `workcell-bundle`; it is not a thin derivative
  and must not depend on an upstream workspace bundle at runtime.
- All intended agents, skills, commands, local plugins, and support modules are
  packaged locally. Generic internal workspace/worktree names remain unchanged.
- Override options belong under each recognized agent's
  `agents.<name>.request.body` object. Do not duplicate them as direct agent keys
  or rely on legacy same-name entries; native V2 configuration takes precedence.
- Keep public identity consistent: Workcell, `workcell`, `workcell-bundle`,
  `workcell-*`, `matthewmorek/workcell`, and the repository/package identity
  `matthewmorek/ocx-profile-workcell` / `ocx-profile-workcell`.

## Source, provenance, and dependency boundaries

- The source snapshot is the installed `.tmp/ws-gpt-snapshot/ws-gpt` harness. Copy
  and modify the required material locally rather than restoring a floating runtime
  dependency or silently forking unrelated upstream changes.
- Preserve KDCO OCX/Workspace copyright and MIT notices. Record immutable upstream
  revisions for every copied import in the third-party notices before importing it.
- DCP 3.2.0 is separately fetched AGPL-3.0-or-later software: reference it as an
  external dependency when required, but do not vendor its package or source.
- Workcell owns the four-file profile layout. The inactive `tui.jsonc` contains no
  duplicate DCP declaration; the server plugin declaration supplies the CLI panel.
- Runtime plugins are exact-pinned. Use the local notify plugin; do not add an
  external notifier.
- OpenCode V2 owns terminal titles and desktop alerts. Do not preserve or add a
  custom title writer, spinner, desktop notifier, global `cli.json`, or host
  patch. The local `workcell-notify` component remains responsible for cmux
  status through `files/plugins/notify/server.ts` and `tui.ts`; the native loader
  advertises one notify server/TUI instance. cmux requires its executable on
  `CLIENT`'s `PATH`, `CMUX_WORKSPACE_ID`, and `CMUX_SURFACE_ID`; child-only
  activity is not promoted. The legacy `kdco-notify.json` is not read and must
  be preserved, not deleted. Component count remains 27.

## Development

Supported baseline for Workcell 0.5.0: Apple Silicon macOS, Bun 1.4.1,
registry-target OCX 2.0.14, validation CLI OCX 2.0.15, and OpenCode 2.0.12.

```sh
bun install --frozen-lockfile
bun run build
bun run test
bun run smoke
```

`build` runs `scripts/build-registry.ts`; `test` runs
`bun test tests/registry.test.ts tests/review*.test.ts`; `smoke` runs
`scripts/smoke-install.ts`.

Smoke npm policy is isolated to the smoke sandbox. It uses
`min-release-age=7` and `engine-strict=false`, filters inherited npm settings,
and does not mutate repository or user `.npmrc` files. Smoke uses the local
built registry, initializes OCX, installs and verifies Workcell, installs the
profile-local direct npm dependencies from the generated manifest under the
sandbox npm policy, verifies the exact profile, receipt, and direct-package
state, removes Workcell, verifies that its profile root is gone while the
default profile remains, and then cleans the sandbox. It does not launch
OpenCode, resolve, import, activate, or render DCP, verify `/dcp`, validate
runtime tools or agents, or claim package-cache cleanup.

Review mode is agent-guided and uses OpenCode-native tools and permissions, not
a custom review engine. The review primary writes its ledger with native file
tools; `worktree/review.ts` owns detached pinning, retained refs, ownership and
cleanup. Ordinary reviewer delegations remain read-only and use returned paths.
Native permissions are not an OS sandbox. Preserve source files, the index and
branches; normal review Git metadata, objects and refs may be written. Close
legacy engine reviews with the previous version before upgrading; do not migrate
or delete them automatically.

The repository-only migration sequence is to provision and validate the exact
V2 runtime in an isolated candidate configuration/data environment alongside the
prior known-good profile. Lifecycle operations are managed-server-only: accept a
discovered server only after authenticated same-host PID checks, and fail clearly
for private, standalone, unsupported-host, or mismatched-server cases. The
managed server must start with the Workcell configuration. Users must explicitly
restart the daemon when switching profiles; CLI reuse does not apply subsequent
OCX configuration to an already-running daemon. There is no custom launcher,
automatic daemon restart, global configuration change, or machine-level
installation/migration in repository work. Close prior V1 review sessions with
their original version before upgrading. Roll back by restarting and launching
the untouched V1 profile with its matching runtime; never feed V2 config or
session state to V1.

If `delegate` is missing, a running session may still use its previous profile;
launch a fresh `ocx oc -p workcell` session. Then distinguish these cases:

1. A wrong or stale Workcell plan identity means the session loaded a different
   profile or plan configuration.
2. If `delegate`, `delegation_read`, and `delegation_list` are all missing, the
   plugin likely failed during bootstrap or import.
3. If `delegate` is present but rejects the request, the registered delegate
   rejected an unsupported child-agent route.

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

The tag push automatically validates the tag and main ancestry, builds, tests,
smoke-tests, deploys and verifies GitHub Pages, then creates the GitHub Release.
An exact duplicate tag-and-commit event skips Pages redeployment but still compares
live output and ensures the GitHub Release exists. Corrections use a new patch
release. Existing users migrate side-by-side: install and validate `workcell` before
removing their old `ws` profile. Rollback is launching or restoring `ws`.

## Repository safety

Do not commit secrets or credentials, raw research receipts, machine-specific paths,
generated state, or vendored npm artifacts. Keep generated registry output out of
hand-edited documentation and review changes for accidental identity, provenance,
or pin drift. OpenCode global configuration may still merge with the profile.
