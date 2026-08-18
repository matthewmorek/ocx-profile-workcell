import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

type Registry = { version?: unknown; components?: unknown[] };
export const expectedComponents = ["ws", "ws-overrides"] as const;
const repositoryRoot = resolve(import.meta.dir, "..");

function fail(message: string): never { throw new Error(message); }

function parseVersion(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) fail(`registry.jsonc must declare bare SemVer, received ${String(value)}.`);
  return value;
}

async function readJsonc<T>(path: string): Promise<T> {
  const errors: ParseError[] = [];
  const value = parse(await readFile(path, "utf8"), errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) fail(`Invalid JSONC ${path}: ${errors.map(({ error }) => printParseErrorCode(error)).join(", ")}.`);
  if (!value || typeof value !== "object") fail(`Expected JSON object in ${path}.`);
  return value as T;
}

function isSameOrWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent));
}

async function resolveThroughExistingAncestor(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let currentPath = path;
  while (true) {
    try {
      return resolve(await realpath(currentPath), ...missingSegments.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) fail(`Unable to resolve output directory ${path}.`);
      missingSegments.push(basename(currentPath));
      currentPath = parentPath;
    }
  }
}

async function assertOutputPathIsAbsentOrDirectory(path: string): Promise<void> {
  try {
    const outputStatus = await lstat(path);
    if (outputStatus.isSymbolicLink()) fail("Output directory must not be an existing symbolic link.");
    if (!outputStatus.isDirectory()) fail("Output directory must be absent or an existing directory.");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOTDIR") fail("Output directory contains a file path.");
    throw error;
  }
}

export async function outputDirectory(
  argv: string[],
  currentDirectory = process.cwd(),
  sourceRepositoryRoot = repositoryRoot,
): Promise<string> {
  const isDefaultOutput = argv.length === 0;
  if (!isDefaultOutput && (argv.length !== 2 || argv[0] !== "--out" || !argv[1].trim())) fail("Usage: bun run build -- [--out directory]");

  const requestedOutput = isDefaultOutput ? join(sourceRepositoryRoot, "dist") : resolve(currentDirectory, argv[1]);
  await assertOutputPathIsAbsentOrDirectory(requestedOutput);

  const [output, physicalCurrentDirectory, physicalRepositoryRoot] = await Promise.all([
    resolveThroughExistingAncestor(requestedOutput),
    resolveThroughExistingAncestor(currentDirectory),
    resolveThroughExistingAncestor(sourceRepositoryRoot),
  ]);
  if (parsePath(output).root === output) fail("Output directory must not be the filesystem root.");
  if (output === physicalCurrentDirectory) fail("Output directory must not be the current directory.");
  if (isSameOrWithin(output, physicalRepositoryRoot)) fail("Output directory must not be the repository root or one of its ancestors.");
  if (isSameOrWithin(output, physicalCurrentDirectory)) fail("Output directory must not be the current directory or one of its ancestors.");
  await assertOutputPathIsAbsentOrDirectory(output);
  if (isSameOrWithin(physicalRepositoryRoot, output) && output !== join(physicalRepositoryRoot, "dist")) fail("Output directory must be the exact repository dist directory or an external directory.");
  return output;
}

async function main(): Promise<void> {
  const output = await outputDirectory(Bun.argv.slice(2));
  const registry = await readJsonc<Registry>(join(repositoryRoot, "registry.jsonc"));
  const version = parseVersion(registry.version);
  if (!Array.isArray(registry.components)) fail("registry.jsonc components must be an array.");
  const components = registry.components.map((component) => (component as { name?: unknown }).name).sort();
  if (JSON.stringify(components) !== JSON.stringify(expectedComponents)) fail("Registry source must contain exactly ws and ws-overrides.");
  const ocx = Bun.which("ocx");
  if (!ocx) fail("OCX 2.0.14 is not installed. Run bun install --frozen-lockfile.");
  await mkdir(dirname(output), { recursive: true });
  const stagedParent = await mkdtemp(join(dirname(output), ".ocx-build-"));
  const stagedOutput = join(stagedParent, "registry");
  try {
    const child = Bun.spawn([ocx, "build", repositoryRoot, "--out", stagedOutput], { stdout: "inherit", stderr: "inherit" });
    if ((await child.exited) !== 0) fail("OCX registry build failed.");
    await rm(join(stagedOutput, ".well-known"), { recursive: true, force: true });
    await normalizeOcxOutput(stagedOutput, version);
    await validateOutput(stagedOutput, version);
    await promoteStagedOutput(stagedOutput, output);
  } finally { await rm(stagedParent, { recursive: true, force: true }); }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function promoteStagedOutput(stagedOutput: string, output: string): Promise<void> {
  await assertOutputPathIsAbsentOrDirectory(output);
  const backup = join(dirname(output), `.${basename(output)}.ocx-backup-${randomUUID()}`);
  const hadExistingOutput = await pathExists(output);
  let backupCreated = false;

  try {
    if (hadExistingOutput) {
      await rename(output, backup);
      backupCreated = true;
    }
    await rename(stagedOutput, output);
  } catch (promotionError) {
    if (!backupCreated) fail(`Unable to promote staged registry output: ${promotionError instanceof Error ? promotionError.message : String(promotionError)}`);
    try {
      await rename(backup, output);
      backupCreated = false;
    } catch (restoreError) {
      throw new AggregateError([promotionError, restoreError], `Unable to promote staged registry output and restore the previous output from ${backup}.`);
    }
    fail(`Unable to promote staged registry output; the previous output was restored: ${promotionError instanceof Error ? promotionError.message : String(promotionError)}`);
  }
  if (!backupCreated) return;
  try { await rm(backup, { recursive: true, force: true }); }
  catch (error) { fail(`Registry output was promoted but the backup ${backup} could not be removed: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function normalizeOcxOutput(directory: string, version: string): Promise<void> {
  const index = await readJsonc<{ version?: unknown }>(join(directory, "index.json"));
  if (index.version !== version) fail("OCX 2.0.14 output index.json must declare the requested registry version before normalization.");
  const names = (await readdir(join(directory, "components"), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const expectedNames = expectedComponents.map((component) => `${component}.json`).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) fail("OCX output must contain exactly ws and ws-overrides packuments.");
  for (const component of expectedComponents) {
    const path = join(directory, "components", `${component}.json`);
    const packument = await readJsonc<{ versions?: Record<string, unknown>; "dist-tags"?: Record<string, unknown> }>(path);
    if (!packument.versions || JSON.stringify(Object.keys(packument.versions)) !== JSON.stringify(["1.0.0"])) fail(`Unexpected OCX 2.0.14 packument shape for ${component}.`);
    const manifest = packument.versions["1.0.0"];
    if (!manifest || typeof manifest !== "object" || Object.hasOwn(manifest, "version")) fail(`Component manifest ${component} unexpectedly contains a version field.`);
    if (!packument["dist-tags"] || typeof packument["dist-tags"] !== "object") fail(`Packument ${component} has no dist-tags.`);
    packument.versions = { [version]: manifest };
    packument["dist-tags"].latest = version;
    await Bun.write(path, `${JSON.stringify(packument, null, 2)}\n`);
  }
}

export async function validateOutput(directory: string, version: string): Promise<void> {
  const index = await readJsonc<{ version?: unknown }>(join(directory, "index.json"));
  if (index.version !== version) fail("Normalized index version is incorrect.");
  for (const component of expectedComponents) {
    const packument = await readJsonc<{ versions?: Record<string, unknown>; "dist-tags"?: { latest?: unknown } }>(join(directory, "components", `${component}.json`));
    if (JSON.stringify(Object.keys(packument.versions ?? {})) !== JSON.stringify([version])) fail(`Normalized ${component} versions are incorrect.`);
    if (packument["dist-tags"]?.latest !== version) fail(`Normalized ${component} latest tag is incorrect.`);
    if (Object.values(packument.versions ?? {}).some((manifest) => !manifest || typeof manifest !== "object" || Object.hasOwn(manifest as object, "version"))) fail(`Normalized ${component} manifest contains an embedded version.`);
  }
}

if (import.meta.main) await main();
