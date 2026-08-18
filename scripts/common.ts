import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export const repositoryRoot = resolve(import.meta.dir, "..");
export const strictSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function fail(message: string): never { throw new Error(message); }

export function parseArguments(argv: string[], allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || !allowed.includes(key)) fail(`Invalid argument ${key ?? "<missing>"}.`);
    if (values.has(key)) fail(`Duplicate argument ${key}.`);
    values.set(key, value);
  }
  return values;
}

export function requiredArgument(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) fail(`Missing required argument ${name}.`);
  return value;
}

export function parseVersion(value: string): string {
  if (!strictSemver.test(value)) fail(`Expected bare SemVer, received ${value}.`);
  return value;
}

export function parseTag(value: string): string {
  if (!/^v/.test(value)) fail(`Expected v-prefixed SemVer tag, received ${value}.`);
  parseVersion(value.slice(1));
  return value;
}

export async function readJsonc<T>(path: string): Promise<T> {
  const errors: ParseError[] = [];
  const text = await readFile(path, "utf8");
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) fail(`Invalid JSONC ${path}: ${errors.map(({ error }) => printParseErrorCode(error)).join(", ")}.`);
  if (value === null || typeof value !== "object") fail(`Expected JSON object in ${path}.`);
  return value as T;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, value); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function promoteDirectory(stagedDirectory: string, destination: string): Promise<void> {
  const backup = `${destination}.backup-${randomUUID()}`;
  const exists = await pathExists(destination);
  try {
    if (exists) await rename(destination, backup);
    await rename(stagedDirectory, destination);
    if (exists) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (exists && !(await pathExists(destination)) && (await pathExists(backup))) await rename(backup, destination);
    throw error;
  }
}

export async function pathExists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
export async function sha256File(path: string): Promise<string> { return sha256(await readFile(path)); }
export function sha256(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }

export async function temporaryDirectory(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), `${prefix}-`)); }

export async function sortedFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(directory, path).split(sep).join("/"));
      else fail(`Unsupported non-regular entry ${path}.`);
    }
  }
  await visit(directory);
  return files;
}

export function resolvedInside(root: string, candidate: string): string {
  const resolved = resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) fail(`Path escapes root: ${candidate}.`);
  return resolved;
}

export async function copyDirectory(source: string, destination: string): Promise<void> { await cp(source, destination, { recursive: true, force: true, errorOnExist: false }); }
