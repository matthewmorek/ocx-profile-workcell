# Connected-tool evidence

Connected-service reads remain bounded, read-scoped, and attributable. Before
each operation record the exact target, project/account, time or filter,
row/page/cost bound, and whether private data leaves the service. Read results
can still cost money or expose data; minimize public-research queries and never
send private data to external research.

## GitHub CLI

Prefer narrowly scoped `gh view`, `gh list`, or `gh log` reads. `gh api` uses
`-f`/`-F` fields that can turn a request into POST; make a read method explicit
when required and avoid GraphQL mutations. Inspect the requested review, issue,
commit, or workflow output rather than broad repository history. Existing
authentication may be used for an already-approved read, but do not log in,
change credentials, alter scopes, rerun CI, write tickets, or mutate reviews.

## Firebase and other service CLIs

Do not treat `firebase --only` as read-only, and do not assume a universal
`--read-only` flag. Never run login, init, deploy, use, remote writes, or CI
reruns. An already-authenticated, existing read-scoped tool may be used only for
the exact approved target and bounds. Do not change project selection, account,
credentials, or service configuration.

## MCP and optional tools

Use an MCP tool only when its exact catalog name and capability have been
reviewed and explicitly opted in. For example, an approved configuration may
contain an exact placeholder such as `debug.read_catalog_item` under
`agent.debug.permission`, mapped to `"ask"`; replace it only with a real catalog
name after user review. Never use broad `*`, `mcp.*`, or MCP-prefix patterns,
and do not claim that a user-configured MCP server exists automatically. The
debug primary cannot edit its own permissions or install a server. A same-name
custom handler can still bypass an ask unless it cooperates with `context.ask`.

Keep private service data out of public research prompts. Preserve source URLs,
timestamps, filters, and failed or contradictory results in the report.
