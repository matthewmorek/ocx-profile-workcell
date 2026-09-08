import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { expectedComponents } from "./build-registry";

const repositoryRoot = resolve(import.meta.dir, "..");
const commandTimeoutMilliseconds = 180_000;
const diagnosticCharacterLimit = 65_536;
const localBinaryDirectory = join(repositoryRoot, "node_modules", ".bin");
const profileTargets = [
  "ocx.jsonc",
  "opencode.jsonc",
  "tui.jsonc",
  "AGENTS.md",
] as const;
const expectedReceiptComponents = expectedComponents.filter(
  (name) => name !== "workcell",
);
const expectedReceiptComponentCount = 23;

export const npmPolicyContent = "min-release-age=7\nengine-strict=false\n";
export const expectedDirectNpmDependencies = Object.freeze({
  "@opencode-ai/plugin": "1.18.25",
  "detect-terminal": "2.0.0",
  "jsonc-parser": "3.3.1",
  "node-notifier": "10.0.1",
  "unique-names-generator": "4.7.1",
  zod: "4.3.5",
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function terminateChild(
  child: ReturnType<typeof Bun.spawn>,
  exited: Promise<number>,
): Promise<number> {
  signalChildProcessGroup(child, "SIGTERM");
  const gracefulExitCode = await Promise.race([
    exited,
    Bun.sleep(5_000).then(() => undefined),
  ]);
  signalChildProcessGroup(child, "SIGKILL");
  return gracefulExitCode ?? (await exited);
}

export async function runSmokeCommand(
  command: string,
  arguments_: string[],
  environment: Record<string, string | undefined>,
  workingDirectory: string,
  redactionContext: SmokeRedactionContext,
  timeoutMilliseconds = commandTimeoutMilliseconds,
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
  const completion = Promise.all([exited, stdout, stderr] as const);
  const result = await Promise.race([
    completion,
    Bun.sleep(timeoutMilliseconds).then(() => undefined),
  ]);

  if (result === undefined) {
    await terminateChild(child, exited);
    const [stdoutResult, stderrResult] = await Promise.allSettled([
      stdout,
      stderr,
    ]);
    const capturedStdout =
      stdoutResult.status === "fulfilled"
        ? stdoutResult.value
        : `Stream capture failed: ${errorMessage(stdoutResult.reason)}`;
    const capturedStderr =
      stderrResult.status === "fulfilled"
        ? stderrResult.value
        : `Stream capture failed: ${errorMessage(stderrResult.reason)}`;
    fail(
      boundSmokeDiagnostics(
        redactSmokeDiagnostics(
          `${formatCommand(command, arguments_)} timed out after ${timeoutMilliseconds}ms.\nstdout:\n${capturedStdout}\nstderr:\n${capturedStderr}`,
          redactionContext,
        ),
      ),
    );
  }
  const [exitCode, capturedStdout, capturedStderr] = result;
  if (exitCode !== 0) {
    fail(
      boundSmokeDiagnostics(
        redactSmokeDiagnostics(
          `${formatCommand(command, arguments_)} exited with code ${exitCode}.\nstdout:\n${capturedStdout}\nstderr:\n${capturedStderr}`,
          redactionContext,
        ),
      ),
    );
  }
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

export async function cleanupSmokeSandbox(
  sandbox: string,
  server?: SmokeServer,
): Promise<void> {
  try {
    await server?.stop(true);
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
  if (!requestedPath || requestedPath.split("/").includes("..")) return;
  const file = resolve(registryDirectory, requestedPath);
  return relative(registryDirectory, file).startsWith("..") ? undefined : file;
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

function requireRecord(value: unknown, owner: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${owner} must be an object.`);
  return value as Record<string, unknown>;
}

async function readVersion(path: string, owner: string): Promise<string> {
  const value = requireRecord(
    parseJsoncDocument(await readFile(path, "utf8"), owner),
    owner,
  );
  if (typeof value.version !== "string" || !value.version)
    fail(`${owner} must declare a non-empty version.`);
  return value.version;
}

export async function assertBuiltRegistryVersion(
  registryDirectory: string,
  sourceVersion: string,
): Promise<void> {
  const indexPath = join(registryDirectory, "index.json");
  if (!(await Bun.file(indexPath).exists()))
    fail(
      `Built registry not found at ${registryDirectory}. Run bun run build first.`,
    );
  const builtVersion = await readVersion(indexPath, "Built registry index");
  if (builtVersion !== sourceVersion)
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
  if (packageVersion !== registryVersion)
    fail(
      `Source versions disagree: package.json is ${packageVersion}, but registry.jsonc is ${registryVersion}.`,
    );
  await assertBuiltRegistryVersion(registryDirectory, registryVersion);
}

async function requireRegularFile(path: string, owner: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (!status.isFile()) fail(`${owner} must be a regular file.`);
  } catch (error) {
    if (
      error instanceof Error &&
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      fail(`${owner} must be a regular file.`);
    throw error;
  }
}

function assertExactStringMap(
  value: unknown,
  expected: Readonly<Record<string, string>>,
  owner: string,
): void {
  const record = requireRecord(value, owner);
  const actualNames = Object.keys(record).sort();
  const expectedNames = Object.keys(expected).sort();
  const missing = expectedNames.filter((name) => !(name in record));
  const unexpected = actualNames.filter((name) => !(name in expected));
  if (missing.length || unexpected.length)
    fail(
      `${owner} has an incorrect package set; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  for (const name of expectedNames) {
    if (record[name] !== expected[name])
      fail(
        `${owner} resolved ${name} to ${String(record[name])}; expected ${expected[name]}.`,
      );
  }
}

function assertEmptyDependencySection(
  manifest: Record<string, unknown>,
  section: "devDependencies" | "optionalDependencies" | "peerDependencies",
): void {
  const value = manifest[section];
  if (value === undefined) return;
  const dependencies = requireRecord(
    value,
    `Installed Workcell package manifest ${section}`,
  );
  const names = Object.keys(dependencies);
  if (names.length > 0)
    fail(
      `Installed Workcell package manifest ${section} must be empty; received: ${names.join(", ")}.`,
    );
}

function assertReceiptContract(value: unknown): void {
  if (expectedReceiptComponents.length !== expectedReceiptComponentCount)
    fail(
      `Reviewed receipt contract must contain exactly ${expectedReceiptComponentCount} component names; received ${expectedReceiptComponents.length}.`,
    );
  const receipt = requireRecord(value, "Installed Workcell receipt");
  if (receipt.version !== 1)
    fail("Installed Workcell receipt must use version 1.");
  const installed = requireRecord(
    receipt.installed,
    "Installed Workcell receipt installed entries",
  );
  const entries = Object.values(installed);
  if (entries.length !== expectedReceiptComponentCount)
    fail(
      `Installed Workcell receipt must contain exactly ${expectedReceiptComponentCount} entries; received ${entries.length}.`,
    );

  const identities = new Set<string>();
  const names = new Set<string>();
  for (const [index, candidate] of entries.entries()) {
    const entry = requireRecord(
      candidate,
      `Installed Workcell receipt entry ${index}`,
    );
    if (
      typeof entry.registryName !== "string" ||
      typeof entry.name !== "string"
    )
      fail(
        `Installed Workcell receipt entry ${index} has an unsupported shape.`,
      );
    if (entry.registryName !== "matthewmorek")
      fail(
        `Installed Workcell receipt entry ${entry.name} has registry owner ${entry.registryName}; expected matthewmorek.`,
      );
    const identity = `${entry.registryName}/${entry.name}`;
    if (identities.has(identity))
      fail(`Installed Workcell receipt duplicates identity ${identity}.`);
    if (names.has(entry.name))
      fail(
        `Installed Workcell receipt duplicates component name ${entry.name}.`,
      );
    identities.add(identity);
    names.add(entry.name);
  }

  const missing = expectedReceiptComponents.filter((name) => !names.has(name));
  const unexpected = [...names].filter(
    (name) => !expectedReceiptComponents.includes(name as never),
  );
  if (missing.length || unexpected.length)
    fail(
      `Installed Workcell receipt component set is incorrect; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}.`,
    );
}

export async function assertInstalledLayout(
  installedProfileDirectory: string,
): Promise<void> {
  for (const target of profileTargets)
    await requireRegularFile(
      join(installedProfileDirectory, target),
      `Installed Workcell profile target ${target}`,
    );

  const receiptPath = join(installedProfileDirectory, ".ocx", "receipt.jsonc");
  await requireRegularFile(receiptPath, "Installed Workcell receipt");
  assertReceiptContract(
    parseJsoncDocument(
      await readFile(receiptPath, "utf8"),
      "Installed Workcell receipt",
    ),
  );

  const manifestPath = join(installedProfileDirectory, "package.json");
  await requireRegularFile(manifestPath, "Installed Workcell package manifest");
  const manifest = requireRecord(
    parseJsoncDocument(
      await readFile(manifestPath, "utf8"),
      "Installed Workcell package manifest",
    ),
    "Installed Workcell package manifest",
  );
  assertExactStringMap(
    manifest.dependencies,
    expectedDirectNpmDependencies,
    "Installed Workcell package manifest dependencies",
  );
  for (const section of [
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const)
    assertEmptyDependencySection(manifest, section);

  for (const [name, version] of Object.entries(expectedDirectNpmDependencies)) {
    const packageManifestPath = join(
      installedProfileDirectory,
      "node_modules",
      name,
      "package.json",
    );
    await requireRegularFile(
      packageManifestPath,
      `Installed direct package ${name} manifest`,
    );
    const packageManifest = requireRecord(
      parseJsoncDocument(
        await readFile(packageManifestPath, "utf8"),
        `Installed direct package ${name} manifest`,
      ),
      `Installed direct package ${name} manifest`,
    );
    if (packageManifest.version !== version)
      fail(
        `Installed direct package ${name} has version ${String(packageManifest.version)}; expected ${version}.`,
      );
  }
}

export async function assertRemovedLayout(
  workcellProfileDirectory: string,
  defaultProfileDirectory: string,
): Promise<void> {
  try {
    await lstat(workcellProfileDirectory);
    fail("Removed Workcell profile root still exists.");
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // Expected: lstat proves no directory, symlink, or file survived removal.
    } else {
      throw error;
    }
  }
  try {
    const status = await lstat(defaultProfileDirectory);
    if (!status.isDirectory() || status.isSymbolicLink())
      fail(
        "Initialized default profile must remain a directory after removal.",
      );
  } catch (error) {
    if (
      error instanceof Error &&
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      fail(
        "Initialized default profile must remain a directory after removal.",
      );
    throw error;
  }
}

function isSecretEnvironmentVariable(name: string): boolean {
  return (
    /(?:PASSWORD|USERNAME|TOKEN|AUTH)/i.test(name) &&
    /^(?:OPENCODE|NPM|BUN|NODE|npm_config_)/i.test(name)
  );
}

export function createSmokeRedactionContext(
  sandboxRoot: string,
  environment: Record<string, string | undefined> = {},
  temporaryPaths: readonly string[] = [],
): SmokeRedactionContext {
  const environmentSecrets = Object.entries(environment)
    .filter(([name, value]) => value && isSecretEnvironmentVariable(name))
    .map(([, value]) => value as string);
  return Object.freeze({
    sandboxRoot,
    repositoryRoot,
    localBinaryDirectory,
    exactSecrets: Object.freeze(
      [...new Set(environmentSecrets)]
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
  for (const secret of context.exactSecrets)
    redacted = redacted.replaceAll(secret, "<redacted>");
  for (const path of context.temporaryPaths)
    redacted = redacted.replaceAll(path, "<temporary-path>");
  return redacted
    .replaceAll(context.localBinaryDirectory, "<repository-binary-path>")
    .replaceAll(context.repositoryRoot, "<repository-path>")
    .replace(/Authorization:\s*Basic\s+\S+/gi, "Authorization: <redacted>")
    .replace(/Basic\s+[A-Za-z0-9+/=]{12,}/g, "Basic <redacted>")
    .replace(
      /((?:(?:\/\/[^:\s]+\/)?(?:npm|bun|node)?[_-]?(?:auth[_-]?)?token\s*[=:]\s*)[^\s"']+)/gi,
      "$1<redacted>",
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
    const redactionContext = createSmokeRedactionContext(sandbox, environment, [
      home,
    ]);
    if (environment.NPM_CONFIG_USERCONFIG !== npmPolicyPath)
      fail("Smoke environment did not select the sandbox npm policy.");

    const ocx = join(localBinaryDirectory, "ocx");
    const profilesDirectory = join(sandbox, "config", "opencode", "profiles");
    const installedProfileDirectory = join(profilesDirectory, "workcell");
    const defaultProfileDirectory = join(profilesDirectory, "default");
    await runSmokeCommand(
      ocx,
      ["init", "--global"],
      environment,
      home,
      redactionContext,
    );
    await runSmokeCommand(
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
    await runSmokeCommand(
      ocx,
      ["verify"],
      environment,
      installedProfileDirectory,
      redactionContext,
    );
    await runSmokeCommand(
      process.execPath,
      ["install"],
      environment,
      installedProfileDirectory,
      redactionContext,
    );
    await assertInstalledLayout(installedProfileDirectory);
    await runSmokeCommand(
      ocx,
      ["profile", "remove", "workcell", "--global"],
      environment,
      home,
      redactionContext,
    );
    await assertRemovedLayout(
      installedProfileDirectory,
      defaultProfileDirectory,
    );
  } catch (error) {
    fail(errorMessage(error));
  } finally {
    await cleanupSmokeSandbox(sandbox, server);
  }
}

if (import.meta.main) await main();
