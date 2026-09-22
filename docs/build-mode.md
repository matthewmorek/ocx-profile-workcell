# Build mode

Build is the implementation workflow. It turns an accepted plan or bounded
request into source changes, then hands the result through the repository's
tester and reviewer checks. Build is not a replacement for planning, debugging,
or review.

## Boundaries

- Preserve existing contracts, permissions, profile identity, and provenance.
- Make the smallest change that satisfies the accepted requirements.
- Do not change global configuration, install a machine-wide runtime, or add a
  custom launcher as part of repository work.
- After configuration or plugin changes, use a fresh OpenCode session.

Run the focused repository checks before handoff:

```sh
bun run build
bun run test
bun run smoke
```

Smoke covers packaging and the isolated installation lifecycle only. It does
not prove native runtime behavior, agent/tool routing, or DCP activation.
