import { gunzipSync } from "node:zlib";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fail, parseArguments, readJsonc, requiredArgument, resolvedInside, sha256, sha256File, writeTextAtomic } from "./common";
import { parseReleaseManifest } from "./release-state";

type ArchiveEntry = Readonly<{ path: string; content: Uint8Array; mode: number }>;
type ProvenanceFile = Readonly<{ path: string; sha256: string; mode: number }>;
type Provenance = Readonly<{ archiveSha256: string; files: readonly ProvenanceFile[] }>;
const expectedPagePaths = ["components/ws/profiles/ws/AGENTS.md", "components/ws/profiles/ws/ocx.jsonc", "components/ws-overrides.json", "components/ws.json", "index.json", "release.json"];

function tarField(header: Uint8Array, start: number, length: number): string {
  return Buffer.from(header.slice(start, start + length)).toString().replace(/\0.*$/, "").trim();
}

function tarNumber(header: Uint8Array, start: number, length: number, field: string): number {
  const text = tarField(header, start, length);
  if (!/^[0-7]+$/.test(text)) fail(`Tar ${field} is not canonical octal.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) fail(`Tar ${field} is outside the safe integer range.`);
  return value;
}

function verifyHeaderChecksum(header: Uint8Array): void {
  const declared = tarNumber(header, 148, 8, "checksum");
  const actual = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 0x20 : byte), 0);
  if (declared !== actual) fail("Tar header checksum mismatch.");
}

export function parseTar(archive: Uint8Array): ArchiveEntry[] {
  const data = gunzipSync(archive);
  const entries: ArchiveEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset + 512 <= data.length && data.slice(offset, offset + 512).some(Boolean)) {
    const header = data.slice(offset, offset + 512);
    verifyHeaderChecksum(header);
    const path = tarField(header, 0, 100);
    const type = tarField(header, 156, 1) || "0";
    const mode = tarNumber(header, 100, 8, "mode");
    const size = tarNumber(header, 124, 12, "size");
    const prefix = tarField(header, 345, 155);
    if (!path || prefix || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || names.has(path) || type !== "0" || mode !== 0o644 || size < 0) fail(`Unsafe tar entry ${path || "<empty>"}.`);
    const contentStart = offset + 512;
    const content = data.slice(contentStart, contentStart + size);
    if (content.length !== size) fail(`Truncated tar entry ${path}.`);
    names.add(path);
    entries.push({ path, content, mode });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (offset + 1024 !== data.length || data.slice(offset).some(Boolean)) fail("Archive is missing canonical terminal tar blocks.");
  return entries;
}

export function parseProvenance(value: unknown): Provenance {
  if (!value || typeof value !== "object") fail("Provenance is malformed.");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.archiveSha256) || !Array.isArray(candidate.files)) fail("Provenance checksum declaration is malformed.");
  const files = candidate.files.map((file): ProvenanceFile => {
    if (!file || typeof file !== "object") fail("Provenance contains a malformed file.");
    const declaration = file as Record<string, unknown>;
    if (typeof declaration.path !== "string" || declaration.path.startsWith("/") || declaration.path.split("/").some((part) => !part || part === "." || part === "..") || typeof declaration.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(declaration.sha256) || declaration.mode !== 0o644) fail("Provenance contains an unsafe file declaration.");
    return declaration as ProvenanceFile;
  });
  if (new Set(files.map(({ path }) => path)).size !== files.length) fail("Provenance contains duplicate paths.");
  if (JSON.stringify(files.map(({ path }) => path)) !== JSON.stringify(expectedPagePaths)) fail("Provenance page paths are missing, extra, or out of order.");
  return { archiveSha256: candidate.archiveSha256, files };
}

async function verifyChecksums(archive: string, provenance: string, receipt: string, checksums: string): Promise<void> {
  const expected = new Map<string, string>([
    [basename(archive), await sha256File(archive)],
    ["provenance.json", await sha256File(provenance)],
    ["receipt.jsonc", await sha256File(receipt)],
  ]);
  const lines = (await Bun.file(checksums).text()).trim().split("\n");
  if (lines.length !== expected.size) fail("SHA256SUMS has an unexpected number of entries.");
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^/\s]+)$/.exec(line);
    if (!match || expected.get(match[2]) !== match[1]) fail(`Checksum mismatch or unexpected asset declaration: ${line}.`);
    expected.delete(match[2]);
  }
  if (expected.size !== 0) fail("SHA256SUMS is missing required assets.");
}

async function verifyBundle(): Promise<void> {
  const values = parseArguments(Bun.argv.slice(3), ["--archive", "--provenance", "--receipt", "--checksums", "--extract-to"]);
  const archive = requiredArgument(values, "--archive");
  const provenancePath = requiredArgument(values, "--provenance");
  const receipt = requiredArgument(values, "--receipt");
  const provenance = parseProvenance(await readJsonc(provenancePath));
  if (provenance.archiveSha256 !== await sha256File(archive)) fail("Archive checksum disagrees with provenance.");
  await readJsonc(receipt);
  await verifyChecksums(archive, provenancePath, receipt, requiredArgument(values, "--checksums"));
  const entries = parseTar(await readFile(archive));
  const expected = new Map(provenance.files.map((file) => [file.path, file]));
  if (entries.length !== expected.size) fail("Archive membership differs from provenance.");
  for (const entry of entries) {
    const declaration = expected.get(entry.path);
    if (!declaration || declaration.mode !== entry.mode || declaration.sha256 !== sha256(entry.content)) fail(`Archive entry verification failed for ${entry.path}.`);
  }
  const destination = resolve(requiredArgument(values, "--extract-to"));
  await mkdir(destination, { recursive: false });
  for (const entry of entries) await writeTextAtomic(resolvedInside(destination, entry.path), entry.content);
}

async function verifyLive(): Promise<void> {
  const values = parseArguments(Bun.argv.slice(3), ["--base-url", "--provenance", "--release"]);
  const base = requiredArgument(values, "--base-url").replace(/\/$/, "");
  const provenance = parseProvenance(await readJsonc(requiredArgument(values, "--provenance")));
  const expectedRelease = parseReleaseManifest(await readJsonc(requiredArgument(values, "--release")));
  if (!expectedRelease) fail("Expected release.json is malformed.");
  if (!provenance.files.some(({ path }) => path === "release.json")) fail("Provenance does not declare release.json.");
  for (const file of provenance.files) {
    const response = await fetch(`${base}/${file.path}`);
    if (!response.ok || sha256(new Uint8Array(await response.arrayBuffer())) !== file.sha256) fail(`Live file differs: ${file.path}.`);
  }
}

if (import.meta.main) {
  if (Bun.argv[2] === "bundle") await verifyBundle();
  else if (Bun.argv[2] === "live") await verifyLive();
  else fail("Expected verify-release subcommand bundle or live.");
}
