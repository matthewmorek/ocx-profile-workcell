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

The supported baseline is Apple Silicon macOS with Bun 1.3.5 and OpenCode
1.18.27. The registry targets OCX 2.0.14; repository validation uses the OCX
2.0.15 CLI. Configured MCP servers are limited to Context7, Exa, and GitHub
Grep.

## Maintainer releases

Use a reusable version value; do not commit generated `dist` output.

```sh
export VERSION=X.Y.Z
perl -0pi -e 's/("version"\s*:\s*")[^"]+/$1$ENV{VERSION}/' package.json registry.jsonc
git diff -- package.json registry.jsonc
git switch -c release/v$VERSION

bun install --frozen-lockfile
bunx oxfmt --check package.json registry.jsonc
bun run typecheck
bun run build
REGISTRY_DIST=dist bun run test
REGISTRY_DIST=dist bun run smoke

git add package.json registry.jsonc
git commit -m "chore: release v$VERSION"
git push --set-upstream origin release/v$VERSION
gh pr create --base main --head release/v$VERSION --title "Release v$VERSION" --body "Release v$VERSION"
```

Update both `registry.jsonc` and `package.json`, open the PR, wait for the
required `validate-pinned` check, and merge it. Then update local `main`, verify
the release version and manifest values, and perform the only post-merge
release action: create and push the annotated tag.

```sh
set -eu
export VERSION=X.Y.Z
git switch main
git pull --ff-only origin main
test "$(git branch --show-current)" = main
test "$(git rev-parse main)" = "$(git rev-parse origin/main)"
perl -e 'my $v = $ENV{VERSION}; exit 1 unless $v =~ /\A(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\z/'
for file in package.json registry.jsonc; do
  test "$(perl -0ne 'print $1 if /"version"\s*:\s*"([^"]+)"/' "$file")" = "$VERSION"
done
git tag -a "v$VERSION" -m "v$VERSION"
git push origin "v$VERSION"
```

The pushed `v*` tag triggers validation of the annotated tag, main ancestry, and
version equality, followed by build, tests, smoke tests, Pages deployment when
needed, live-output verification, and GitHub Release creation. An exact
duplicate tag-and-commit retry skips Pages redeployment but still compares live
output and ensures the GitHub Release exists. Corrections use a new patch
release.

## Migration, rollback, provenance, and license

Install and validate `workcell` side-by-side with an existing `ws` setup before
switching launch commands. Rollback is launching or restoring `ws`; remove it
only after the Workcell migration is confirmed.

Some Workcell material is copied and modified from [KDCO OCX](https://github.com/kdcokenny/ocx)
and its Workspace material under the MIT terms described in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which preserves the relevant
copyright and license notices. DCP 3.1.15 is separately fetched
AGPL-3.0-or-later software and is referenced, not vendored. Workcell is
independent, not affiliated with, endorsed by, or sponsored by KDCO. The
project itself is MIT-licensed; see [LICENSE](LICENSE).
