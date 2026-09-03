# Third-party notices

## KDCO OCX and Workspace material

This repository contains copied and modified OCX/Workspace material from
[`https://github.com/kdcokenny/ocx`](https://github.com/kdcokenny/ocx), including
material from its Workspace harness. The authoritative copied-source baseline is
the immutable commit [`75e05a9a3280e5ee16953d7b9d6c42ad4d893697`](https://github.com/kdcokenny/ocx/commit/75e05a9a3280e5ee16953d7b9d6c42ad4d893697),
dated 2026-03-07. The corresponding source tree is
[`workers/kdco-registry/files/`](https://github.com/kdcokenny/ocx/tree/75e05a9a3280e5ee16953d7b9d6c42ad4d893697/workers/kdco-registry/files),
which is the source root for the copied areas listed below. The authoritative
repository tree at that revision is
[`75e05a9a3280e5ee16953d7b9d6c42ad4d893697`](https://github.com/kdcokenny/ocx/tree/75e05a9a3280e5ee16953d7b9d6c42ad4d893697).
The authoritative license source at that revision is
[`LICENSE`](https://github.com/kdcokenny/ocx/blob/75e05a9a3280e5ee16953d7b9d6c42ad4d893697/LICENSE).

The local-to-authoritative mapping is:

| Local Workcell area | Authoritative source at `75e05a9a3280e5ee16953d7b9d6c42ad4d893697` |
| --- | --- |
| `files/agents/**` | `workers/kdco-registry/files/agents/**` |
| `files/skills/**` | `workers/kdco-registry/files/skills/**` |
| `files/commands/**` | `workers/kdco-registry/files/commands/**` |
| `files/tools/**` | `workers/kdco-registry/files/tools/**` |
| `files/plugins/workspace-plugin.ts` | `workers/kdco-registry/files/plugins/workspace-plugin.ts` |
| `files/plugins/background-agents.ts` | `workers/kdco-registry/files/plugins/background-agents.ts` |
| `files/plugins/notify.ts` and `files/plugins/notify/**` | `workers/kdco-registry/files/plugins/notify.ts` and `workers/kdco-registry/files/plugins/notify/**` |
| `files/plugins/kdco-primitives/**` | `workers/kdco-registry/files/plugins/kdco-primitives/**` |
| `files/plugins/worktree.ts` and `files/plugins/worktree/**` | `workers/kdco-registry/files/plugins/worktree.ts` and `workers/kdco-registry/files/plugins/worktree/**` |

The copied KDCO material has subsequently been modified by Workcell. It remains
covered by the preserved MIT notice in
[LICENSES/KDCO-OCX-MIT.txt](LICENSES/KDCO-OCX-MIT.txt):

```text
Copyright (c) 2026 Kenny
MIT License
```

The MIT copyright and license notices must be retained in copies and substantial
portions of that material. Each import must also record the immutable upstream
revision (commit, tag, or other content-addressed revision) from which the copied
material was taken. Do not replace an immutable revision with a floating branch
reference. The preserved license text is in
[LICENSES/KDCO-OCX-MIT.txt](LICENSES/KDCO-OCX-MIT.txt).

Workcell is an independent project. KDCO does not affiliate with, endorse, or
sponsor Workcell, and this notice does not imply otherwise.

The KDCO source says “Based on” historical **Oh My OpenCode** / current **Oh My
OpenAgent**. This is an attribution-only acknowledgment: no immutable revision
or file-level copying map has been established for that attribution. This notice
does not claim that Oh My OpenCode code was copied, and does not claim that the
current Sustainable Use License for Oh My OpenAgent applies to Workcell's copied
KDCO source.

Workcell also acknowledges **felixAnhalt/opencode-worktree-session** as an
inspiration/provenance reference: release
[`v1.1.0`](https://github.com/felixAnhalt/opencode-worktree-session/releases/tag/v1.1.0)
and immutable commit
[`93a55c23c9fd5ce9328d090d31a74e7357af5d8d`](https://github.com/felixAnhalt/opencode-worktree-session/commit/93a55c23c9fd5ce9328d090d31a74e7357af5d8d).
That reference is identified as Apache-2.0 licensed; no verified file-level
copying map has been established. This acknowledgment does not imply affiliation
or endorsement.

## DCP

DCP 3.1.15 is separately fetched AGPL-3.0-or-later software referenced by the
harness. It is not copied into this repository and is not vendored here. Its own
distribution and license notices govern that separately fetched software.

This notice is informational and is not legal advice.
