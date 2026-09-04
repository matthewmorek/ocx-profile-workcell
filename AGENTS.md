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
- Override options belong under each recognized agent's `agent.options` object. Do
  not duplicate them as direct agent keys.
- Keep public identity consistent: Workcell, `workcell`, `workcell-bundle`,
  `workcell-*`, `matthewmorek/workcell`, and the repository/package identity
  `matthewmorek/ocx-profile-workcell` / `ocx-profile-workcell`.

## Source, provenance, and dependency boundaries

- The source snapshot is the installed `.tmp/ws-gpt-snapshot/ws-gpt` harness. Copy
  and modify the required material locally rather than restoring a floating runtime
  dependency or silently forking unrelated upstream changes.
- Preserve KDCO OCX/Workspace copyright and MIT notices. Record immutable upstream
  revisions for every copied import in the third-party notices before importing it.
- DCP 3.1.15 is separately fetched AGPL-3.0-or-later software: reference it as an
  external dependency when required, but do not vendor its package or source.
- Workcell owns the profile TUI configuration and pins DCP 3.1.15 in both the
  server and TUI contexts.
- Runtime plugins are exact-pinned. Use the local notify plugin; do not add an
  external notifier.

## Development

Supported baseline for Workcell 0.2.8: Apple Silicon macOS, Bun 1.4.1,
registry-target OCX 2.0.14, validation CLI OCX 2.0.15, and OpenCode 1.18.25.

```sh
bun install --frozen-lockfile
bun run build
bun run test
bun run smoke
```

`build` runs `scripts/build-registry.ts`; `test` runs
`bun test tests/registry.test.ts`; `smoke` runs `scripts/smoke-install.ts`.

Smoke npm policy is isolated to the smoke sandbox. It uses
`min-release-age=7` and `engine-strict=false`, filters inherited npm settings,
and does not mutate repository or user `.npmrc` files. Smoke validates selected
DCP resolution metadata only; it does not claim `/dcp` activation or rendering.

The repository-only migration sequence is to install and validate Workcell
0.2.8 first. If DCP should be Workcell-only, optionally remove a duplicate
user-global DCP TUI declaration after validation. Do not perform these machine-
level steps as part of repository changes. Roll back by restoring that
declaration and launching the prior Workcell profile or the existing `ws`
profile.

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
