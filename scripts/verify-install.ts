import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fail, parseArguments, parseVersion, readJsonc, repositoryRoot, requiredArgument, temporaryDirectory, writeJsonAtomic } from "./common";

type Evidence = { schemaVersion: 1; version: string; commit: string; installedComponents: string[]; resolvedDependencies: unknown; assertions: Record<string, boolean>; receipt: unknown; toolVersions: Record<string, string> };

async function run(command: string[], environment: Record<string, string>, timeoutMs: number): Promise<string> {
  const child = Bun.spawn(command, { env: { ...process.env, ...environment }, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timeout);
  if (code !== 0) fail(`${command[0]} failed: ${stderr || stdout}`);
  return stdout;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(Bun.argv.slice(2), ["--registry", "--version", "--commit", "--evidence-out"]);
  const registry = requiredArgument(arguments_, "--registry");
  const version = parseVersion(requiredArgument(arguments_, "--version"));
  const commit = requiredArgument(arguments_, "--commit");
  const evidenceOut = resolve(requiredArgument(arguments_, "--evidence-out"));
  const sandbox = await temporaryDirectory("ocx-install");
  const config = join(sandbox, "config");
  const data = join(sandbox, "data");
  const cache = join(sandbox, "cache");
  const state = join(sandbox, "state");
  const source = registry.startsWith("http") ? { url: registry, stop: () => {} } : await serveRegistry(resolve(registry));
  const environment = { XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache, XDG_STATE_HOME: state, HOME: join(sandbox, "home") };
  const ocx = process.env.OCX_BIN ?? "ocx";
  const opencode = process.env.OPENCODE_BIN ?? "opencode";
  try {
    await Promise.all([config, data, cache, state].map((directory) => mkdir(directory, { recursive: true })));
    const ocxVersion = (await run([ocx, "--version"], environment, 10_000)).trim();
    const opencodeVersion = (await run([opencode, "--version"], environment, 10_000)).trim();
    await run([ocx, "init", "--global", "--quiet"], environment, 20_000);
    await run([ocx, "profile", "add", "ws", "--source", "matthewmorek/ws", "--from", source.url, "--global"], environment, 60_000);
    await run([ocx, "verify", "--cwd", join(config, "opencode", "profiles", "ws")], environment, 30_000);
    await run([ocx, "oc", "-p", "ws", "--help"], environment, 20_000);
    const profileRoot = join(config, "opencode", "profiles", "ws");
    const generated = await readJsonc<Record<string, unknown>>(join(profileRoot, "opencode.jsonc"));
    const receipt = await readJsonc<unknown>(join(profileRoot, ".ocx", "receipt.jsonc"));
    const sourceRegistry = await readJsonc<{ components?: Array<{ name?: string; opencode?: Record<string, unknown> }> }>(join(repositoryRoot, "registry.jsonc"));
    const expected = sourceRegistry.components?.find((component) => component.name === "ws-overrides")?.opencode;
    if (!expected) fail("Registry source has no ws-overrides opencode metadata.");
    const assertions = assertInstalledConfiguration(generated, expected);
    if (Object.values(assertions).some((passed) => !passed)) fail(`Installed profile assertions failed: ${Object.entries(assertions).filter(([, passed]) => !passed).map(([key]) => key).join(", ")}.`);
    const evidence: Evidence = { schemaVersion: 1, version, commit, installedComponents: collectComponentKeys(receipt), resolvedDependencies: sanitize(receipt), assertions, receipt: sanitize(receipt), toolVersions: { ocx: ocxVersion, opencode: opencodeVersion } };
    assertSanitized(evidence);
    await writeJsonAtomic(evidenceOut, evidence);
  } finally { source.stop(); await rm(sandbox, { recursive: true, force: true }); }
}

async function serveRegistry(directory: string): Promise<{ url: string; stop(): void }> {
  const server = Bun.serve({ port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname.replace(/^\/+/, "");
    if (!pathname || pathname.includes("..") || pathname.includes("\\")) return new Response("Not found", { status: 404 });
    const path = resolve(directory, pathname);
    if (!path.startsWith(`${directory}/`)) return new Response("Not found", { status: 404 });
    try { return new Response(await readFile(path)); } catch { return new Response("Not found", { status: 404 }); }
  } });
  const response = await fetch(`http://127.0.0.1:${server.port}/index.json`);
  if (!response.ok) { server.stop(); fail("Local registry server did not become ready."); }
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function assertInstalledConfiguration(generated: Record<string, unknown>, expected: Record<string, unknown>): Record<string, boolean> {
  const canonicalize = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])])) : value;
  const equal = (key: string) => JSON.stringify(canonicalize(generated[key])) === JSON.stringify(canonicalize(expected[key]));
  const expectedAgents = expected.agent as Record<string, Record<string, unknown>>;
  const generatedAgents = generated.agent as Record<string, Record<string, unknown>>;
  const semanticAgents = Object.entries(expectedAgents).every(([name, agent]) => JSON.stringify(canonicalize(generatedAgents?.[name])) === JSON.stringify(canonicalize(agent)) && !Object.hasOwn(generatedAgents[name], "reasoningEffort") && !Object.hasOwn(generatedAgents[name], "textVerbosity"));
  const mcp = generated.mcp as Record<string, unknown> | undefined;
  const plugins = generated.plugin as unknown[] | undefined;
  return { model: equal("model"), smallModel: equal("small_model"), agents: semanticAgents, permissions: equal("permission"), mcps: ["context7", "exa", "gh_grep", "linear"].every((name) => name in (mcp ?? {})) && !mcp?.posthog && !mcp?.tuple, tailPlugins: Array.isArray(plugins) && plugins.includes("opencode-vibeguard@0.1.0") && plugins.includes("@plannotator/opencode@0.26.0"), noPosthogOrTuple: !mcp?.posthog && !mcp?.tuple };
}

function collectComponentKeys(receipt: unknown): string[] {
  const text = JSON.stringify(receipt);
  return ["ws", "ws-overrides", "workspace"].filter((component) => text.includes(`\"${component}\"`));
}
function sanitize(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\/Users\/[^/\" ]+/g, "<redacted-path>").replace(/(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^,\s\"}]+/gi, "<redacted-secret>");
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitize(entry)]));
  return value;
}
function assertSanitized(value: unknown): void { const serialized = JSON.stringify(value); if (/\/Users\/|token|secret|password|api[_-]?key/i.test(serialized)) fail("Evidence contains a machine path or secret-like value."); }

await main();
