import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

const repositoryRoot = resolve(import.meta.dir, "..");
const commandTimeoutMilliseconds = 180_000;
const probeRequestTimeoutMilliseconds = 2_000;
const diagnosticCharacterLimit = 65_536;
export const httpBodyByteLimit = 16_384;
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
type SmokeServer = Pick<ReturnType<typeof Bun.serve>, "stop">;

function fail(message: string): never {
  throw new Error(message);
}

function formatCommand(command: string, arguments_: string[]): string {
  return `${command} ${arguments_.join(" ")}`;
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
    fail(
      `${formatCommand(command, arguments_)} timed out after ${commandTimeoutMilliseconds}ms.\nstdout:\n${await stdout}\nstderr:\n${await stderr}`,
    );
  }
  if (exitCode !== 0) {
    fail(
      `${formatCommand(command, arguments_)} exited with code ${exitCode}.\nstdout:\n${await stdout}\nstderr:\n${await stderr}`,
    );
  }
  await Promise.all([stdout, stderr]);
}

function isLaunchOverride(name: string): boolean {
  return name.startsWith("OCX_") || name.startsWith("OPENCODE_");
}

export function smokeEnvironment(
  parentEnvironment: NodeJS.ProcessEnv,
  sandbox: string,
): Record<string, string> {
  const path = parentEnvironment.PATH;
  if (!path) fail("Smoke test requires PATH in its parent environment.");

  const environment = Object.fromEntries(
    Object.entries(parentEnvironment).filter(
      ([name, value]) => value !== undefined && !isLaunchOverride(name),
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
    PATH: `${localBinaryDirectory}:${path}`,
  };
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
  childExitCodeAtAcceptance: number | undefined;
}>;

export type InstalledToolsLaunchAttempt = Readonly<
  ToolAcceptance & {
    probe: ToolProbe;
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

  const encodedCredentials = Buffer.from(
    `${credentials.username}:${credentials.password}`,
  ).toString("base64");
  const authenticatedProbe = await probeToolIds(
    port,
    `Basic ${encodedCredentials}`,
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
): ToolAcceptance {
  const toolIds = Object.freeze(parseToolIds(probe));
  const missingToolIds = Object.freeze(
    requiredToolIds.filter((toolId) => !toolIds.includes(toolId)),
  );
  const childExitCodeAtAcceptance = childExitCode();
  const acceptedWhileChildLive =
    childExitCodeAtAcceptance === undefined &&
    ownershipVerified &&
    probe.status === 200 &&
    missingToolIds.length === 0;

  return Object.freeze({
    acceptedWhileChildLive,
    toolIds,
    missingToolIds,
    ownershipVerified,
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
    `Accepted while child live: ${attempt.acceptedWhileChildLive}`,
    `Child exit code at acceptance: ${attempt.childExitCodeAtAcceptance ?? "live"}`,
    `HTTP status: ${attempt.probe.status ?? "unavailable"}`,
    `HTTP body truncated: ${attempt.probe.bodyTruncated}`,
    `WWW-Authenticate: ${attempt.probe.wwwAuthenticate ?? "<missing>"}`,
    `HTTP body: ${attempt.probe.body || "<empty>"}`,
    `HTTP error: ${attempt.probe.requestError ?? "<none>"}`,
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
    await Bun.sleep(100);
    acceptance = establishToolAcceptanceAtLivenessBoundary(
      probe,
      ownedProbe.ownershipVerified,
      () => observedExitCode,
    );
  } finally {
    exitCode = await terminateChild(child, exited);
    [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  }
  if (!probe) fail("OpenCode tool probe ended without a result.");
  if (!acceptance) fail("OpenCode tool acceptance ended without a verdict.");
  return Object.freeze({
    probe: Object.freeze({ ...probe }),
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
    const attempt = await dependencies.launchProbeAndCleanup(
      port,
      environment,
      workingDirectory,
      credentials,
    );
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
      `${launchFailureDiagnostics(launchNumber, attemptNumber, attempt)}\nMissing required tool IDs: ${attempt.missingToolIds.join(", ") || "unable to parse response"}`,
    );
  }
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
    await mkdir(home);
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
    const ocx = join(localBinaryDirectory, profileLaunchCommand);
    await run(ocx, ["init", "--global"], environment, home);
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
    );
    await run(
      ocx,
      ["verify"],
      environment,
      join(sandbox, "config", "opencode", "profiles", "workcell"),
    );
    await assertInstalledTools(1, environment, home);
    await assertInstalledTools(2, environment, home);
  } finally {
    await cleanupSmokeSandbox(sandbox, server);
  }
}

if (import.meta.main) await main();
