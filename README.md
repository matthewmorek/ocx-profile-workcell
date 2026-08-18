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
3. From merged `main`, create the annotated tag `git tag -a vX.Y.Z -m vX.Y.Z`; never retag or manually deploy Pages.
4. Before pushing that tag, preflight the same bytes locally:

   ```sh
   VERSION="$(bun -e 'import {parse} from "jsonc-parser"; console.log(parse(await Bun.file("registry.jsonc").text()).version)')"
   COMMIT="$(git rev-parse HEAD)"
   TAG="$(git describe --exact-match --tags)"
   TAGGER_EPOCH="$(git for-each-ref --format='%(taggerdate:unix)' "refs/tags/$TAG")"
   bun run package:release -- --version "$VERSION" --tag "$TAG" --commit "$COMMIT" --tagger-epoch "$TAGGER_EPOCH" --pages "$TMPDIR/validate/pages" --evidence "$TMPDIR/validate/install-evidence.json" --out-dir release-out
   bun run verify:release -- bundle --archive "release-out/ocx-workspace-profile-$TAG.tar.gz" --provenance release-out/provenance.json --receipt release-out/receipt.jsonc --checksums release-out/SHA256SUMS --extract-to "$TMPDIR/preflight-pages"
   ```

5. Push only the verified annotated tag with `git push origin vX.Y.Z`, then confirm the published release has the tarball, `provenance.json`, sanitized `receipt.jsonc`, and `SHA256SUMS`; verify Pages `release.json`, index, both packuments, and all provenance files. Perform a clean disposable-XDG install without model/MCP calls.
6. To roll back, manually dispatch `rollback.yml` with an existing release tag and explicit confirmation. It deploys checksum-verified historic bytes and changes global `latest`; it does not recreate tags or freeze KDCO.

`CONTRIBUTING.md` is intentionally omitted until outside contributions are material.
