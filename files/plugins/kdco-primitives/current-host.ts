import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { Plugin } from "@opencode/plugin"

/** Connect only to this plugin's authenticated, exact-version managed host.
 * Discovery alone is not identity: a private server can discover another daemon.
 * Never start/restart a server or fall back to an arbitrary discovered endpoint.
 */
export async function currentHost(ctx: Pick<Plugin.Context, "app" | "location">): Promise<OpenCodeClient> {
	if (ctx.app.version !== "2.0.12") throw new Error("Workcell requires OpenCode 2.0.12; restart with the pinned Workcell runtime.")
	const endpoint = await Service.discover({ version: ctx.app.version })
	if (!endpoint?.auth) throw new Error("Workcell lifecycle operations require the authenticated Workcell-configured managed background server. Private/standalone hosts are unsupported. Explicitly restart the server when switching profiles.")
	const url = new URL(endpoint.url)
	if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new Error("Workcell lifecycle operations require a local loopback managed server; remote hosts are unsupported.")
	const client = OpenCode.make({ baseUrl: endpoint.url, headers: { ...Service.headers(endpoint), "x-opencode-directory": ctx.location.directory } })
	const info = await client.server.info({ signal: AbortSignal.timeout(5000) })
	if (info.pid !== process.pid || info.version !== ctx.app.version) throw new Error("Workcell refused lifecycle access: discovered server is not the current plugin host. Restart the managed server with the Workcell profile.")
	return client
}
