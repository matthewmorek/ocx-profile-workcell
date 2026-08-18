import { gunzipSync } from "node:zlib";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fail, parseArguments, parseTag, parseVersion, readJsonc, requiredArgument, resolvedInside, sha256, sha256File, writeTextAtomic } from "./common";
import { parseInstallEvidence, type InstallEvidence } from "./evidence";
import { parseReleaseManifest, type ReleaseManifest } from "./release-state";

type ArchiveEntry = Readonly<{ path: string; content: Uint8Array; mode: number }>;
type ProvenanceFile = Readonly<{ path: string; sha256: string; mode: number }>;
export type Provenance = Readonly<{ schemaVersion: 1; tag: string; version: string; commit: string; taggerEpoch: number; archiveSha256: string; evidence: InstallEvidence; files: readonly ProvenanceFile[] }>;
const expectedPagePaths = ["components/ws/profiles/ws/AGENTS.md", "components/ws/profiles/ws/ocx.jsonc", "components/ws-overrides.json", "components/ws.json", "index.json", "release.json"];

function tarField(header: Uint8Array, start: number, length: number): string { return Buffer.from(header.slice(start, start + length)).toString().replace(/\0.*$/, "").trim(); }
function tarNumber(header: Uint8Array, start: number, length: number, field: string): number {
  const text = tarField(header, start, length);
  if (!/^[0-7]+$/.test(text)) fail(`Tar ${field} is not canonical octal.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) fail(`Tar ${field} is outside the safe integer range.`);
  return value;
}
function octal(value: number, length: number): Uint8Array { return Buffer.from(`${value.toString(8).padStart(length - 1, "0")}\0`); }
function assertCanonicalField(header: Uint8Array, start: number, length: number, value: number, field: string): void {
  if (!Buffer.from(header.slice(start, start + length)).equals(octal(value, length))) fail(`Tar ${field} has non-canonical padding.`);
}
function assertZeros(header: Uint8Array, start: number, length: number, field: string): void { if (header.slice(start, start + length).some(Boolean)) fail(`Tar ${field} must be empty.`); }
function verifyHeaderChecksum(header: Uint8Array): void {
  const declared = tarNumber(header, 148, 8, "checksum");
  const actual = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 0x20 : byte), 0);
  if (declared !== actual || !Buffer.from(header.slice(148, 156)).equals(octal(actual, 8))) fail("Tar header checksum mismatch.");
}
function verifyGzipHeader(archive: Uint8Array): void {
  if (archive.length < 18 || archive[0] !== 0x1f || archive[1] !== 0x8b || archive[2] !== 8 || archive[3] !== 0 || archive[8] !== 0 || archive[9] !== 3) fail("Archive gzip header is not deterministic.");
  if (archive.slice(4, 8).some(Boolean)) fail("Archive gzip mtime must be zero.");
}

export function parseTar(archive: Uint8Array, expectedEpoch?: number): ArchiveEntry[] {
  verifyGzipHeader(archive);
  const data = gunzipSync(archive); const entries: ArchiveEntry[] = []; const names = new Set<string>(); let offset = 0;
  while (offset + 512 <= data.length && data.slice(offset, offset + 512).some(Boolean)) {
    const header = data.slice(offset, offset + 512); verifyHeaderChecksum(header);
    const path = tarField(header, 0, 100); const type = tarField(header, 156, 1) || "0";
    const mode = tarNumber(header, 100, 8, "mode"); const uid = tarNumber(header, 108, 8, "uid"); const gid = tarNumber(header, 116, 8, "gid"); const size = tarNumber(header, 124, 12, "size"); const mtime = tarNumber(header, 136, 12, "mtime");
    assertCanonicalField(header, 100, 8, mode, "mode"); assertCanonicalField(header, 108, 8, uid, "uid"); assertCanonicalField(header, 116, 8, gid, "gid"); assertCanonicalField(header, 124, 12, size, "size"); assertCanonicalField(header, 136, 12, mtime, "mtime");
    if (!Buffer.from(header.slice(257, 263)).equals(Buffer.from("ustar\0")) || !Buffer.from(header.slice(263, 265)).equals(Buffer.from("00"))) fail("Tar is not USTAR.");
    assertZeros(header, 265, 32, "owner name"); assertZeros(header, 297, 32, "group name"); assertZeros(header, 329, 8, "device major"); assertZeros(header, 337, 8, "device minor"); assertZeros(header, 345, 155, "path prefix"); assertZeros(header, 500, 12, "reserved bytes");
    if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || names.has(path) || type !== "0" || mode !== 0o644 || uid !== 0 || gid !== 0 || (expectedEpoch !== undefined && mtime !== expectedEpoch)) fail(`Unsafe or non-deterministic tar entry ${path || "<empty>"}.`);
    const contentStart = offset + 512; const content = data.slice(contentStart, contentStart + size);
    const paddingLength = (512 - (size % 512)) % 512;
    if (content.length !== size || data.slice(contentStart + size, contentStart + size + paddingLength).some(Boolean)) fail(`Tar entry ${path} is truncated or has non-zero padding.`);
    names.add(path); entries.push({ path, content, mode }); offset = contentStart + size + paddingLength;
  }
  if (offset + 1024 !== data.length || data.slice(offset).some(Boolean)) fail("Archive is missing canonical terminal tar blocks.");
  return entries;
}

export function parseProvenance(value: unknown): Provenance {
  if (!value || typeof value !== "object") fail("Provenance is malformed.");
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || typeof candidate.tag !== "string" || typeof candidate.version !== "string" || typeof candidate.commit !== "string" || !/^[0-9a-f]{40}$/i.test(candidate.commit) || !Number.isSafeInteger(candidate.taggerEpoch) || (candidate.taggerEpoch as number) < 0 || typeof candidate.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.archiveSha256) || !Array.isArray(candidate.files)) fail("Provenance identity or checksum declaration is malformed.");
  const tag = parseTag(candidate.tag); const version = parseVersion(candidate.version);
  if (tag.slice(1) !== version) fail("Provenance tag and version differ.");
  const evidence = parseInstallEvidence(candidate.evidence);
  if (evidence.version !== version || evidence.commit !== candidate.commit) fail("Provenance evidence identity differs from provenance.");
  const files = candidate.files.map((file): ProvenanceFile => {
    if (!file || typeof file !== "object") fail("Provenance contains a malformed file.");
    const declaration = file as Record<string, unknown>;
    if (typeof declaration.path !== "string" || declaration.path.startsWith("/") || declaration.path.split("/").some((part) => !part || part === "." || part === "..") || typeof declaration.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(declaration.sha256) || declaration.mode !== 0o644) fail("Provenance contains an unsafe file declaration.");
    return declaration as ProvenanceFile;
  });
  if (new Set(files.map(({ path }) => path)).size !== files.length || JSON.stringify(files.map(({ path }) => path)) !== JSON.stringify(expectedPagePaths)) fail("Provenance page paths are missing, extra, or out of order.");
  return { schemaVersion: 1, tag, version, commit: candidate.commit, taggerEpoch: candidate.taggerEpoch as number, archiveSha256: candidate.archiveSha256, evidence, files };
}

async function verifyChecksums(archive: string, provenance: string, receipt: string, checksums: string): Promise<void> {
  const expected = new Map<string, string>([[basename(archive), await sha256File(archive)], ["provenance.json", await sha256File(provenance)], ["receipt.jsonc", await sha256File(receipt)]]);
  const lines = (await Bun.file(checksums).text()).trim().split("\n");
  if (lines.length !== expected.size) fail("SHA256SUMS has an unexpected number of entries.");
  for (const line of lines) { const match = /^([a-f0-9]{64})  ([^/\s]+)$/.exec(line); if (!match || expected.get(match[2]) !== match[1]) fail(`Checksum mismatch or unexpected asset declaration: ${line}.`); expected.delete(match[2]); }
  if (expected.size !== 0) fail("SHA256SUMS is missing required assets.");
}
function assertReleaseIdentity(release: ReleaseManifest | undefined, provenance: Provenance): asserts release is ReleaseManifest {
  if (!release || release.tag !== provenance.tag || release.version !== provenance.version || release.commit !== provenance.commit || release.releasedAt !== new Date(provenance.taggerEpoch * 1000).toISOString()) fail("Archived release.json identity differs from provenance.");
}
async function verifyBundle(): Promise<void> {
  const values = parseArguments(Bun.argv.slice(3), ["--archive", "--provenance", "--receipt", "--checksums", "--extract-to", "--expected-tag"]);
  const archive = requiredArgument(values, "--archive"); const provenancePath = requiredArgument(values, "--provenance"); const receiptPath = requiredArgument(values, "--receipt"); const expectedTag = parseTag(requiredArgument(values, "--expected-tag"));
  if (basename(archive) !== `ocx-workspace-profile-${expectedTag}.tar.gz`) fail("Archive filename does not match expected tag.");
  const provenance = parseProvenance(await readJsonc(provenancePath));
  if (provenance.tag !== expectedTag || provenance.archiveSha256 !== await sha256File(archive)) fail("Archive identity or checksum disagrees with provenance.");
  const receipt = await readJsonc(receiptPath);
  if (JSON.stringify(receipt) !== JSON.stringify(provenance.evidence.receipt)) fail("Sanitized receipt differs from provenance evidence receipt.");
  await verifyChecksums(archive, provenancePath, receiptPath, requiredArgument(values, "--checksums"));
  const entries = parseTar(await readFile(archive), provenance.taggerEpoch); const expected = new Map(provenance.files.map((file) => [file.path, file]));
  if (entries.length !== expected.size) fail("Archive membership differs from provenance.");
  for (const entry of entries) { const declaration = expected.get(entry.path); if (!declaration || declaration.mode !== entry.mode || declaration.sha256 !== sha256(entry.content)) fail(`Archive entry verification failed for ${entry.path}.`); }
  const releaseEntry = entries.find(({ path }) => path === "release.json"); assertReleaseIdentity(releaseEntry && parseReleaseManifest(JSON.parse(new TextDecoder().decode(releaseEntry.content))), provenance);
  const destination = resolve(requiredArgument(values, "--extract-to")); await mkdir(destination, { recursive: false });
  for (const entry of entries) await writeTextAtomic(resolvedInside(destination, entry.path), entry.content);
}
async function verifyLive(): Promise<void> {
  const values = parseArguments(Bun.argv.slice(3), ["--base-url", "--provenance", "--release", "--expected-tag"]); const base = requiredArgument(values, "--base-url").replace(/\/$/, ""); const expectedTag = parseTag(requiredArgument(values, "--expected-tag"));
  const provenance = parseProvenance(await readJsonc(requiredArgument(values, "--provenance"))); const expectedRelease = parseReleaseManifest(await readJsonc(requiredArgument(values, "--release")));
  if (provenance.tag !== expectedTag) fail("Live verification expected tag differs from provenance."); assertReleaseIdentity(expectedRelease, provenance);
  for (const file of provenance.files) { const response = await fetch(`${base}/${file.path}`); if (!response.ok || sha256(new Uint8Array(await response.arrayBuffer())) !== file.sha256) fail(`Live file differs: ${file.path}.`); }
}
if (import.meta.main) { if (Bun.argv[2] === "bundle") await verifyBundle(); else if (Bun.argv[2] === "live") await verifyLive(); else fail("Expected verify-release subcommand bundle or live."); }
