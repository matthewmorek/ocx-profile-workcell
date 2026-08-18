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

### Recover a failed first publication

Use this exceptional workflow only when the original immutable tag run produced and retained the release bundle but failed during its first publication. It is not a normal release mechanism or a rollback. The workflow accepts only a failed annotated tag run with no live release, or the sole exact matching draft; it verifies the retained bytes before deployment and publication.

First query the immutable source identity read-only. Pass each value to pin exact bytes by immutable artifact ID plus digest and bind provenance to the failed attempt. The workflow reads both the requested attempt endpoint and the latest run endpoint; the latest attempt must still be the requested attempt (`1` here), so any later rerun fails recovery:

```sh
gh api repos/matthewmorek/ocx-workspace-profile/actions/runs/32149931346 --jq '{id,run_attempt,status,conclusion,event,path,head_branch,head_sha}'
gh api repos/matthewmorek/ocx-workspace-profile/actions/runs/32149931346/attempts/1 --jq '{id,run_attempt,status,conclusion,event,path,head_branch,head_sha,run_started_at,updated_at}'
gh api 'repos/matthewmorek/ocx-workspace-profile/actions/runs/32149931346/artifacts?per_page=100' --jq '.artifacts[] | {id,name,digest,expired,created_at,workflow_run}'
gh api repos/matthewmorek/ocx-workspace-profile/git/ref/tags/v0.1.0 --jq '.object.sha'
gh workflow run recover-release.yml --repo matthewmorek/ocx-workspace-profile -f tag=v0.1.0 -f source_run_id=32149931346 -f source_run_attempt=1 -f artifact_id=9329308619 -f artifact_digest=sha256:3ec81d4f5ab21b2d8eb006da56b484ba8e01c789267b51a515e4518ce86143aa -f tag_object_sha=f8d4cdf03fb7757732371b24cbb273d0a998d84d -f confirm=PUBLISH_EXACT
```

Monitor the recovery run, then verify the published artifact and live Pages content:

```sh
gh run list --repo matthewmorek/ocx-workspace-profile --workflow recover-release.yml --limit 5
gh run watch RUN_ID --repo matthewmorek/ocx-workspace-profile --exit-status
gh release download v0.1.0 --repo matthewmorek/ocx-workspace-profile --pattern "ocx-workspace-profile-v0.1.0.tar.gz" --pattern provenance.json --pattern receipt.jsonc --pattern SHA256SUMS --dir "$TMPDIR/v0.1.0"
(cd "$TMPDIR/v0.1.0" && shasum -a 256 -c SHA256SUMS)
bun run verify:release -- bundle --archive "$TMPDIR/v0.1.0/ocx-workspace-profile-v0.1.0.tar.gz" --provenance "$TMPDIR/v0.1.0/provenance.json" --receipt "$TMPDIR/v0.1.0/receipt.jsonc" --checksums "$TMPDIR/v0.1.0/SHA256SUMS" --expected-tag v0.1.0 --extract-to "$TMPDIR/v0.1.0/pages"
bun run verify:release -- live --base-url https://matthewmorek.github.io/ocx-workspace-profile --provenance "$TMPDIR/v0.1.0/provenance.json" --release "$TMPDIR/v0.1.0/pages/release.json" --expected-tag v0.1.0
```

The workflow rejects a successful run, a requested-attempt mismatch, any later rerun, duplicate artifact name, mismatched/expired artifact digest, artifact metadata outside the attempt window, or any tag-object replacement after dispatch—even one that still peels to the same commit. It rechecks production state and tag identity before draft creation, Pages deployment, and publication; immediately before Pages mutation it rechecks the complete draft asset inventory and hashes. For draft visibility, only the pre-deploy Pages job is newly broadened from `contents: read` to `contents: write`, because GitHub lists drafts only to principals with push access. `prepare-exact-draft` and `publish-exact-release` retain their existing release-write authority; `pages: write` and `id-token: write` remain exclusive to the deploy job. Publication freshly re-lists the sole expected draft ID, validates its four immutable bundle assets, publishes, and verifies the exact published assets; GitHub's REST client has no safe conditional PATCH used here, leaving only the minimized admin/API race between that verification and PATCH. A rerun after deployment succeeded but publication failed verifies the exact live bytes, skips redeployment, and publishes only the sole exact draft. Never retag, rebuild, repack, overwrite assets, move a tag, or manually deploy Pages.

The retained v0.1.0 artifact records the commit and tagger epoch, not the original annotated tag-object SHA. Therefore it cannot retroactively prove the original tag object. Recovery pins the current annotated tag object at dispatch and detects tag changes from dispatch onward while retaining the bundle's commit/tagger-epoch checks; this historical limitation does not prevent publication of the immutable retained bytes.

Roll back only a published, verified release:

```sh
gh workflow run rollback.yml --repo matthewmorek/ocx-workspace-profile -f tag=vX.Y.Z -f confirm=ROLLBACK
```

If first publication fails live verification, retain the draft and inspect Pages plus `release.json`; do not manually deploy or delete evidence. If a later deployment fails, the workflow restores the verified recovery bundle; if restoration also fails, stop, retain diagnostics/draft, inspect the release state, and rerun only after its guards are satisfied. Never retag, overwrite assets, or improvise a restoration.
