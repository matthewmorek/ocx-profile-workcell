# OCX Workspace Profile

Public MIT registry for `ws` on Apple Silicon macOS 14+. It installs Workspace from `kdco/workspace`, then applies Matthew Morek’s tail overrides.

## Install and use

Prerequisites: macOS 14+ on ARM64, OCX 2.0.14, OpenCode 1.17.15, and an OpenAI account entitled to the configured models. Install into a disposable or intended global OpenCode config:

```sh
ocx profile add ws --source matthewmorek/ws --from https://matthewmorek.github.io/ocx-workspace-profile --global
ocx verify --cwd ~/.config/opencode/profiles/ws
ocx oc -p ws
```

The four remote MCPs are Linear, Context7, Exa, and gh_grep. Linear is enabled by default: complete its OAuth flow only on a machine where read/write access is intended. Context7, Exa, and gh_grep are anonymous. Native OpenCode global configuration is additive, so globally configured plugins/MCPs may still appear. Installed profiles are immutable managed artifacts: replace them with OCX rather than hand-editing them.

### Maintainer compatibility note

OCX 2.0.14 cannot serialize direct `agent.reasoningEffort` or `agent.textVerbosity`. Their canonical values are transported under each agent’s supported `options` object, which OpenCode 1.17.15 merges into the resolved runtime agent. Do not restore or duplicate direct copies.

## Maintainer release checklist

1. Update bare SemVer in `registry.jsonc` and `package.json`; no `v` in either. Run `bun install --frozen-lockfile`, `bun test tests`, and `bun run validate -- --version X.Y.Z --commit "$(git rev-parse HEAD)" --work-dir "$TMPDIR/validate"` with verified pinned binaries.
2. Open and merge a protected PR only after required `validate-pinned` passes; advisory `validate-latest` does not gate release.
3. From merged `main`, create and push `git tag -a vX.Y.Z -m vX.Y.Z`; never retag or manually deploy Pages.
4. Confirm the published release has the tarball, `provenance.json`, sanitized `receipt.jsonc`, and `SHA256SUMS`; verify Pages `release.json`, index, both packuments, and all provenance files. Perform a clean disposable-XDG install without model/MCP calls.
5. To roll back, manually dispatch `rollback.yml` with an existing release tag and explicit confirmation. It deploys checksum-verified historic bytes and changes global `latest`; it does not recreate tags or freeze KDCO.

`CONTRIBUTING.md` is intentionally omitted until outside contributions are material.
