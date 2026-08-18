# Maintainer automation runbook

This repository authors an OCX registry. `registry.jsonc`, `files/profiles/ws/ocx.jsonc`, and `files/profiles/ws/AGENTS.md` are authored inputs. `pages/`, `release-out/`, extracted registries, receipts, evidence, and diagnostics are generated and must never be committed. The payload contains only the two files in `files/profiles/ws`; repository-root `AGENTS.md` is not installed.

## Invariants

- Exactly two components exist: `ws` and fileless `ws-overrides`. `ws` must depend, in this order, on `kdco/workspace`, then `ws-overrides`. The tail supplies derivative metadata after KDCO; do not add a profile `opencode.jsonc`.
- Keep the pinned model, agents, root permissions, four enabled remote MCPs, and only the two tail plugin pins exact. KDCO owns DCP/formatter. Do not add PostHog, Tuple, instructions, locks, state, secrets, absolute paths, or `@latest`.
- OCX 2.0.14 strips direct `agent.reasoningEffort` and `agent.textVerbosity`. Their exact canonical values intentionally live under each recognized `agent.options` object; OpenCode 1.17.15 merges these options into runtime agent requests. Do not move or duplicate them as direct agent keys.
- Never edit a published release asset, retag, manually deploy Pages, or rebuild downstream artifacts. Pages receives an archive verified from the immutable workflow bundle.

## Local preparation

Use the verified Bun 1.3.5 binary, not a system Bun: `bun install --frozen-lockfile`; `bun test tests`; `bun run build -- --version 0.1.0 --out "$TMPDIR/pages"`; `bun run validate -- --version 0.1.0 --commit "$(git rev-parse HEAD)" --work-dir "$TMPDIR/validate"`. Keep OCX/OpenCode and all XDG roots disposable; never test against the real profile.

## Release state machine

After a protected PR passes required `validate-pinned`, bump source `registry.jsonc#/version` and `package.json` together. Re-run validation, merge, then create only an annotated tag: `git tag -a vX.Y.Z -m vX.Y.Z` and push it. Release accepts annotated tags on `main` only. It validates source before production inspection, creates/reuses only matching draft assets, verifies the exact archive before deployment, live-verifies Pages, then publishes the draft.

The shared `pages-production` lock never cancels in-progress deployments. Initial publication is only `v0.1.0` with no prior live release. Higher versions capture a verified recovery bundle before mutation. Equal exact content resumes a draft or is a verified published no-op; equal mismatch, lower tag, malformed state, missing recovery, or divergent assets fail closed. If deploy was attempted, live verification failed, and recovery exists, restore and verify old bytes. A failed first publication leaves the draft and requires explicit cleanup/recovery; never improvise restoration.

## Rollback and recovery

Run the manual rollback workflow with an existing release tag and explicit confirmation. It downloads that release, verifies checksums/provenance/receipt/archive before extraction, and redeploys exact bytes. It changes global `latest`; it neither moves tags nor pins future `kdco/workspace` resolution. If a release job fails, retain diagnostics and draft, inspect `release.json`, then rerun only after the state machine’s guards are satisfied.

## Supply chain and secrets

Only update action SHAs or binary checksums in a reviewed PR after independently verifying upstream release provenance and compatibility. `GITHUB_TOKEN` belongs only in workflow environment; never print it, put it in evidence, or pass it to untrusted PR jobs. Linear is intentionally enabled and may require OAuth with read/write scope; OpenCode global configuration merges natively, so this package cannot promise behavioral isolation.
