# OCX Workspace Profile

An independent derivative OCX profile based on and inspired by [KDCO Workspace](https://github.com/kdcokenny/opencode-workspace).

## Quickstart

```sh
ocx init --global
ocx profile add ws --source matthewmorek/ws --from https://matthewmorek.github.io/ocx-workspace-profile --global
ocx oc -p ws
```

## What this changes

The `ws` profile installs upstream `kdco/workspace`, then applies the fileless
`ws-overrides` bundle. It ships two profile files:

```text
profiles/ws/
├── ocx.jsonc
└── AGENTS.md
```

This registry does not copy or fork KDCO source. The canonical upstream registry
source is [`kdco-registry`](https://github.com/kdcokenny/ocx/tree/main/workers/kdco-registry).
See [OCX](https://github.com/kdcokenny/ocx) and the [OCX documentation](https://ocx.kdco.dev/)
for the registry format and commands.

## Notes

- Linear may request OAuth and read/write access on first use.
- OpenCode global configuration can still merge with this profile.
- `kdco/workspace` follows its upstream latest version.

## Updating

OCX 2.0.14 has no profile update command: move or remove the existing `ws`, then rerun the install command above.

## Maintainers

Normal release: bump the registry and package versions, merge, then create and push
an annotated tag such as `git tag -a vX.Y.Z -m vX.Y.Z`. Automation tests, builds,
and deploys Pages, then creates the GitHub Release. See [AGENTS.md](AGENTS.md).

## License

MIT. This is an independent project and is not endorsed by KDCO.
