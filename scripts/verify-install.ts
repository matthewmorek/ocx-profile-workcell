import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fail, parseArguments, parseVersion, readJsonc, repositoryRoot, requiredArgument, temporaryDirectory, writeJsonAtomic } from "./common";
import { assertEvidenceIsSafe, assertReceiptProfileRoot, parseInstallReceipt, parseRootProfileIdentity, sanitizeEvidenceValue, type InstallAttemptOutcome, type InstallEvidence, type ToolVersions, type ValidationRecord } from "./evidence";

type StageRecord = {
  name: string;
  command: string[];
  timeoutMs: number;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  exitCode: number;
  timedOut: boolean;
  termination: ReadonlyArray<{ signal: "SIGTERM" | "SIGKILL"; at: string }>;
  stdout: string;
  stderr: string;
};

type RegistryRequest = { at: string; method: string; path: string; status: number };

type DiagnosticContext = { registry: string; sandbox: string; stages: StageRecord[]; requests: RegistryRequest[] };
type RegistrySource = { url: string; stop(): void };
type RetryableFailure = "timeout" | "network";

const stageTimeouts = {
  toolVersion: 10_000,
  initializeProfile: 20_000,
  installProfile: 120_000,
  verifyProfile: 30_000,
  smokeOpenCode: 30_000,
} as const;
const pinnedToolVersions = { ocx: "2.0.14", opencode: "1.17.15" } as const;
const invokedRootProfile = parseRootProfileIdentity({ source: "matthewmorek/ws", installedName: "ws" });

function elapsedMilliseconds(startedAt: number): number { return Math.round(performance.now() - startedAt); }

function commandDescription(command: string[]): string { return command.join(" "); }

async function execute(command: string[], environment: Record<string, string>, timeoutMs: number, name: string): Promise<StageRecord> {
  const startedAt = performance.now();
  const startedAtIso = new Date().toISOString();
  const child = Bun.spawn(command, { env: environment, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const termination: Array<{ signal: "SIGTERM" | "SIGKILL"; at: string }> = [];
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    termination.push({ signal: "SIGTERM", at: new Date().toISOString() });
    child.kill("SIGTERM");
    forceKill = setTimeout(() => {
      termination.push({ signal: "SIGKILL", at: new Date().toISOString() });
      child.kill("SIGKILL");
    }, 5_000);
  }, timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => {
    clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
  });
  return { name, command, timeoutMs, startedAt: startedAtIso, completedAt: new Date().toISOString(), elapsedMs: elapsedMilliseconds(startedAt), exitCode, timedOut, termination, stdout, stderr };
}

class StageFailure extends Error {
  constructor(readonly stage: StageRecord) {
    const output = stage.stderr || stage.stdout || "no diagnostic output";
    const reason = stage.timedOut ? `exceeded its ${stage.timeoutMs}ms timeout` : `failed with exit code ${stage.exitCode}`;
    super(`Stage ${stage.name} ${reason} after ${stage.elapsedMs}ms while running ${commandDescription(stage.command)}: ${output}`);
  }
}

function assertStageSucceeded(stage: StageRecord): string {
  if (stage.timedOut || stage.exitCode !== 0) throw new StageFailure(stage);
  return stage.stdout;
}

export async function run(command: string[], environment: Record<string, string>, timeoutMs: number): Promise<string> {
  return assertStageSucceeded(await execute(command, environment, timeoutMs, command[0]));
}

export function createSandboxEnvironment(sandbox: string): Record<string, string> {
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => value !== undefined && !/^(HOME|XDG_.+|OPENCODE_.+|OCX_.+)$/i.test(key))
    .map(([key, value]) => [key, value!])) as Record<string, string>;
  return {
    ...inherited,
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_STATE_HOME: join(sandbox, "state"),
    HOME: join(sandbox, "home"),
  };
}

function parseReportedVersion(tool: string, output: string): string {
  const matches = output.match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[^0-9])/g) ?? [];
  if (matches.length !== 1) fail(`${tool} must report exactly one SemVer version, received ${output}.`);
  return matches[0].match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/)![0];
}

function parseValidationRecord(mode: string, expectedOcxVersion: string | undefined, expectedOpenCodeVersion: string | undefined): Pick<ValidationRecord, "mode" | "expectedToolVersions"> {
  if (mode === "advisory") {
    if (expectedOcxVersion !== undefined || expectedOpenCodeVersion !== undefined) fail("Advisory validation must not receive expected tool versions.");
    return { mode, expectedToolVersions: null };
  }
  if (mode !== "pinned" || expectedOcxVersion !== pinnedToolVersions.ocx || expectedOpenCodeVersion !== pinnedToolVersions.opencode) fail("Pinned validation requires OCX 2.0.14 and OpenCode 1.17.15.");
  return { mode, expectedToolVersions: pinnedToolVersions };
}

function assertPinnedVersions(discovered: ToolVersions, expected: ToolVersions): void {
  if (discovered.ocx !== expected.ocx || discovered.opencode !== expected.opencode) fail(`Pinned validation requires OCX ${expected.ocx} and OpenCode ${expected.opencode}; received OCX ${discovered.ocx} and OpenCode ${discovered.opencode}.`);
}

async function runStage(name: string, command: string[], environment: Record<string, string>, timeoutMs: number, stages: StageRecord[]): Promise<string> {
  const stage = await execute(command, environment, timeoutMs, name);
  stages.push(stage);
  return assertStageSucceeded(stage);
}

async function retainDiagnostics(directory: string | undefined, context: DiagnosticContext): Promise<void> {
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeJsonAtomic(join(directory, "stages.json"), context.stages);
  await writeJsonAtomic(join(directory, "stage-timings.json"), context.stages.map(({ name, timeoutMs, startedAt, completedAt, elapsedMs, exitCode, timedOut }) => ({ name, timeoutMs, startedAt, completedAt, elapsedMs, exitCode, timedOut })));
  await writeJsonAtomic(join(directory, "stdout-stderr.json"), context.stages.map(({ name, stdout, stderr }) => ({ name, stdout, stderr })));
  await writeJsonAtomic(join(directory, "process-termination.json"), context.stages.map(({ name, timedOut, termination }) => ({ name, timedOut, termination })));
  await writeJsonAtomic(join(directory, "registry-requests.json"), context.requests);
  await writeJsonAtomic(join(directory, "context.json"), { registry: context.registry });
  await cp(context.sandbox, join(directory, "sandbox"), { recursive: true, force: true, errorOnExist: false });
}

function retryableInstallFailure(error: unknown): RetryableFailure | undefined {
  if (!(error instanceof StageFailure) || error.stage.name !== "install official KDCO workspace profile") return;
  const output = `${error.stage.stderr}\n${error.stage.stdout}`;
  if (/checksum|sha(?:256)?|schema|config(?:uration)?|validation|policy|assertion|deterministic|malformed|invalid|mismatch|signature/i.test(output)) return;
  if (error.stage.timedOut) return "timeout";
  if (/econnreset|econnrefused|etimedout|eai_again|enotfound|network|socket hang up|connection (?:reset|refused|closed|timed out)|tls handshake|fetch failed|service unavailable|bad gateway|gateway timeout|\b(?:502|503|504)\b/i.test(output)) return "network";
}

class InstallAttemptFailure extends Error {
  constructor(readonly cause: unknown, readonly retryable: RetryableFailure | undefined) {
    super(cause instanceof Error ? cause.message : "Install attempt failed.");
  }
}

async function runInstallAttempt(registry: string, version: string, commit: string, ocx: string, opencode: string, validation: Pick<ValidationRecord, "mode" | "expectedToolVersions">, diagnosticsDirectory: string): Promise<InstallEvidence> {
  const sandbox = await temporaryDirectory("ocx-install");
  const environment = createSandboxEnvironment(sandbox);
  let source: RegistrySource | undefined;
  const stages: StageRecord[] = [];
  const requests: RegistryRequest[] = [];
  let succeeded = false;
  try {
    await Promise.all([environment.HOME, environment.XDG_CONFIG_HOME, environment.XDG_DATA_HOME, environment.XDG_CACHE_HOME, environment.XDG_STATE_HOME].map((directory) => mkdir(directory, { recursive: true })));
    source = /^https?:\/\//.test(registry) ? { url: registry, stop: () => {} } : await serveRegistry(resolve(registry), requests);
    const ocxVersion = parseReportedVersion("OCX", (await runStage("verify OCX version", [ocx, "--version"], environment, stageTimeouts.toolVersion, stages)).trim());
    const opencodeVersion = parseReportedVersion("OpenCode", (await runStage("verify OpenCode version", [opencode, "--version"], environment, stageTimeouts.toolVersion, stages)).trim());
    const discoveredToolVersions = { ocx: ocxVersion, opencode: opencodeVersion };
    if (validation.mode === "pinned") assertPinnedVersions(discoveredToolVersions, validation.expectedToolVersions!);
    await runStage("initialize disposable OCX profile root", [ocx, "init", "--global", "--quiet"], environment, stageTimeouts.initializeProfile, stages);
    await runStage("install official KDCO workspace profile", [ocx, "profile", "add", invokedRootProfile.installedName, "--source", invokedRootProfile.source, "--from", source.url, "--global"], environment, stageTimeouts.installProfile, stages);
    await runStage("verify installed OCX profile", [ocx, "verify", "--cwd", join(environment.XDG_CONFIG_HOME, "opencode", "profiles", "ws")], environment, stageTimeouts.verifyProfile, stages);
    await runStage("smoke OpenCode profile startup", [ocx, "oc", "-p", "ws", "--help"], environment, stageTimeouts.smokeOpenCode, stages);
    const profileRoot = join(environment.XDG_CONFIG_HOME, "opencode", "profiles", "ws");
    const generated = await readJsonc<Record<string, unknown>>(join(profileRoot, "opencode.jsonc"));
    const rawReceipt = await readJsonc<unknown>(join(profileRoot, ".ocx", "receipt.jsonc"));
    assertReceiptProfileRoot(rawReceipt, profileRoot);
    const parsedReceipt = parseInstallReceipt(sanitizeEvidenceValue(rawReceipt));
    const sourceRegistry = await readJsonc<{ components?: Array<{ name?: string; opencode?: Record<string, unknown> }> }>(join(repositoryRoot, "registry.jsonc"));
    const expected = sourceRegistry.components?.find((component) => component.name === "ws-overrides")?.opencode;
    if (!expected) fail("Registry source has no ws-overrides opencode metadata.");
    const assertions = assertInstalledConfiguration(generated, expected);
    if (Object.values(assertions).some((passed) => !passed)) fail(`Installed profile assertions failed: ${Object.entries(assertions).filter(([, passed]) => !passed).map(([key]) => key).join(", ")}.`);
    const evidence: InstallEvidence = {
      schemaVersion: 1,
      version,
      commit,
      rootProfile: invokedRootProfile,
      resolvedDependencyComponents: parsedReceipt.resolvedDependencyComponents,
      assertions: assertions as Record<string, true>,
      receipt: parsedReceipt.receipt,
      validation: { ...validation, discoveredToolVersions },
    };
    assertEvidenceIsSafe(evidence);
    succeeded = true;
    return evidence;
  } catch (error) {
    source?.stop();
    source = undefined;
    await retainDiagnostics(diagnosticsDirectory, { registry, sandbox, stages, requests });
    throw new InstallAttemptFailure(error, retryableInstallFailure(error));
  } finally {
    source?.stop();
    await rm(sandbox, { recursive: true, force: true });
    if (succeeded) await rm(diagnosticsDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(Bun.argv.slice(2), ["--registry", "--version", "--commit", "--evidence-out", "--diagnostics-dir", "--validation-mode", "--expected-ocx-version", "--expected-opencode-version"]);
  const registry = requiredArgument(arguments_, "--registry");
  const version = parseVersion(requiredArgument(arguments_, "--version"));
  const commit = requiredArgument(arguments_, "--commit");
  const evidenceOut = resolve(requiredArgument(arguments_, "--evidence-out"));
  const diagnosticsArgument = arguments_.get("--diagnostics-dir");
  const diagnosticsDirectory = diagnosticsArgument ? resolve(diagnosticsArgument) : join(dirname(evidenceOut), "install-diagnostics");
  const ocx = process.env.OCX_BIN ?? "ocx";
  const opencode = process.env.OPENCODE_BIN ?? "opencode";
  const validation = parseValidationRecord(requiredArgument(arguments_, "--validation-mode"), arguments_.get("--expected-ocx-version"), arguments_.get("--expected-opencode-version"));
  await rm(diagnosticsDirectory, { recursive: true, force: true });
  await mkdir(diagnosticsDirectory, { recursive: true });
  const attempts: InstallAttemptOutcome[] = [];
  for (const number of [1, 2]) {
    const attemptDiagnostics = join(diagnosticsDirectory, `attempt-${number}`);
    await mkdir(attemptDiagnostics, { recursive: true });
    try {
      const evidence = await runInstallAttempt(registry, version, commit, ocx, opencode, validation, attemptDiagnostics);
      attempts.push({ number, outcome: "succeeded" });
      const withAttempts: InstallEvidence = { ...evidence, attempts };
      assertEvidenceIsSafe(withAttempts);
      await writeJsonAtomic(evidenceOut, withAttempts);
      return;
    } catch (error) {
      if (!(error instanceof InstallAttemptFailure)) throw error;
      if (!error.retryable) throw error;
      attempts.push({ number, outcome: "failed", failure: error.retryable });
      if (number === 2) throw error;
    }
  }
  fail("Install verification exhausted its bounded attempts.");
}

export async function serveRegistry(directory: string, requests: RegistryRequest[] = []): Promise<{ url: string; stop(): void }> {
  const server = Bun.serve({ port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname.replace(/^\/+/, "");
    if (!pathname || pathname.includes("..") || pathname.includes("\\")) {
      requests.push({ at: new Date().toISOString(), method: request.method, path: pathname || "/", status: 404 });
      return new Response("Not found", { status: 404 });
    }
    const path = resolve(directory, pathname);
    if (!path.startsWith(`${directory}/`)) {
      requests.push({ at: new Date().toISOString(), method: request.method, path: pathname, status: 404 });
      return new Response("Not found", { status: 404 });
    }
    try {
      const content = await readFile(path);
      requests.push({ at: new Date().toISOString(), method: request.method, path: pathname, status: 200 });
      return new Response(content);
    } catch {
      requests.push({ at: new Date().toISOString(), method: request.method, path: pathname, status: 404 });
      return new Response("Not found", { status: 404 });
    }
  } });
  const response = await fetch(`http://127.0.0.1:${server.port}/index.json`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) { server.stop(); fail("Local registry server did not become ready."); }
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export function assertInstalledConfiguration(generated: Record<string, unknown>, expected: Record<string, unknown>): Record<string, boolean> {
  const canonicalize = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])])) : value;
  const equal = (key: string) => JSON.stringify(canonicalize(generated[key])) === JSON.stringify(canonicalize(expected[key]));
  const expectedAgents = expected.agent as Record<string, Record<string, unknown>>;
  const generatedAgents = generated.agent as Record<string, Record<string, unknown>>;
  const semanticAgents = Object.entries(expectedAgents).every(([name, agent]) => JSON.stringify(canonicalize(generatedAgents?.[name])) === JSON.stringify(canonicalize(agent)) && !Object.hasOwn(generatedAgents[name], "reasoningEffort") && !Object.hasOwn(generatedAgents[name], "textVerbosity"));
  const mcp = generated.mcp as Record<string, unknown> | undefined;
  const plugins = generated.plugin as unknown[] | undefined;
  const expectedMcps = expected.mcp as Record<string, unknown>;
  const exactMcps = Boolean(mcp) && JSON.stringify(canonicalize(mcp)) === JSON.stringify(canonicalize(expectedMcps));
  const expectedPlugins = ["@franlol/opencode-md-table-formatter@0.0.6", "@plannotator/opencode@0.26.0", "@tarquinen/opencode-dcp@3.1.3", "opencode-vibeguard@0.1.0"];
  const canonicalPlugins = Array.isArray(plugins) && plugins.every((plugin) => typeof plugin === "string")
    ? [...plugins].sort()
    : [];
  const pinnedPlugins = JSON.stringify(canonicalPlugins) === JSON.stringify(expectedPlugins);
  return {
    model: equal("model"),
    smallModel: equal("small_model"),
    agents: semanticAgents,
    permissions: equal("permission"),
    mcps: exactMcps,
    canonicalPlugins: new Set(canonicalPlugins).size === canonicalPlugins.length,
    pinnedPlugins,
    noPosthogOrTuple: !mcp?.posthog && !mcp?.tuple,
  };
}
if (import.meta.main) await main();
