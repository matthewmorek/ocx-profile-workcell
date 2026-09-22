# Contributing

Workcell is a self-contained profile. Keep the public identity, four-file
profile layout, local bundle dependency, exact runtime pins, and preserved
license notices intact. Do not commit secrets, generated state, raw research
receipts, machine-specific paths, or vendored npm artifacts.

## Development

Supported development uses Apple Silicon macOS, Bun 1.4.1, registry-target OCX
2.0.14, validation CLI OCX 2.0.15, and OpenCode 2.0.12.

```sh
bun install --frozen-lockfile
bun run build
bun run test
bun run smoke
```

`build` generates the local registry. `test` runs the registry and review test
suites. `smoke` validates the isolated install lifecycle; it does not launch
OpenCode, validate runtime tools or agents, or activate or render DCP.

The smoke sandbox uses `min-release-age=7` and `engine-strict=false`, filters
inherited npm settings, and does not modify repository or user `.npmrc` files.

## Pull requests

Keep changes focused and document behavior and verification in the PR. Review
mode is described in [docs/review-mode.md](docs/review-mode.md); its native
permissions are not an OS sandbox, and review does not publish GitHub comments
or reviews.

## Releases

1. Bump the version in `registry.jsonc` and `package.json`.
2. Open a PR and wait for `validate-pinned` to pass.
3. Merge the PR.
4. Switch to the merged current `main` commit:

   ```sh
   git switch main
   git pull --ff-only origin main
   ```

5. As the only post-merge release action, create and push the annotated tag:

   ```sh
   git tag -a vX.Y.Z -m vX.Y.Z
   git push origin vX.Y.Z
   ```

The tag push validates ancestry, builds, tests, smoke-tests, deploys and
verifies GitHub Pages, then creates the GitHub Release. Corrections use a new
patch release.

## Migration and rollback

Validate the exact V2 runtime in an isolated candidate configuration and data
environment beside the known-good profile. Lifecycle operations are
managed-server-only and require authenticated same-host PID checks; private,
standalone, unsupported-host, and mismatched-server cases must fail clearly.
The managed server must start with Workcell's configuration.

Users must explicitly restart the daemon when switching profiles. Repository
work does not add a custom launcher, automatic daemon restart, global
configuration change, or machine-level installation or migration. Close prior
V1 review sessions with their original version before upgrading.

Rollback means restarting and launching the untouched V1 profile with its
matching runtime, such as the existing `ws` profile. Never pass V2
configuration or session state to V1.

## Licensing and provenance

Preserve the notices in [LICENSES/KDCO-OCX-MIT.txt](LICENSES/KDCO-OCX-MIT.txt)
and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Record an immutable
upstream revision before importing copied material. DCP is separately fetched
AGPL-3.0-or-later software and must not be vendored.
