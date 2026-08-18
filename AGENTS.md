# Maintainer instructions

This repository publishes a minimal OCX registry for the `ws` profile. The profile
is an independent derivative of [KDCO Workspace](https://github.com/kdcokenny/opencode-workspace).
Use the [canonical KDCO registry source](https://github.com/kdcokenny/ocx/tree/main/workers/kdco-registry)
and [OCX documentation](https://ocx.kdco.dev/) as upstream references.

## Architecture invariants

- The public profile name is `ws`.
- `ws` depends on `kdco/workspace`, then fileless `ws-overrides`, in that order.
- `ws` explicitly targets `profiles/ws/ocx.jsonc` as `ocx.jsonc` and `profiles/ws/AGENTS.md` as `AGENTS.md`.
- The profile payload contains those two files only. Do not add a profile `opencode.jsonc`.
- Override options belong under each recognized agent's `agent.options` object. Do not duplicate them as direct agent keys.
- Do not copy or fork KDCO source. Keep the derivative changes in `ws-overrides`.

## Development

Use Bun 1.3.5 from the package manager declaration:

```sh
bun install --frozen-lockfile
bun run build
bun run test
bun run smoke
```

`build` runs `scripts/build-registry.ts`. `test` runs `bun test tests/registry.test.ts`. `smoke` runs `scripts/smoke-install.ts`.

## Releases

1. Bump the version in both `registry.jsonc` and `package.json`.
2. Open a PR and wait for required `validate-pinned` to pass.
3. Merge the PR.
4. Create and push the annotated tag:

   ```sh
   git tag -a vX.Y.Z -m vX.Y.Z
   git push origin vX.Y.Z
   ```

Release automation builds and deploys GitHub Pages and creates the GitHub Release.
Corrections use a new patch release.

## Caveats

Do not commit secrets or credentials. Linear may request OAuth with read/write access;
OpenCode global configuration can still merge with the profile; upstream
`kdco/workspace` floats to its latest version.
