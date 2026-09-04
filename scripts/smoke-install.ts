import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

const repositoryRoot = resolve(import.meta.dir, "..");
const commandTimeoutMilliseconds = 180_000;
const probeRequestTimeoutMilliseconds = 2_000;
const tuiResolverTimeoutMilliseconds = 180_000;
const diagnosticCharacterLimit = 65_536;
export const httpBodyByteLimit = 16_384;
export const agentBodyByteLimit = 1_048_576;
const launchAttemptLimit = 3;
const localBinaryDirectory = join(repositoryRoot, "node_modules", ".bin");
export const profileLaunchCommand = "ocx";
export const requiredToolIds = [
  "plan_save",
  "plan_read",
  "delegate",
  "delegation_read",
  "delegation_list",
  "worktree_create",
  "worktree_delete",
] as const;
export const delegationToolIds = [
  "delegate",
  "delegation_read",
  "delegation_list",
] as const;
export const expectedDcpSpec = "@tarquinen/opencode-dcp@3.1.15";
export const globalDcpConflictSpec = "@tarquinen/opencode-dcp@latest";
export const npmPolicyContent = "min-release-age=7\nengine-strict=false\n";
const workcellPlanDescription =
  "Designs implementation-ready plans using delegated repository and external research.";
const workcellPlanPermissionExpectations = Object.freeze({
  delegate: "allow",
  delegation_read: "allow",
  delegation_list: "allow",
  plan_save: "allow",
  plan_read: "allow",
  task: "deny",
} as const);
type SmokeServer = Pick<ReturnType<typeof Bun.serve>, "stop">;

export type SmokeRedactionContext = Readonly<{
  sandboxRoot: string;
  repositoryRoot: string;
  localBinaryDirectory: string;
  exactSecrets: readonly string[];
  temporaryPaths: readonly string[];
}>;

function fail(message: string): never {
  throw new Error(message);
}

function formatCommand(command: string, arguments_: string[]): string {
  return `${command} ${arguments_.join(" ")}`;
}

export function boundSmokeDiagnostics(value: string): string {
  if (value.length <= diagnosticCharacterLimit) return value;
  const retainedCharacterLimit = Math.floor(diagnosticCharacterLimit / 2);
  return `${value.slice(0, retainedCharacterLimit)}\n...[${value.length - diagnosticCharacterLimit} characters omitted]...\n${value.slice(-retainedCharacterLimit)}`;
}

async function captureBoundedStream(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const retainedCharacterLimit = Math.floor(diagnosticCharacterLimit / 2);
  let prefix = "";
  let suffix = "";
  let characterCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    characterCount += text.length;
    if (prefix.length < retainedCharacterLimit) {
      const remaining = retainedCharacterLimit - prefix.length;
      prefix += text.slice(0, remaining);
      suffix = (suffix + text.slice(remaining)).slice(-retainedCharacterLimit);
      continue;
    }
    suffix = (suffix + text).slice(-retainedCharacterLimit);
  }

  const finalText = decoder.decode();
  characterCount += finalText.length;
  suffix = (suffix + finalText).slice(-retainedCharacterLimit);
  if (characterCount <= diagnosticCharacterLimit) return prefix + suffix;
  return `${prefix}\n...[${characterCount - diagnosticCharacterLimit} characters omitted]...\n${suffix}`;
}

async function terminateChild(
  child: ReturnType<typeof Bun.spawn>,
  exited: Promise<number>,
): Promise<number> {
  const alreadyExited = await Promise.race([
    exited.then(() => true),
    Bun.sleep(0).then(() => false),
  ]);
  if (!alreadyExited) signalChildProcessGroup(child, "SIGTERM");

  const gracefulExitCode = await Promise.race([
    exited,
    Bun.sleep(5_000).then(() => undefined),
  ]);
  signalChildProcessGroup(child, "SIGKILL");
  return gracefulExitCode ?? (await exited);
}

function signalChildProcessGroup(
  child: ReturnType<typeof Bun.spawn>,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    )
      return;
    child.kill(signal);
  }
}

async function run(
  command: string,
  arguments_: string[],
  environment: Record<string, string | undefined>,
  workingDirectory: string,
  redactionContext: SmokeRedactionContext,
): Promise<void> {
  const child = Bun.spawn([command, ...arguments_], {
    cwd: workingDirectory,
    detached: true,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = child.exited;
  const stdout = captureBoundedStream(child.stdout);
  const stderr = captureBoundedStream(child.stderr);
  const exitCode = await Promise.race([
    exited,
    Bun.sleep(commandTimeoutMilliseconds).then(() => undefined),
  ]);

  if (exitCode === undefined) {
    await terminateChild(child, exited);
    const diagnostic = redactSmokeDiagnostics(
      `${formatCommand(command, arguments_)} timed out after ${commandTimeoutMilliseconds}ms.\nstdout:\n${await stdout}\nstderr:\n${await stderr}`,
      redactionContext,
    );
    fail(boundSmokeDiagnostics(diagnostic));
  }
  if (exitCode !== 0) {
    const diagnostic = redactSmokeDiagnostics(
      `${formatCommand(command, arguments_)} exited with code ${exitCode}.\nstdout:\n${await stdout}\nstderr:\n${await stderr}`,
      redactionContext,
    );
    fail(boundSmokeDiagnostics(diagnostic));
  }
  await Promise.all([stdout, stderr]);
}

export function isInheritedSmokeVariable(name: string): boolean {
  const normalizedName = name.toUpperCase();
  return (
    normalizedName.startsWith("OCX_") ||
    normalizedName.startsWith("OPENCODE_") ||
    normalizedName.startsWith("NPM_CONFIG_") ||
    normalizedName === "NODE_AUTH_TOKEN" ||
    /^(?:NPM|BUN)(?:_[A-Z0-9]+)*_TOKEN$/.test(normalizedName) ||
    normalizedName === "BUNFIG_TOKEN"
  );
}

export function smokeEnvironment(
  parentEnvironment: NodeJS.ProcessEnv,
  sandbox: string,
): Record<string, string> {
  const path = parentEnvironment.PATH;
  if (!path) fail("Smoke test requires PATH in its parent environment.");

  const environment = Object.fromEntries(
    Object.entries(parentEnvironment).filter(
      ([name, value]) => value !== undefined && !isInheritedSmokeVariable(name),
    ),
  ) as Record<string, string>;
  const home = join(sandbox, "home");
  return {
    ...environment,
    HOME: home,
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_STATE_HOME: join(sandbox, "state"),
    TMPDIR: join(sandbox, "tmp"),
    NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
    PATH: `${localBinaryDirectory}:${path}`,
  };
}

export async function writeSandboxNpmPolicy(sandbox: string): Promise<string> {
  const home = join(sandbox, "home");
  await mkdir(home, { recursive: true });
  const policyPath = join(home, ".npmrc");
  await Bun.write(policyPath, npmPolicyContent);
  return policyPath;
}

export async function seedGlobalTuiConflict(sandbox: string): Promise<string> {
  const globalConfigDirectory = join(sandbox, "config", "opencode");
  await mkdir(globalConfigDirectory, { recursive: true });
  const path = join(globalConfigDirectory, "tui.json");
  await Bun.write(
    path,
    `${JSON.stringify({ plugin: [globalDcpConflictSpec] })}\n`,
  );
  return path;
}

export async function cleanupSmokeSandbox(
  sandbox: string,
  server?: SmokeServer,
): Promise<void> {
  try {
    server?.stop(true);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

function registryFile(
  registryDirectory: string,
  requestUrl: string,
): string | undefined {
  const pathname = decodeURIComponent(new URL(requestUrl).pathname);
  const requestedPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (!requestedPath || requestedPath.split("/").includes(".."))
    return undefined;
  const file = resolve(registryDirectory, requestedPath);
  return relative(registryDirectory, file).startsWith("..") ? undefined : file;
}

async function readVersion(path: string, owner: string): Promise<string> {
  const errors: ParseError[] = [];
  const value = parse(await Bun.file(path).text(), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as { version?: unknown } | undefined;
  if (errors.length > 0) {
    fail(
      `${owner} is invalid JSON/JSONC: ${errors.map(({ error }) => printParseErrorCode(error)).join(", ")}.`,
    );
  }
  if (typeof value?.version !== "string" || !value.version) {
    fail(`${owner} must declare a non-empty version.`);
  }
  return value.version;
}

export async function assertBuiltRegistryVersion(
  registryDirectory: string,
  sourceVersion: string,
): Promise<void> {
  const indexPath = join(registryDirectory, "index.json");
  if (!(await Bun.file(indexPath).exists())) {
    fail(
      `Built registry not found at ${registryDirectory}. Run bun run build first.`,
    );
  }
  const builtVersion = await readVersion(indexPath, "Built registry index");
  if (builtVersion === sourceVersion) return;
  fail(
    `Built registry is stale: source version is ${sourceVersion}, but ${indexPath} is ${builtVersion}. Run bun run build first.`,
  );
}

async function assertRegistryIsCurrent(
  registryDirectory: string,
): Promise<void> {
  const [packageVersion, registryVersion] = await Promise.all([
    readVersion(join(repositoryRoot, "package.json"), "Package manifest"),
    readVersion(join(repositoryRoot, "registry.jsonc"), "Registry source"),
  ]);
  if (packageVersion !== registryVersion) {
    fail(
      `Source versions disagree: package.json is ${packageVersion}, but registry.jsonc is ${registryVersion}.`,
    );
  }
  await assertBuiltRegistryVersion(registryDirectory, registryVersion);
}

function reserveAvailablePort(): number {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reservation.port;
  reservation.stop(true);
  if (port === undefined)
    fail("Unable to reserve a local OpenCode server port.");
  return port;
}

export function profileLaunchArguments(port: number): string[] {
  return [
    "oc",
    "-p",
    "workcell",
    "--",
    "--print-logs",
    "--log-level",
    "DEBUG",
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ];
}

export type ToolProbe = Readonly<{
  status: number | undefined;
  body: string;
  bodyTruncated: boolean;
  wwwAuthenticate: string | null;
  requestError: string | undefined;
}>;

type RequiredToolId = (typeof requiredToolIds)[number];

export type ToolAcceptance = Readonly<{
  acceptedWhileChildLive: boolean;
  toolIds: readonly string[];
  missingToolIds: readonly RequiredToolId[];
  ownershipVerified: boolean;
  planFingerprintVerified: boolean;
  planFingerprintFailureReason: string | undefined;
  childExitCodeAtAcceptance: number | undefined;
}>;

export type InstalledToolsLaunchAttempt = Readonly<
  ToolAcceptance & {
    probe: ToolProbe;
    agentProbe: ToolProbe;
    exitCode: number;
    stdout: string;
    stderr: string;
  }
>;

type InstalledToolsLaunchDependencies = {
  reservePort: () => number;
  launchProbeAndCleanup: (
    port: number,
    environment: Record<string, string>,
    workingDirectory: string,
    credentials: ServerCredentials,
  ) => Promise<InstalledToolsLaunchAttempt>;
};

export type ServerCredentials = {
  username: string;
  password: string;
};

export type ProbeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type PermissionAction = "allow" | "ask" | "deny";

export type PermissionRule = Readonly<{
  permission: string;
  pattern: string;
  action: PermissionAction;
}>;

export type WorkcellPlanFingerprint = Readonly<{
  name: "plan";
  mode: "primary";
  model: "openai/gpt-5.6-sol";
  description: typeof workcellPlanDescription;
  permissions: typeof workcellPlanPermissionExpectations;
}>;

export type AgentEvidence = Readonly<{
  verified: boolean;
  failureReason: string | undefined;
}>;

type OwnedToolProbe = {
  probe: ToolProbe;
  ownershipVerified: boolean;
  retryable: boolean;
};

type BoundedBody = {
  body: string;
  truncated: boolean;
  error: string | undefined;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(body: string, owner: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    fail(`${owner} returned malformed JSON: ${errorMessage(error)}.`);
  }
}

function parsePermissionRules(value: unknown, owner: string): PermissionRule[] {
  if (!Array.isArray(value)) fail(`${owner} permissions must be an array.`);
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object")
      fail(`${owner} permission ${index} must be an object.`);
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.permission !== "string" ||
      typeof record.pattern !== "string" ||
      !["allow", "ask", "deny"].includes(String(record.action))
    )
      fail(`${owner} permission ${index} has an unsupported shape.`);
    return Object.freeze({
      permission: record.permission,
      pattern: record.pattern,
      action: record.action as PermissionAction,
    });
  });
}

function matchesPermissionPattern(pattern: string, value: string): boolean {
  const escapedPattern = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  return new RegExp(`^${escapedPattern.replaceAll("*", ".*")}$`).test(value);
}

export function effectivePermissionAction(
  rules: readonly PermissionRule[],
  permission: string,
  pattern = "*",
): PermissionAction | undefined {
  let action: PermissionAction | undefined;
  for (const rule of rules) {
    if (!matchesPermissionPattern(rule.permission, permission)) continue;
    if (!matchesPermissionPattern(rule.pattern, pattern)) continue;
    action = rule.action;
  }
  return action;
}

export function parseWorkcellPlanFingerprint(
  body: string,
): WorkcellPlanFingerprint {
  const value = parseJson(body, "OpenCode /agent");
  if (!Array.isArray(value)) fail("OpenCode /agent must return an array.");
  const namedPlans = value.filter(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as Record<string, unknown>).name === "plan",
  );
  if (namedPlans.length !== 1)
    fail(
      `OpenCode /agent must return exactly one plan agent; received ${namedPlans.length}.`,
    );

  const plan = namedPlans[0] as Record<string, unknown>;
  const modelRecord = plan.model as Record<string, unknown> | undefined;
  const normalizedModel =
    typeof plan.model === "string"
      ? plan.model
      : modelRecord &&
          typeof modelRecord.providerID === "string" &&
          typeof modelRecord.modelID === "string"
        ? `${modelRecord.providerID}/${modelRecord.modelID}`
        : undefined;
  if (plan.mode !== "primary")
    fail("Workcell plan mode mismatch: expected primary.");
  if (normalizedModel !== "openai/gpt-5.6-sol")
    fail("Workcell plan provider/model mismatch: expected openai/gpt-5.6-sol.");
  if (plan.description !== workcellPlanDescription)
    fail(
      "Workcell plan description mismatch: expected the distinctive Workcell plan description.",
    );

  const rules = parsePermissionRules(plan.permission, "Workcell plan");
  const permissions = Object.fromEntries(
    Object.entries(workcellPlanPermissionExpectations).map(
      ([permission, expectedAction]) => {
        const actualAction = effectivePermissionAction(rules, permission);
        if (actualAction !== expectedAction)
          fail(
            `Workcell plan permission ${permission} resolved to ${actualAction ?? "no match"}; expected ${expectedAction}.`,
          );
        return [permission, actualAction];
      },
    ),
  ) as unknown as typeof workcellPlanPermissionExpectations;

  return Object.freeze({
    name: "plan",
    mode: "primary",
    model: "openai/gpt-5.6-sol",
    description: workcellPlanDescription,
    permissions: Object.freeze(permissions),
  });
}

function awaitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const rejectOnAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectOnAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", rejectOnAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", rejectOnAbort);
        reject(error);
      },
    );
  });
}

export async function readResponseBodyBounded(
  response: Response,
  byteLimit: number,
  signal: AbortSignal,
): Promise<BoundedBody> {
  if (!response.body) return { body: "", truncated: false, error: undefined };

  const reader = response.body.getReader();
  const retainedBytes = new Uint8Array(byteLimit);
  let byteCount = 0;

  const retainedBody = () =>
    new TextDecoder().decode(retainedBytes.subarray(0, byteCount));

  try {
    while (true) {
      const { done, value } = await awaitWithSignal(reader.read(), signal);
      if (done) break;
      if (byteCount + value.byteLength > byteLimit) {
        try {
          await awaitWithSignal(reader.cancel(), signal);
          return {
            body: retainedBody(),
            truncated: true,
            error: undefined,
          };
        } catch (error) {
          return {
            body: retainedBody(),
            truncated: true,
            error: `Response body cancellation failed: ${errorMessage(error)}`,
          };
        }
      }
      retainedBytes.set(value, byteCount);
      byteCount += value.byteLength;
    }
  } catch (error) {
    return {
      body: retainedBody(),
      truncated: false,
      error: `Response body read failed: ${errorMessage(error)}`,
    };
  }

  return {
    body: retainedBody(),
    truncated: false,
    error: undefined,
  };
}

export async function probeToolIds(
  port: number,
  authorization?: string,
  fetcher: ProbeFetch = fetch,
): Promise<ToolProbe> {
  const signal = AbortSignal.timeout(probeRequestTimeoutMilliseconds);
  try {
    const response = await fetcher(
      `http://127.0.0.1:${port}/experimental/tool/ids`,
      {
        headers: authorization ? { Authorization: authorization } : undefined,
        signal,
      },
    );
    const boundedBody = await readResponseBodyBounded(
      response,
      httpBodyByteLimit,
      signal,
    );
    return {
      status: response.status,
      body: boundedBody.body,
      bodyTruncated: boundedBody.truncated,
      wwwAuthenticate: response.headers.get("WWW-Authenticate"),
      requestError: boundedBody.error,
    };
  } catch (error) {
    return {
      status: undefined,
      body: "",
      bodyTruncated: false,
      wwwAuthenticate: null,
      requestError: errorMessage(error),
    };
  }
}

export async function probeAgents(
  port: number,
  authorization: string,
  fetcher: ProbeFetch = fetch,
): Promise<ToolProbe> {
  const signal = AbortSignal.timeout(probeRequestTimeoutMilliseconds);
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/agent`, {
      headers: { Authorization: authorization },
      signal,
    });
    const boundedBody = await readResponseBodyBounded(
      response,
      agentBodyByteLimit,
      signal,
    );
    return {
      status: response.status,
      body: boundedBody.body,
      bodyTruncated: boundedBody.truncated,
      wwwAuthenticate: response.headers.get("WWW-Authenticate"),
      requestError: boundedBody.error,
    };
  } catch (error) {
    return {
      status: undefined,
      body: "",
      bodyTruncated: false,
      wwwAuthenticate: null,
      requestError: errorMessage(error),
    };
  }
}

function basicAuthorization(credentials: ServerCredentials): string {
  const encodedCredentials = Buffer.from(
    `${credentials.username}:${credentials.password}`,
  ).toString("base64");
  return `Basic ${encodedCredentials}`;
}

export function isPinnedOpenCodeChallenge(header: string | null): boolean {
  if (!header) return false;
  const challenge =
    /^\s*([A-Za-z]+)[\t ]+([A-Za-z]+)[\t ]*=[\t ]*"([^"]*)"[\t ]*$/.exec(
      header,
    );
  if (!challenge) return false;
  const [, scheme, parameter, realm] = challenge;
  return (
    scheme.toLowerCase() === "basic" &&
    parameter.toLowerCase() === "realm" &&
    realm === "Secure Area"
  );
}

export async function probeToolIdsHandshake(
  port: number,
  credentials: ServerCredentials,
  fetcher: ProbeFetch = fetch,
): Promise<OwnedToolProbe> {
  const unauthenticatedProbe = await probeToolIds(port, undefined, fetcher);
  if (unauthenticatedProbe.status === undefined) {
    return {
      probe: unauthenticatedProbe,
      ownershipVerified: false,
      retryable: true,
    };
  }
  if (
    unauthenticatedProbe.status !== 401 ||
    unauthenticatedProbe.bodyTruncated ||
    unauthenticatedProbe.requestError !== undefined ||
    !isPinnedOpenCodeChallenge(unauthenticatedProbe.wwwAuthenticate)
  ) {
    return {
      probe: unauthenticatedProbe,
      ownershipVerified: false,
      retryable: false,
    };
  }

  const authenticatedProbe = await probeToolIds(
    port,
    basicAuthorization(credentials),
    fetcher,
  );
  const ownershipVerified =
    authenticatedProbe.status === 200 &&
    !authenticatedProbe.bodyTruncated &&
    authenticatedProbe.requestError === undefined;
  return {
    probe: authenticatedProbe,
    ownershipVerified,
    retryable: authenticatedProbe.status === undefined,
  };
}

async function waitForToolIds(
  port: number,
  childExitCode: () => number | undefined,
  credentials: ServerCredentials,
): Promise<OwnedToolProbe> {
  const deadline = Date.now() + commandTimeoutMilliseconds;
  let lastProbe: ToolProbe = {
    status: undefined,
    body: "",
    bodyTruncated: false,
    wwwAuthenticate: null,
    requestError: "Server did not accept a connection.",
  };

  while (Date.now() < deadline) {
    if (childExitCode() !== undefined)
      return { probe: lastProbe, ownershipVerified: false, retryable: false };
    const handshake = await probeToolIdsHandshake(port, credentials);
    lastProbe = handshake.probe;
    if (handshake.ownershipVerified) return handshake;
    if (!handshake.retryable) return handshake;
    await Bun.sleep(250);
  }
  return { probe: lastProbe, ownershipVerified: false, retryable: false };
}

export function parseToolIds(probe: ToolProbe): string[] {
  if (
    probe.status !== 200 ||
    probe.bodyTruncated ||
    probe.requestError !== undefined
  )
    return [];
  try {
    const value: unknown = JSON.parse(probe.body);
    if (
      Array.isArray(value) &&
      value.every((toolId) => typeof toolId === "string")
    ) {
      return value;
    }
  } catch {
    return [];
  }
  return [];
}

export function establishToolAcceptanceAtLivenessBoundary(
  probe: ToolProbe,
  ownershipVerified: boolean,
  childExitCode: () => number | undefined,
  agentEvidence: AgentEvidence,
): ToolAcceptance {
  const toolIds = Object.freeze(parseToolIds(probe));
  const missingToolIds = Object.freeze(
    requiredToolIds.filter((toolId) => !toolIds.includes(toolId)),
  );
  const childExitCodeAtAcceptance = childExitCode();
  const acceptedWhileChildLive =
    childExitCodeAtAcceptance === undefined &&
    ownershipVerified &&
    agentEvidence.verified &&
    probe.status === 200 &&
    missingToolIds.length === 0;

  return Object.freeze({
    acceptedWhileChildLive,
    toolIds,
    missingToolIds,
    ownershipVerified,
    planFingerprintVerified: agentEvidence.verified,
    planFingerprintFailureReason: agentEvidence.failureReason,
    childExitCodeAtAcceptance,
  });
}

function launchFailureDiagnostics(
  launchNumber: number,
  attemptNumber: number,
  attempt: InstalledToolsLaunchAttempt,
): string {
  return [
    `Installed Workcell launch ${launchNumber} did not register every required tool.`,
    `Launch attempt: ${attemptNumber} of ${launchAttemptLimit}`,
    `Endpoint ownership verified: ${attempt.ownershipVerified}`,
    `Workcell plan fingerprint verified: ${attempt.planFingerprintVerified}`,
    `Accepted while child live: ${attempt.acceptedWhileChildLive}`,
    `Child exit code at acceptance: ${attempt.childExitCodeAtAcceptance ?? "live"}`,
    `HTTP status: ${attempt.probe.status ?? "unavailable"}`,
    `HTTP body truncated: ${attempt.probe.bodyTruncated}`,
    `WWW-Authenticate: ${attempt.probe.wwwAuthenticate ?? "<missing>"}`,
    `HTTP body: ${attempt.probe.body || "<empty>"}`,
    `HTTP error: ${attempt.probe.requestError ?? "<none>"}`,
    `Agent HTTP status: ${attempt.agentProbe.status ?? "unavailable"}`,
    `Agent response exceeded dedicated ${agentBodyByteLimit}-byte bound: ${attempt.agentProbe.bodyTruncated}`,
    `Agent fingerprint error: ${attempt.planFingerprintFailureReason ?? "<none>"}`,
    ...(attempt.planFingerprintFailureReason
      ? []
      : [`Agent HTTP body: ${attempt.agentProbe.body || "<empty>"}`]),
    `Agent HTTP error: ${attempt.agentProbe.requestError ?? "<none>"}`,
    `Child exit code after cleanup: ${attempt.exitCode}`,
    `stdout:\n${attempt.stdout || "<empty>"}`,
    `stderr/debug logs:\n${attempt.stderr || "<empty>"}`,
  ].join("\n");
}

async function launchProbeAndCleanup(
  port: number,
  environment: Record<string, string>,
  workingDirectory: string,
  credentials: ServerCredentials,
): Promise<InstalledToolsLaunchAttempt> {
  const arguments_ = profileLaunchArguments(port);
  const command = join(localBinaryDirectory, profileLaunchCommand);
  const child = Bun.spawn([command, ...arguments_], {
    cwd: workingDirectory,
    detached: true,
    env: {
      ...environment,
      OPENCODE_SERVER_USERNAME: credentials.username,
      OPENCODE_SERVER_PASSWORD: credentials.password,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let observedExitCode: number | undefined;
  const exited = child.exited.then((exitCode) => {
    observedExitCode = exitCode;
    return exitCode;
  });
  const stdoutPromise = captureBoundedStream(child.stdout);
  const stderrPromise = captureBoundedStream(child.stderr);
  let probe: ToolProbe | undefined;
  let agentProbe: ToolProbe | undefined;
  let acceptance: ToolAcceptance | undefined;
  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    const ownedProbe = await waitForToolIds(
      port,
      () => observedExitCode,
      credentials,
    );
    probe = ownedProbe.probe;
    agentProbe = await probeAgents(port, basicAuthorization(credentials));
    const agentEvidence: AgentEvidence = (() => {
      if (
        agentProbe.status !== 200 ||
        agentProbe.bodyTruncated ||
        agentProbe.requestError !== undefined
      )
        return {
          verified: false,
          failureReason: agentProbe.bodyTruncated
            ? `OpenCode /agent response exceeded the dedicated ${agentBodyByteLimit}-byte bound.`
            : `OpenCode /agent probe was unavailable or unsuccessful (status ${agentProbe.status ?? "unavailable"}).`,
        };
      try {
        parseWorkcellPlanFingerprint(agentProbe.body);
        return { verified: true, failureReason: undefined };
      } catch (error) {
        return {
          verified: false,
          failureReason: boundSmokeDiagnostics(errorMessage(error)),
        };
      }
    })();
    await Bun.sleep(100);
    acceptance = establishToolAcceptanceAtLivenessBoundary(
      probe,
      ownedProbe.ownershipVerified,
      () => observedExitCode,
      agentEvidence,
    );
  } finally {
    exitCode = await terminateChild(child, exited);
    [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  }
  if (!probe) fail("OpenCode tool probe ended without a result.");
  if (!agentProbe) fail("OpenCode agent probe ended without a result.");
  if (!acceptance) fail("OpenCode tool acceptance ended without a verdict.");
  return Object.freeze({
    probe: Object.freeze({ ...probe }),
    agentProbe: Object.freeze({ ...agentProbe }),
    ...acceptance,
    exitCode,
    stdout,
    stderr,
  });
}

const installedToolsLaunchDependencies: InstalledToolsLaunchDependencies = {
  reservePort: reserveAvailablePort,
  launchProbeAndCleanup,
};

function isRetryableAddressCollision(
  attempt: InstalledToolsLaunchAttempt,
  port: number,
): boolean {
  if (attempt.childExitCodeAtAcceptance === undefined) return false;
  const escapedAddress = `127\\.0\\.0\\.1:${port}`;
  return new RegExp(
    `\\blisten\\s+EADDRINUSE\\b[^\\r\\n]*\\b${escapedAddress}\\b`,
    "i",
  ).test(`${attempt.stdout}\n${attempt.stderr}`);
}

export async function assertInstalledTools(
  launchNumber: number,
  environment: Record<string, string>,
  workingDirectory: string,
  dependencies: InstalledToolsLaunchDependencies = installedToolsLaunchDependencies,
): Promise<void> {
  for (
    let attemptNumber = 1;
    attemptNumber <= launchAttemptLimit;
    attemptNumber++
  ) {
    const port = dependencies.reservePort();
    const credentials = {
      username: `workcell-smoke-${crypto.randomUUID()}`,
      password: crypto.randomUUID(),
    };
    const redactionContext = createSmokeRedactionContext(
      resolve(workingDirectory, ".."),
      credentials,
      environment,
      [workingDirectory],
    );
    let attempt: InstalledToolsLaunchAttempt;
    try {
      attempt = await dependencies.launchProbeAndCleanup(
        port,
        environment,
        workingDirectory,
        credentials,
      );
    } catch (error) {
      fail(
        boundSmokeDiagnostics(
          redactSmokeDiagnostics(errorMessage(error), redactionContext),
        ),
      );
    }
    if (attempt.acceptedWhileChildLive) {
      console.log(
        `✓ Installed Workcell launch ${launchNumber} registered: ${requiredToolIds.join(", ")}`,
      );
      return;
    }

    if (
      isRetryableAddressCollision(attempt, port) &&
      attemptNumber < launchAttemptLimit
    ) {
      continue;
    }

    fail(
      boundSmokeDiagnostics(
        redactSmokeDiagnostics(
          `${launchFailureDiagnostics(launchNumber, attemptNumber, attempt)}\nMissing required tool IDs: ${attempt.missingToolIds.join(", ") || "unable to parse response"}\nDelegation tool group: ${delegationToolIds.map((toolId) => `${toolId}=${attempt.toolIds.includes(toolId) ? "loaded" : "missing"}`).join(", ")}`,
          redactionContext,
        ),
      ),
    );
  }
}

function parseJsoncDocument(content: string, owner: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0)
    fail(
      `${owner} is invalid JSON/JSONC: ${errors.map(({ error }) => printParseErrorCode(error)).join(", ")}.`,
    );
  return value;
}

function requireStringArray(value: unknown, owner: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    fail(`${owner} must be an array of strings.`);
  return value;
}

export async function assertInstalledProfileContracts(
  installedProfileDirectory: string,
): Promise<void> {
  const tuiPath = join(installedProfileDirectory, "tui.jsonc");
  const tui = parseJsoncDocument(
    await Bun.file(tuiPath).text(),
    "Installed Workcell TUI config",
  ) as Record<string, unknown>;
  const plugins = requireStringArray(
    tui?.plugin,
    "Installed Workcell TUI plugins",
  );
  if (plugins.length !== 1 || plugins[0] !== expectedDcpSpec)
    fail(`Installed Workcell TUI must contain only ${expectedDcpSpec}.`);

  const manifestPath = join(installedProfileDirectory, "package.json");
  const manifest = parseJson(
    await Bun.file(manifestPath).text(),
    "Installed Workcell package manifest",
  ) as Record<string, unknown>;
  const dependencies = manifest.dependencies;
  if (
    !dependencies ||
    typeof dependencies !== "object" ||
    Array.isArray(dependencies)
  )
    fail("Installed Workcell package manifest must contain dependencies.");
  const pluginVersion = (dependencies as Record<string, unknown>)[
    "@opencode-ai/plugin"
  ];
  if (pluginVersion !== "1.18.25")
    fail(
      `Installed Workcell package manifest resolved @opencode-ai/plugin to ${String(pluginVersion)}; expected 1.18.25.`,
    );
  if ("@opencode-ai/sdk" in dependencies)
    fail(
      "Installed Workcell package manifest must not declare @opencode-ai/sdk.",
    );
}

function isSecretEnvironmentVariable(name: string): boolean {
  return (
    /(?:PASSWORD|USERNAME|TOKEN|AUTH)/i.test(name) &&
    /^(?:OPENCODE|NPM|BUN|NODE|npm_config_)/i.test(name)
  );
}

export function createSmokeRedactionContext(
  sandboxRoot: string,
  credentials?: ServerCredentials,
  environment: Record<string, string | undefined> = {},
  temporaryPaths: readonly string[] = [],
): SmokeRedactionContext {
  const credentialSecrets = credentials
    ? [
        credentials.username,
        credentials.password,
        `${credentials.username}:${credentials.password}`,
        Buffer.from(`${credentials.username}:${credentials.password}`).toString(
          "base64",
        ),
        basicAuthorization(credentials),
      ]
    : [];
  const environmentSecrets = Object.entries(environment)
    .filter(([name, value]) => value && isSecretEnvironmentVariable(name))
    .map(([, value]) => value as string);
  return Object.freeze({
    sandboxRoot,
    repositoryRoot,
    localBinaryDirectory,
    exactSecrets: Object.freeze(
      [...new Set([...credentialSecrets, ...environmentSecrets])]
        .filter(Boolean)
        .sort((left, right) => right.length - left.length),
    ),
    temporaryPaths: Object.freeze(
      [...new Set([sandboxRoot, ...temporaryPaths])]
        .filter(Boolean)
        .sort((left, right) => right.length - left.length),
    ),
  });
}

export function redactSmokeDiagnostics(
  value: string,
  context: SmokeRedactionContext,
): string {
  let redacted = value;
  for (const secret of context.exactSecrets) {
    redacted = redacted.replaceAll(secret, "<redacted>");
  }
  for (const path of context.temporaryPaths) {
    redacted = redacted.replaceAll(path, "<temporary-path>");
  }
  redacted = redacted
    .replaceAll(context.localBinaryDirectory, "<repository-binary-path>")
    .replaceAll(context.repositoryRoot, "<repository-path>");
  redacted = redacted
    .replace(/Authorization:\s*Basic\s+\S+/gi, "Authorization: <redacted>")
    .replace(/Basic\s+[A-Za-z0-9+/=]{12,}/g, "Basic <redacted>")
    .replace(
      /((?:(?:\/\/[^:\s]+\/)?(?:npm|bun|node)?[_-]?(?:auth[_-]?)?token\s*[=:]\s*)[^\s"']+)/gi,
      "$1<redacted>",
    )
    .replace(
      /((?:OPENCODE_SERVER_(?:USERNAME|PASSWORD))\s*[=:]\s*)\S+/gi,
      "$1<redacted>",
    )
    .replace(
      /\/(?:private\/)?var\/folders\/[^\s"',]+\/T\/ocx-oc-merged-[^\s"',/]+/g,
      "<merged-config-path>",
    );
  return redacted;
}

export type DcpMetadataReceipt = Readonly<{
  spec: typeof expectedDcpSpec;
  requested: "3.1.15";
  version: "3.1.15";
  source: "npm";
  target: string;
  firstTime: number;
}>;

function isExactDcpPackageTarget(target: string): boolean {
  if (!isAbsolute(target) || normalize(target) !== target) return false;
  const targetSegments = target.split(sep).filter(Boolean);
  const expectedSegments = ["node_modules", "@tarquinen", "opencode-dcp"];
  return expectedSegments.every(
    (segment, index) =>
      targetSegments.at(index - expectedSegments.length) === segment,
  );
}

function parseMetadataRecords(content: string): unknown[] {
  const trimmed = content.trim();
  if (!trimmed) fail("OpenCode plugin metadata file is empty.");
  try {
    const document: unknown = JSON.parse(trimmed);
    return Array.isArray(document) ? document : [document];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .map((line, index) =>
        parseJson(line, `OpenCode plugin metadata line ${index + 1}`),
      );
  }
}

function hasIncompleteTrailingJsonl(content: string): boolean {
  if (!content.trim() || /\r?\n$/.test(content)) return false;
  try {
    JSON.parse(content);
    return false;
  } catch {
    // A complete JSONL document is not valid as one JSON value; inspect its tail.
  }
  const trailingLine = content.split(/\r?\n/).at(-1) ?? "";
  try {
    JSON.parse(trailingLine);
    return false;
  } catch {
    return true;
  }
}

export function parseDcpMetadataReceipt(
  content: string,
  notBeforeMilliseconds = 0,
): DcpMetadataReceipt {
  const documents = parseMetadataRecords(content);
  const records = documents.flatMap((document) => {
    if (!document || typeof document !== "object" || Array.isArray(document))
      return [document];
    const values = Object.values(document);
    return values.some((value) => value !== null && typeof value === "object")
      ? values
      : [document];
  });
  const dcpRecords = records.filter(
    (record) =>
      record !== null &&
      typeof record === "object" &&
      (record as Record<string, unknown>).id === "opencode-dcp",
  );
  if (dcpRecords.length !== 1)
    fail(
      `OpenCode plugin metadata must contain exactly one DCP record; received ${dcpRecords.length}.`,
    );
  const record = dcpRecords[0] as Record<string, unknown>;
  if (record.spec !== expectedDcpSpec)
    fail(`OpenCode DCP metadata spec must equal ${expectedDcpSpec}.`);
  if (record.requested !== "3.1.15")
    fail("OpenCode DCP metadata requested version must equal 3.1.15.");
  if (record.version !== "3.1.15")
    fail("OpenCode DCP metadata resolved version must equal 3.1.15.");
  if (record.source !== "npm")
    fail("OpenCode DCP metadata source must equal npm.");
  if (typeof record.target !== "string")
    fail("OpenCode DCP metadata target must be a string.");
  if (
    typeof record.first_time !== "number" ||
    !Number.isFinite(record.first_time)
  )
    fail("OpenCode DCP metadata first_time must be a finite number.");
  if (record.first_time < notBeforeMilliseconds)
    fail("OpenCode DCP metadata record is stale.");
  if (!isExactDcpPackageTarget(record.target))
    fail(
      "OpenCode DCP metadata target must be a canonical path ending in node_modules/@tarquinen/opencode-dcp.",
    );
  return Object.freeze({
    spec: expectedDcpSpec,
    requested: "3.1.15",
    version: "3.1.15",
    source: "npm",
    target: record.target,
    firstTime: record.first_time,
  });
}

function normalizeJsoncContent(content: string, owner: string): string {
  return JSON.stringify(parseJsoncDocument(content, owner));
}

export function classifyTuiResolverFailure(
  timedOut: boolean,
  exitCode: number | undefined,
  metadataExists: boolean,
): "timeout" | "early-exit" | "missing-metadata" | undefined {
  if (timedOut) return "timeout";
  if (exitCode !== undefined && !metadataExists) return "early-exit";
  if (!metadataExists) return "missing-metadata";
  return undefined;
}

export type MetadataPollingDependencies = Readonly<{
  readMetadata: () => Promise<string | undefined>;
  childExitCode: () => number | undefined;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}>;

export async function waitForFreshDcpMetadata(
  launchedAt: number,
  timeoutMilliseconds: number,
  dependencies: MetadataPollingDependencies,
): Promise<DcpMetadataReceipt> {
  const deadline = dependencies.now() + timeoutMilliseconds;
  let lastParseDiagnostic = "metadata file has not been created";

  while (dependencies.now() < deadline) {
    const content = await dependencies.readMetadata();
    let receipt: DcpMetadataReceipt | undefined;
    if (content !== undefined) {
      if (hasIncompleteTrailingJsonl(content)) {
        lastParseDiagnostic = `metadata has an incomplete trailing JSONL record. Retained metadata: ${boundSmokeDiagnostics(content)}`;
      } else {
        try {
          receipt = parseDcpMetadataReceipt(content, launchedAt);
          lastParseDiagnostic = "metadata was parsed but not accepted";
        } catch (error) {
          lastParseDiagnostic = boundSmokeDiagnostics(errorMessage(error));
        }
      }
    }

    const exitCodeAtAcceptance = dependencies.childExitCode();
    if (receipt && exitCodeAtAcceptance === undefined) return receipt;
    if (exitCodeAtAcceptance !== undefined) {
      fail(
        `OpenCode TUI resolver exited with code ${exitCodeAtAcceptance} before metadata acceptance: ${lastParseDiagnostic}.`,
      );
    }
    await dependencies.sleep(100);
  }

  fail(
    `OpenCode TUI resolver timed out before metadata acceptance: ${lastParseDiagnostic}.`,
  );
}

export type TuiProcessCleanupControl = Readonly<{
  writeInterrupt: () => void;
  closeTerminal: () => void;
  isGroupAlive: () => boolean;
  signalGroup: (signal: "SIGTERM" | "SIGKILL") => void;
  exited: Promise<number>;
  sleep: (milliseconds: number) => Promise<void>;
}>;

export async function cleanupTuiProcess(
  control: TuiProcessCleanupControl,
  graceMilliseconds = 5_000,
): Promise<number> {
  const cleanupErrors: string[] = [];
  let exitCode: number | undefined;
  try {
    try {
      control.writeInterrupt();
    } catch (error) {
      cleanupErrors.push(`Ctrl-C write failed: ${errorMessage(error)}`);
    }
    await Promise.race([control.exited, control.sleep(graceMilliseconds)]);

    if (control.isGroupAlive()) {
      try {
        control.signalGroup("SIGTERM");
      } catch (error) {
        cleanupErrors.push(`TERM failed: ${errorMessage(error)}`);
      }
      await control.sleep(graceMilliseconds);
    }
    if (control.isGroupAlive()) {
      try {
        control.signalGroup("SIGKILL");
      } catch (error) {
        cleanupErrors.push(`KILL failed: ${errorMessage(error)}`);
      }
      await control.sleep(graceMilliseconds);
    }
    if (control.isGroupAlive()) {
      cleanupErrors.push(
        "detached process group survived Ctrl-C, TERM, and KILL",
      );
    }
    exitCode = await Promise.race([
      control.exited,
      control.sleep(graceMilliseconds).then(() => undefined),
    ]);
    if (exitCode === undefined) cleanupErrors.push("child leader did not exit");
  } finally {
    try {
      control.closeTerminal();
    } catch (error) {
      cleanupErrors.push(`terminal close failed: ${errorMessage(error)}`);
    }
  }
  if (cleanupErrors.length > 0)
    fail(`OpenCode TUI cleanup failed: ${cleanupErrors.join("; ")}.`);
  return exitCode as number;
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    )
      return false;
    throw error;
  }
}

async function mergedConfigDirectories(isolatedTmpDirectory: string) {
  const entries = await readdir(isolatedTmpDirectory, { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("ocx-oc-merged-"),
    )
    .map((entry) => join(isolatedTmpDirectory, entry.name));
}

export function requireExactlyOneMergedConfigDirectory(
  candidates: readonly string[],
  phase: "before-launch" | "acceptance",
): string | undefined {
  if (phase === "before-launch") {
    if (candidates.length === 0) return undefined;
    fail(
      `Isolated TMPDIR must not contain preexisting merged config directories; received ${candidates.length}.`,
    );
  }
  if (candidates.length !== 1)
    fail(
      `OpenCode TUI resolver must create exactly one live merged config directory in isolated TMPDIR; received ${candidates.length}.`,
    );
  return candidates[0];
}

export function validateGlobalTuiConflict(content: string): void {
  const config = parseJsoncDocument(content, "Sandbox global TUI fixture") as
    | Record<string, unknown>
    | undefined;
  const plugins = requireStringArray(
    config?.plugin,
    "Sandbox global TUI fixture plugins",
  );
  if (plugins.length !== 1 || plugins[0] !== globalDcpConflictSpec)
    fail(
      `Sandbox global TUI fixture must contain only ${globalDcpConflictSpec}.`,
    );
}

export async function readGlobalTuiConflictImmediatelyBeforeLaunch(
  globalTuiFixturePath: string,
): Promise<void> {
  if (!(await Bun.file(globalTuiFixturePath).exists()))
    fail("Sandbox global TUI fixture is missing immediately before launch.");
  validateGlobalTuiConflict(await Bun.file(globalTuiFixturePath).text());
}

export async function assertProfileOwnedTuiResolution(
  environment: Record<string, string>,
  workingDirectory: string,
  installedProfileDirectory: string,
  metadataPath: string,
  globalTuiFixturePath: string,
): Promise<void> {
  if (await Bun.file(metadataPath).exists())
    fail("OpenCode TUI metadata path must be fresh before launch.");

  const isolatedTmpDirectory = environment.TMPDIR;
  if (!isolatedTmpDirectory)
    fail("OpenCode TUI resolver requires an isolated TMPDIR.");
  await mkdir(isolatedTmpDirectory, { recursive: true });
  const preexistingMergedDirectories =
    await mergedConfigDirectories(isolatedTmpDirectory);
  requireExactlyOneMergedConfigDirectory(
    preexistingMergedDirectories,
    "before-launch",
  );

  await readGlobalTuiConflictImmediatelyBeforeLaunch(globalTuiFixturePath);

  const launchedAt = Date.now();
  let terminalOutput = "";
  const command = join(localBinaryDirectory, profileLaunchCommand);
  const child = Bun.spawn([command, "oc", "-p", "workcell"], {
    cwd: workingDirectory,
    detached: true,
    env: {
      ...environment,
      TMPDIR: isolatedTmpDirectory,
      OPENCODE_PLUGIN_META_FILE: metadataPath,
    },
    terminal: {
      cols: 120,
      rows: 40,
      data: (_terminal, data) => {
        terminalOutput = (
          terminalOutput + new TextDecoder().decode(data)
        ).slice(-diagnosticCharacterLimit);
      },
    },
  });
  let observedExitCode: number | undefined;
  const exited = child.exited.then((exitCode) => {
    observedExitCode = exitCode;
    return exitCode;
  });
  const redactionContext = createSmokeRedactionContext(
    resolve(workingDirectory, ".."),
    undefined,
    environment,
    [workingDirectory, installedProfileDirectory, metadataPath],
  );
  let acceptanceError: unknown;

  try {
    await waitForFreshDcpMetadata(launchedAt, tuiResolverTimeoutMilliseconds, {
      readMetadata: async () =>
        (await Bun.file(metadataPath).exists())
          ? Bun.file(metadataPath).text()
          : undefined,
      childExitCode: () => observedExitCode,
      now: Date.now,
      sleep: Bun.sleep,
    });
    const resolverErrors = terminalOutput
      .split(/\r?\n/)
      .filter(
        (line) =>
          /opencode-dcp/i.test(line) &&
          /(?:error|failed|unable|not found|install|entry)/i.test(line),
      );
    if (resolverErrors.length > 0)
      fail(
        `OpenCode reported a DCP resolver diagnostic before metadata acceptance:\n${resolverErrors.join("\n")}`,
      );

    const liveMergedDirectories =
      await mergedConfigDirectories(isolatedTmpDirectory);
    const liveMergedDirectory = requireExactlyOneMergedConfigDirectory(
      liveMergedDirectories,
      "acceptance",
    );
    if (!liveMergedDirectory)
      fail("OpenCode TUI resolver did not expose a merged config directory.");
    const mergedTuiPath = join(liveMergedDirectory, "tui.jsonc");
    if (!(await Bun.file(mergedTuiPath).exists()))
      fail(
        "Active OpenCode merged config directory does not contain tui.jsonc.",
      );

    const [sourceContent, installedContent] = await Promise.all([
      Bun.file(mergedTuiPath).text(),
      Bun.file(join(installedProfileDirectory, "tui.jsonc")).text(),
    ]);
    const sourceDigest = createHash("sha256")
      .update(normalizeJsoncContent(sourceContent, "Merged TUI source"))
      .digest("hex");
    const installedDigest = createHash("sha256")
      .update(normalizeJsoncContent(installedContent, "Installed Workcell TUI"))
      .digest("hex");
    if (sourceDigest !== installedDigest)
      fail(
        "Isolated TMPDIR merged TUI source does not match installed Workcell tui.jsonc; the receipt proves the selected npm spec, while isolated TMPDIR proves profile source.",
      );
    if (observedExitCode !== undefined)
      fail(
        `OpenCode TUI child exited with code ${observedExitCode} at the exact profile-source acceptance boundary.`,
      );
  } catch (error) {
    acceptanceError = error;
  } finally {
    try {
      await cleanupTuiProcess({
        writeInterrupt: () => child.terminal?.write("\x03"),
        closeTerminal: () => child.terminal?.close(),
        isGroupAlive: () => isProcessGroupAlive(child.pid),
        signalGroup: (signal) => signalChildProcessGroup(child, signal),
        exited,
        sleep: Bun.sleep,
      });
    } catch (cleanupError) {
      const combined = acceptanceError
        ? `${errorMessage(acceptanceError)} Cleanup error: ${errorMessage(cleanupError)}`
        : errorMessage(cleanupError);
      fail(
        boundSmokeDiagnostics(
          redactSmokeDiagnostics(combined, redactionContext),
        ),
      );
    }
  }
  if (acceptanceError)
    fail(
      boundSmokeDiagnostics(
        redactSmokeDiagnostics(errorMessage(acceptanceError), redactionContext),
      ),
    );
}

async function main(): Promise<void> {
  const registryDirectory = resolve(
    process.env.REGISTRY_DIST ?? join(repositoryRoot, "dist"),
  );
  await assertRegistryIsCurrent(registryDirectory);

  const sandbox = await mkdtemp(join(tmpdir(), "ocx-registry-smoke-"));
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    const home = join(sandbox, "home");
    const npmPolicyPath = await writeSandboxNpmPolicy(sandbox);
    const globalTuiFixturePath = await seedGlobalTuiConflict(sandbox);
    if (await Bun.file(join(repositoryRoot, ".npmrc")).exists())
      fail("Smoke setup must not introduce a repository .npmrc.");
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const file = registryFile(registryDirectory, request.url);
        if (!file || !(await Bun.file(file).exists()))
          return new Response("Not found", { status: 404 });
        if (
          file.endsWith(
            join("components", "workcell", "profiles", "workcell", "ocx.jsonc"),
          )
        ) {
          if (!server)
            return new Response("Smoke registry is not ready", { status: 503 });
          const canonicalProfile = await Bun.file(file).text();
          return new Response(
            canonicalProfile.replace(
              "https://matthewmorek.github.io/ocx-profile-workcell",
              server.url.toString(),
            ),
          );
        }
        return new Response(Bun.file(file));
      },
    });
    const environment = smokeEnvironment(process.env, sandbox);
    await mkdir(environment.TMPDIR, { recursive: true });
    const redactionContext = createSmokeRedactionContext(
      sandbox,
      undefined,
      environment,
      [home],
    );
    if (environment.NPM_CONFIG_USERCONFIG !== npmPolicyPath)
      fail("Smoke environment did not select the sandbox npm policy.");
    const ocx = join(localBinaryDirectory, profileLaunchCommand);
    await run(ocx, ["init", "--global"], environment, home, redactionContext);
    await run(
      ocx,
      [
        "profile",
        "add",
        "workcell",
        "--source",
        "matthewmorek/workcell",
        "--from",
        server.url.toString(),
        "--global",
      ],
      environment,
      home,
      redactionContext,
    );
    await run(
      ocx,
      ["verify"],
      environment,
      join(sandbox, "config", "opencode", "profiles", "workcell"),
      redactionContext,
    );
    const installedProfileDirectory = join(
      sandbox,
      "config",
      "opencode",
      "profiles",
      "workcell",
    );
    await assertInstalledProfileContracts(installedProfileDirectory);
    await assertInstalledTools(1, environment, home);
    await assertInstalledTools(2, environment, home);
    await assertProfileOwnedTuiResolution(
      environment,
      home,
      installedProfileDirectory,
      join(sandbox, "dcp-plugin-metadata.jsonl"),
      globalTuiFixturePath,
    );
    console.log(
      `✓ Production TUI metadata selected ${expectedDcpSpec}; active merged tui.jsonc matched the installed Workcell profile`,
    );
  } finally {
    await cleanupSmokeSandbox(sandbox, server);
  }
}

if (import.meta.main) await main();
