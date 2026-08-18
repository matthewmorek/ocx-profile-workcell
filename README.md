# OCX Workspace Profile

Public MIT registry for `ws` on Apple Silicon macOS 14+. It installs `kdco/workspace`, then Matthew Morek’s pinned tail overrides.

`CONTRIBUTING.md` is intentionally omitted: maintainer automation and release constraints live in `AGENTS.md`.

## Install and authenticate

Install OCX 2.0.14 and OpenCode 1.17.15 from their official release assets, checking the published SHA-256 before executing either binary. Authenticate OpenCode with OpenAI before starting the profile:

```sh
opencode auth login
# Select OpenAI, complete the browser OAuth flow, then confirm the account:
opencode auth list
```

Use a disposable XDG root for a live installation check; this makes no model or MCP calls:

```sh
SANDBOX="$(mktemp -d)"
export HOME="$SANDBOX/home" XDG_CONFIG_HOME="$SANDBOX/config" XDG_DATA_HOME="$SANDBOX/data" XDG_CACHE_HOME="$SANDBOX/cache" XDG_STATE_HOME="$SANDBOX/state"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
ocx init --global --quiet
ocx profile add ws --source matthewmorek/ws --from https://matthewmorek.github.io/ocx-workspace-profile --global
ocx verify --cwd "$XDG_CONFIG_HOME/opencode/profiles/ws"
ocx oc -p ws --help
rm -rf "$SANDBOX"
```

Linear is enabled and opens its OAuth flow on first use; only approve it where read/write Linear access is intended. Context7, Exa, and gh_grep are anonymous. OpenCode global configuration is additive, so machine-global plugins/MCPs can still appear.

## Pinned maintainer bootstrap

Use verified Bun 1.3.5 and checksum-pin every downloaded tool before extraction. The CI bootstrap records these release-asset digests: Bun `db17588a4aea8804856825d4bead3f05e1f37276ca606f37e369b4f72f35d3fb`, OCX `1bdcb928da5d938fad787fc046e47068a87c8a2987466bba014294264efdc4b8`, and OpenCode `9667289c143d1fbdd440055af4041bb432f44b07ddf0aef048a8c7f2f7c65e2d`. Do not replace a checksum without an independently reviewed upstream release-provenance check.

```sh
bun install --frozen-lockfile
bun test tests
VERSION="$(bun -e 'import {parse} from "jsonc-parser"; console.log(parse(await Bun.file("registry.jsonc").text()).version)')"
COMMIT="$(git rev-parse HEAD)"
bun run validate -- --version "$VERSION" --commit "$COMMIT" --work-dir "$TMPDIR/validate" --validation-mode pinned --expected-ocx-version 2.0.14 --expected-opencode-version 1.17.15
```

## Release and verification

After protected-PR validation, bump `registry.jsonc` and `package.json` together, merge `main`, and create only an annotated tag. Create and push it exactly as follows, then preflight the exact tagged bytes:

```sh
git tag -a vX.Y.Z -m vX.Y.Z
TAG="$(git describe --exact-match --tags)"
TAGGER_EPOCH="$(git for-each-ref --format='%(taggerdate:unix)' "refs/tags/$TAG")"
bun run package:release -- --version "$VERSION" --tag "$TAG" --commit "$COMMIT" --tagger-epoch "$TAGGER_EPOCH" --pages "$TMPDIR/validate/pages" --evidence "$TMPDIR/validate/install-evidence.json" --out-dir release-out
bun run verify:release -- bundle --archive "release-out/ocx-workspace-profile-$TAG.tar.gz" --provenance release-out/provenance.json --receipt release-out/receipt.jsonc --checksums release-out/SHA256SUMS --expected-tag "$TAG" --extract-to "$TMPDIR/preflight-pages"
shasum -a 256 release-out/ocx-workspace-profile-"$TAG".tar.gz release-out/provenance.json release-out/receipt.jsonc
```

Push only the verified annotated tag with `git push origin vX.Y.Z`. Confirm the release assets and Pages bytes explicitly:

```sh
git push origin vX.Y.Z
gh release download "$TAG" --repo matthewmorek/ocx-workspace-profile --pattern "ocx-workspace-profile-$TAG.tar.gz" --pattern provenance.json --pattern receipt.jsonc --pattern SHA256SUMS --dir "$TMPDIR/$TAG"
(cd "$TMPDIR/$TAG" && shasum -a 256 -c SHA256SUMS)
rm -rf "$TMPDIR/$TAG/pages"
bun run verify:release -- bundle --archive "$TMPDIR/$TAG/ocx-workspace-profile-$TAG.tar.gz" --provenance "$TMPDIR/$TAG/provenance.json" --receipt "$TMPDIR/$TAG/receipt.jsonc" --checksums "$TMPDIR/$TAG/SHA256SUMS" --expected-tag "$TAG" --extract-to "$TMPDIR/$TAG/pages"
bun run verify:release -- live --base-url https://matthewmorek.github.io/ocx-workspace-profile --provenance "$TMPDIR/$TAG/provenance.json" --release "$TMPDIR/$TAG/pages/release.json" --expected-tag "$TAG"
curl --fail --show-error https://matthewmorek.github.io/ocx-workspace-profile/release.json
curl --fail --show-error https://matthewmorek.github.io/ocx-workspace-profile/index.json
```

Roll back only a published, verified release:

```sh
gh workflow run rollback.yml --repo matthewmorek/ocx-workspace-profile -f tag=vX.Y.Z -f confirm=ROLLBACK
```

If first publication fails live verification, retain the draft and inspect Pages plus `release.json`; do not manually deploy or delete evidence. If a later deployment fails, the workflow restores the verified recovery bundle; if restoration also fails, stop, retain diagnostics/draft, inspect the release state, and rerun only after its guards are satisfied. Never retag, overwrite assets, or improvise a restoration.
