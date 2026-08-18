import { gzipSync } from "node:zlib";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fail, parseArguments, parseTag, parseVersion, readJsonc, requiredArgument, sha256, sha256File, sortedFiles, writeJsonAtomic, writeTextAtomic } from "./common";
import { parseInstallEvidence } from "./evidence";

export const expectedPagePaths = ["components/ws/profiles/ws/AGENTS.md", "components/ws/profiles/ws/ocx.jsonc", "components/ws-overrides.json", "components/ws.json", "index.json", "release.json"] as const;

function writeOctal(buffer: Uint8Array, offset: number, length: number, value: number): void { buffer.set(Buffer.from(value.toString(8).padStart(length - 1, "0") + "\0"), offset); }
function tarHeader(path: string, size: number, epoch: number): Uint8Array {
  if (Buffer.byteLength(path) > 100) fail(`USTAR path is too long: ${path}.`);
  const header = new Uint8Array(512); header.set(Buffer.from(path), 0); writeOctal(header, 100, 8, 0o644); writeOctal(header, 108, 8, 0); writeOctal(header, 116, 8, 0); writeOctal(header, 124, 12, size); writeOctal(header, 136, 12, epoch); header.fill(0x20, 148, 156); header[156] = "0".charCodeAt(0); header.set(Buffer.from("ustar\0"), 257); header.set(Buffer.from("00"), 263); const sum = header.reduce((total, byte) => total + byte, 0); writeOctal(header, 148, 8, sum); return header;
}
export function assertPagePaths(paths: readonly string[]): void {
  if (JSON.stringify(paths) !== JSON.stringify(expectedPagePaths)) fail("Pages directory must contain exactly index.json, release.json, and both packuments.");
}

export async function deterministicArchive(pages: string, out: string, epoch: number): Promise<void> {
  const chunks: Uint8Array[] = [];
  const paths = await sortedFiles(pages);
  assertPagePaths(paths);
  for (const path of paths) {
    const file = join(pages, path); const details = await stat(file);
    if (!details.isFile()) fail(`Only regular files are allowed: ${path}.`);
    const content = await readFile(file); chunks.push(tarHeader(path, content.length, epoch), content, new Uint8Array((512 - (content.length % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024)); const tar = Buffer.concat(chunks); const gzip = gzipSync(tar, { mtime: 0 }); gzip[9] = 3; await Bun.write(out, gzip);
}
async function main(): Promise<void> {
  const arguments_ = parseArguments(Bun.argv.slice(2), ["--version", "--tag", "--commit", "--tagger-epoch", "--pages", "--evidence", "--out-dir"]);
  const version = parseVersion(requiredArgument(arguments_, "--version")); const tag = parseTag(requiredArgument(arguments_, "--tag")); if (tag.slice(1) !== version) fail("Tag and version differ.");
  const epoch = Number(requiredArgument(arguments_, "--tagger-epoch")); if (!Number.isSafeInteger(epoch) || epoch < 0) fail("tagger-epoch must be a non-negative integer.");
  const pages = requiredArgument(arguments_, "--pages"); const output = requiredArgument(arguments_, "--out-dir"); const commit = requiredArgument(arguments_, "--commit"); await mkdir(output, { recursive: true });
  const releasePath = join(pages, "release.json"); await writeJsonAtomic(releasePath, { schemaVersion: 1, tag, version, commit, releasedAt: new Date(epoch * 1000).toISOString() });
  const archive = join(output, `ocx-workspace-profile-${tag}.tar.gz`); await deterministicArchive(pages, archive, epoch);
  const provenance = join(output, "provenance.json"); const evidence = parseInstallEvidence(await readJsonc(requiredArgument(arguments_, "--evidence")));
  if (evidence.version !== version || evidence.commit !== commit) fail("Install evidence does not match the release version and commit.");
  const listed = await sortedFiles(pages); await writeJsonAtomic(provenance, { schemaVersion: 1, tag, version, commit, taggerEpoch: epoch, archiveSha256: await sha256File(archive), evidence, files: await Promise.all(listed.map(async (path) => ({ path, sha256: await sha256File(join(pages, path)), mode: 0o644 }))) });
  const receipt = join(output, "receipt.jsonc"); await writeJsonAtomic(receipt, evidence.receipt);
  const checksums = join(output, "SHA256SUMS"); await writeTextAtomic(checksums, `${await sha256File(archive)}  ${archive.split("/").at(-1)}\n${await sha256File(provenance)}  provenance.json\n${await sha256File(receipt)}  receipt.jsonc\n`);
  await writeJsonAtomic(join(output, "release-bundle.json"), { schemaVersion: 1, tag, version, assets: await Promise.all([archive, provenance, receipt, checksums].map(async (path) => ({ path: path.split("/").at(-1), name: path.split("/").at(-1), sha256: await sha256File(path) }))) });
}
if (import.meta.main) await main();
