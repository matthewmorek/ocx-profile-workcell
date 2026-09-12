# Connected-tool evidence

Connected-service reads remain bounded, read-scoped, and attributable. Before
each operation record the exact target, project/account, time or filter,
row/page/cost bound, and whether private data leaves the service. Read results
can still cost money or expose data; minimize public-research queries and never
send private data to external research. This record is nonblocking disclosure,
not a request for conversational approval: invoke in-scope reads directly under
native tool authorization. Honor rejection or denial without retrying for
permission or routing around it; continue with existing evidence or report limits.

## LAN connections versus service mutation

Ordinary bounded DNS/TCP/TLS and non-mutating HTTP diagnostics to user-designated
or evidence-relevant LAN hosts are permitted connections, not remote service
mutations. Use [the local network procedure](system-project.md) to discover relevant
targets and enforce route, port, timeout, retry, concurrency, output and exposure
bounds. No separate conversational approval is needed for each host or connection;
native tool authorization still applies. Do not automatically follow redirects,
send credentials/private payloads, or treat a GET method as proof of no effects.

Connecting for diagnosis does not permit remote login, restart, configuration
changes, writes, installations, or other service mutations. It also does not enable
custom/MCP tools: exact reviewed opt-in below remains mandatory. An unavailable or
denied network tool is not a reason to bypass policy through shell or another tool.

## GitHub CLI

Prefer narrowly scoped `gh view`, `gh list`, or `gh log` reads. `gh api` uses
`-f`/`-F` fields that can turn a request into POST; make a read method explicit
when required and avoid GraphQL mutations. Inspect the requested review, issue,
commit, or workflow output rather than broad repository history. Existing
authentication may be used for an in-scope, natively authorized read, but do not
log in, change credentials, alter scopes, rerun CI, write tickets, or mutate reviews.

## Firebase and other service CLIs

Do not treat `firebase --only` as read-only, and do not assume a universal
`--read-only` flag. Never run login, init, deploy, use, remote writes, or CI
reruns. An already-authenticated, existing read-scoped tool may be used only for
the exact disclosed in-scope target and bounds under native authorization. Do not
change project selection, account, credentials, or service configuration.

## MCP and optional tools

Use an MCP tool only when its exact catalog name and capability have been
reviewed and explicitly opted in. For example, an approved configuration may
contain an exact placeholder such as `debug.read_catalog_item` under
`agent.debug.permission`, mapped to `"ask"`; replace it only with a real catalog
name after user review. Never use broad `*`, `mcp.*`, or MCP-prefix patterns,
and do not claim that a user-configured MCP server exists automatically. The
debug primary cannot edit its own permissions or install a server. A same-name
custom handler can still bypass an ask unless it cooperates with `context.ask`.
Reviewed exact-name opt-in is a configuration prerequisite, not a per-operation
question. Native Auto approval does not enable denied tools or guarantee that
custom handlers participate in native authorization.

Keep private service data out of public research prompts. Preserve source URLs,
timestamps, filters, and failed or contradictory results in the report.
