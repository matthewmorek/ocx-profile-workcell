# Third-party notices

## Debug-investigation skill adaptation

`files/skills/debug-investigation/SKILL.md` adapts investigation concepts from
the MIT-licensed `systematic-debugging` skill in
[`obra/superpowers`](https://github.com/obra/superpowers). The supplied upstream
artifact was verified at immutable commit
[`b36e0829c6d0140e93cfef2ca599b1b07d4a7797`](https://github.com/obra/superpowers/commit/b36e0829c6d0140e93cfef2ca599b1b07d4a7797),
release `v6.3.0`, authored 2026-08-12. The source file is
`skills/systematic-debugging/SKILL.md` (blob
`095d194ac041502905f15b01d22d294fb94db8b2`, 9465 bytes); the upstream license
is blob `abf0390320aa14406af7a520b9b0739fdda9bf08` (1070 bytes).

Workcell retains the upstream ideas of careful error reading, recent-change
review, data-flow tracing, working-example comparison, and single falsifiable
hypotheses. It deliberately transforms them into observation-first,
evidence-to-report guidance: mandatory reproduction, instrumentation, failing
regression tests, fixes, implementation dependencies, and superpowers-specific
workflow are omitted. The three packaged reference files are Workcell-owned
adaptations, not upstream copies. The complete upstream MIT notice is also
embedded at the end of the packaged `SKILL.md` because the repository notice
does not necessarily ship with an installed profile.

```text
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

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
