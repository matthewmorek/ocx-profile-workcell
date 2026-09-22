# Workcell

## About

Workcell is a self-contained OCX profile for `matthewmorek/workcell`, packaged
and maintained in [`matthewmorek/ocx-profile-workcell`](https://github.com/matthewmorek/ocx-profile-workcell).
It exists to provide a focused, locally packaged OpenCode workspace with
explicit workflows, permissions, and lifecycle boundaries.

## Getting Started

### Prerequisites

- Workcell 0.5.0: Apple Silicon macOS, Bun 1.4.1, and OpenCode 2.0.12.
- Registry target: OCX 2.0.14; repository validation uses OCX 2.0.15.

### Installation

```sh
ocx init --global
ocx profile add workcell \
  --source matthewmorek/workcell \
  --from https://matthewmorek.github.io/ocx-profile-workcell \
  --global
ocx oc -p workcell
```

After installing or changing the profile, quit and start a fresh
`ocx oc -p workcell` session. Switching profiles also requires explicitly
restarting the managed daemon; CLI reuse does not apply later OCX configuration
to an already-running server.

## Usage

- [Debug mode](docs/debug-mode.md)
- [Plan mode and Plannotator integration](docs/plan-mode.md)
- [Build mode](docs/build-mode.md)
- [Review mode and GitHub PR review](docs/review-mode.md)
- [Notifications and cmux status](docs/notifications.md)
- [Troubleshooting](docs/troubleshooting.md)

## Contributing

See [contributing.md](contributing.md) for development checks, pull requests,
releases, and migration guidance.

## Identity, provenance, and license

The public profile is `workcell`, its aggregate component is
`workcell-bundle`, and its OCX source is `matthewmorek/workcell`. Workcell is
MIT-licensed; see [LICENSE](LICENSE). Copied and adapted KDCO OCX/Workspace
material and other provenance are documented in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). DCP 3.2.0 is an external
AGPL-3.0-or-later dependency and is not vendored.
