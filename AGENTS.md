# Maintainer automation runbook

This repository authors an OCX registry. `registry.jsonc`, `files/profiles/ws/ocx.jsonc`, and `files/profiles/ws/AGENTS.md` are authored inputs. `pages/`, `release-out/`, extracted registries, receipts, evidence, and diagnostics are generated and must never be committed. The payload contains only the two files in `files/profiles/ws`; repository-root `AGENTS.md` is not installed.

## Invariants

- Exactly two components exist: `ws` and fileless `ws-overrides`. `ws` must depend, in this order, on `kdco/workspace`, then `ws-overrides`. The tail supplies derivative metadata after KDCO; do not add a profile `opencode.jsonc`.
- Keep the pinned model, agents, root permissions, four enabled remote MCPs, and only the two tail plugin pins exact. KDCO owns DCP/formatter. Do not add PostHog, Tuple, instructions, locks, state, secrets, absolute paths, or `@latest`.
- OCX 2.0.14 strips direct `agent.reasoningEffort` and `agent.textVerbosity`. Their exact canonical values intentionally live under each recognized `agent.options` object; OpenCode 1.17.15 merges these options into runtime agent requests. Do not move or duplicate them as direct agent keys.
- Never edit a published release asset, retag, manually deploy Pages, or rebuild downstream artifacts. Pages receives an archive verified from the immutable workflow bundle.

## Local preparation

Use the verified Bun 1.3.5 binary, not a system Bun. Keep OCX/OpenCode and all XDG roots disposable; never test against the real profile.

Bootstrap downloaded Bun/OCX/OpenCode only after checking the checksum-pinned release assets recorded in `.github/actions/bootstrap-pinned/action.yml`. OpenAI authentication is `opencode auth login` (select OpenAI, complete browser OAuth, then `opencode auth list`); never place credentials in repository files or evidence.

```sh
bun install --frozen-lockfile
bun test tests
VERSION="$(bun -e 'import {parse} from "jsonc-parser"; console.log(parse(await Bun.file("registry.jsonc").text()).version)')"
COMMIT="$(git rev-parse HEAD)"
bun run build -- --version "$VERSION" --out "$TMPDIR/pages"
 bun run validate -- --version "$VERSION" --commit "$COMMIT" --work-dir "$TMPDIR/validate" --validation-mode pinned --expected-ocx-version 2.0.14 --expected-opencode-version 1.17.15
```

After an annotated tag exists, package and preflight only the validation output; never rebuild in a publish job:

```sh
TAG="$(git describe --exact-match --tags)"
TAGGER_EPOCH="$(git for-each-ref --format='%(taggerdate:unix)' "refs/tags/$TAG")"
bun run package:release -- --version "$VERSION" --tag "$TAG" --commit "$COMMIT" --tagger-epoch "$TAGGER_EPOCH" --pages "$TMPDIR/validate/pages" --evidence "$TMPDIR/validate/install-evidence.json" --out-dir release-out
 bun run verify:release -- bundle --archive "release-out/ocx-workspace-profile-$TAG.tar.gz" --provenance release-out/provenance.json --receipt release-out/receipt.jsonc --checksums release-out/SHA256SUMS --expected-tag "$TAG" --extract-to "$TMPDIR/preflight-pages"
```

## Release state machine

After a protected PR passes required `validate-pinned`, bump source `registry.jsonc#/version` and `package.json` together. Re-run validation, merge, then create only an annotated tag: `git tag -a vX.Y.Z -m vX.Y.Z` and push it. Release accepts annotated tags on `main` only. It validates source before production inspection, creates/reuses only matching draft assets, verifies the exact archive before deployment, live-verifies Pages, then publishes the draft.

The shared `pages-production` lock never cancels in-progress deployments. Initial publication is only `v0.1.0` with no prior live release. Higher versions capture a verified recovery bundle before mutation. Equal exact content resumes a draft or is a verified published no-op; equal mismatch, lower tag, malformed state, missing recovery, or divergent assets fail closed. If deploy was attempted, live verification failed, and recovery exists, restore and verify old bytes. A failed first publication leaves the draft and requires explicit cleanup/recovery; never improvise restoration.

## Failed first-publication recovery

Use `recover-release.yml` only when the original immutable tag run failed during its first publication. The agent maintainer must confirm all guards before dispatching it:

- The tag is an existing annotated tag on `main`, and its version matches `registry.jsonc` in that tag.
- The original release run is `completed` with conclusion exactly `failure`, its attempt, workflow, repository, tag/ref, and commit match the annotated tag, and it retained exactly one non-expired `target-release-bundle` artifact with the supplied API digest.
- The supplied annotated tag-object SHA still resolves remotely, points at the verified provenance commit, and has the provenance tagger epoch. This catches tag replacement even when the peeled commit is unchanged.
- The live site has no release for the tag, or has no live release at all. The only other accepted state is the tag's sole exact matching draft release.
- The retained bundle verifies before any production inspection or publication.

Query the immutable recovery identity read-only, then dispatch with every value and the exact confirmation string. The artifact ID/digest select source bytes rather than a mutable artifact name; the run attempt and annotated tag object bind the source run and tag identity:

```sh
gh api repos/matthewmorek/ocx-workspace-profile/actions/runs/32149931346 --jq '{id,run_attempt,status,conclusion,event,path,head_branch,head_sha}'
gh api 'repos/matthewmorek/ocx-workspace-profile/actions/runs/32149931346/artifacts?per_page=100' --jq '.artifacts[] | {id,name,digest,expired}'
gh api repos/matthewmorek/ocx-workspace-profile/git/ref/tags/v0.1.0 --jq '.object.sha'
gh workflow run recover-release.yml --repo matthewmorek/ocx-workspace-profile -f tag=v0.1.0 -f source_run_id=32149931346 -f source_run_attempt=1 -f artifact_id=9329308619 -f artifact_digest=sha256:3ec81d4f5ab21b2d8eb006da56b484ba8e01c789267b51a515e4518ce86143aa -f tag_object_sha=f8d4cdf03fb7757732371b24cbb273d0a998d84d -f confirm=PUBLISH_EXACT
```

This is not the normal release path and is not rollback. It publishes only the bytes retained by the original tag run. Never retag, rebuild, repack, overwrite assets, move a tag, or manually deploy Pages. Recovery re-verifies the bundle and tag before every mutation, creates or reuses only the exact draft, deploys and live-verifies those bytes, then publishes the draft. If Pages was already restored but publication failed, the sole exact draft plus exact live bytes skips deployment and safely resumes publication. If first-publication live verification fails, the workflow fails closed, retains the draft and diagnostics, and does not restore anything because no prior live release exists.

## Rollback and recovery

Run the manual rollback workflow with an existing release tag and explicit confirmation. It downloads that release, verifies checksums/provenance/receipt/archive before extraction, and redeploys exact bytes. It changes global `latest`; it neither moves tags nor pins future `kdco/workspace` resolution. If a release job fails, retain diagnostics and draft, inspect `release.json`, then rerun only after the state machine’s guards are satisfied.

```sh
gh workflow run rollback.yml --repo matthewmorek/ocx-workspace-profile -f tag=vX.Y.Z -f confirm=ROLLBACK
```

For first-publication live-verification failure, retain the draft and inspect Pages plus `release.json`; do not manually deploy. For later failure, the workflow restores only a verified recovery bundle; stop if restoration does not verify.

## Supply chain and secrets

Only update action SHAs or binary checksums in a reviewed PR after independently verifying upstream release provenance and compatibility. `GITHUB_TOKEN` belongs only in workflow environment; never print it, put it in evidence, or pass it to untrusted PR jobs. Linear is intentionally enabled and may require OAuth with read/write scope; OpenCode global configuration merges natively, so this package cannot promise behavioral isolation.
