import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { normalizeOcxOutput, validateOutput } from "../scripts/build-registry";
import { parseArguments, parseVersion, requiredArgument, sha256 } from "../scripts/common";
import { parseInstallEvidence, sanitizeEvidenceValue } from "../scripts/evidence";
import { assertPagePaths, deterministicArchive } from "../scripts/package-release";
import { parseProvenance, parseTar } from "../scripts/verify-release";
import { createSandboxEnvironment, run, serveRegistry } from "../scripts/verify-install";

const commit = "a".repeat(40);
const component = (identifier: string) => ({ identifier, revision: `sha256:${"a".repeat(64)}`, sha256: "a".repeat(64) });
const validEvidence = () => {
  const components = [component("kdco/workspace"), component("matthewmorek/ws-overrides")].sort((left, right) => `registry::${left.identifier}@${left.revision}`.localeCompare(`registry::${right.identifier}@${right.revision}`));
  const receipt = { version: 1, root: "<redacted-path>", installed: Object.fromEntries(components.map((entry) => [`registry::${entry.identifier}@${entry.revision}`, { registryName: entry.identifier.split("/")[0], name: entry.identifier.split("/")[1], revision: entry.revision, hash: entry.sha256 }])) };
  return { schemaVersion: 1, version: "0.1.0", commit, rootProfile: { source: "matthewmorek/ws", installedName: "ws" }, resolvedDependencyComponents: components, assertions: { install: true }, receipt, validation: { mode: "pinned", expectedToolVersions: { ocx: "2.0.14", opencode: "1.17.15" }, discoveredToolVersions: { ocx: "2.0.14", opencode: "1.17.15" } } };
};

async function temporaryDirectory(prefix: string): Promise<string> { return mkdtemp(join(tmpdir(), `${prefix}-`)); }
async function runScript(script: string, arguments_: readonly string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, "run", script, ...arguments_], { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${script} failed: ${stderr || stdout}`);
}
async function writeOcxOutput(root: string, packuments: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, "components"), { recursive: true });
  await Bun.write(join(root, "index.json"), JSON.stringify({ version: "0.1.0" }));
  for (const [name, value] of Object.entries(packuments)) await Bun.write(join(root, "components", `${name}.json`), JSON.stringify(value));
}
const packument = (manifest: Record<string, unknown> = {}) => ({ versions: { "1.0.0": manifest }, "dist-tags": { latest: "1.0.0" } });

function octal(value: number, length: number): Buffer { return Buffer.from(`${value.toString(8).padStart(length - 1, "0")}\0`); }
function tarEntry(path: string, content: string, type = "0", mode = 0o644): Buffer {
  const header = Buffer.alloc(512); header.write(path); octal(mode, 8).copy(header, 100); octal(0, 8).copy(header, 108); octal(0, 8).copy(header, 116); octal(content.length, 12).copy(header, 124); octal(0, 12).copy(header, 136); header.fill(0x20, 148, 156); header.write(type, 156); header.write("ustar\0", 257); header.write("00", 263);
  octal(header.reduce((total, byte) => total + byte, 0), 8).copy(header, 148);
  const body = Buffer.from(content); return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
function archive(...entries: Buffer[]): Uint8Array { const result = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]), { mtime: 0 }); result[9] = 3; return result; }

describe("strict CLI and evidence boundaries", () => {
  test("rejects malformed bare SemVer and malformed tags", () => {
    for (const version of ["v0.1.0", "01.0.0", "1.0", "1.0.0-01", "1.0.0-", "1.0.0+", "1.0.0-α"]) expect(() => parseVersion(version)).toThrow("SemVer");
    expect(parseVersion("1.0.0-rc.1+build.7")).toBe("1.0.0-rc.1+build.7");
  });

  test("rejects unknown, duplicate, dangling, and missing CLI arguments", () => {
    expect(() => parseArguments(["--unknown", "value"], ["--known"])).toThrow("Invalid argument");
    expect(() => parseArguments(["--known", "one", "--known", "two"], ["--known"])).toThrow("Duplicate argument");
    expect(() => parseArguments(["--known"], ["--known"])).toThrow("Invalid argument");
    expect(() => requiredArgument(new Map(), "--known")).toThrow("Missing required argument");
  });

  test("rejects incomplete, failed, path-contaminated, and secret-like evidence", () => {
    expect(parseInstallEvidence(validEvidence())).toMatchObject({ version: "0.1.0" });
    expect(() => parseInstallEvidence({ ...validEvidence(), resolvedDependencyComponents: [component("matthewmorek/ws-overrides")] })).toThrow("dependency resolution");
    expect(() => parseInstallEvidence({ ...validEvidence(), assertions: { install: false } })).toThrow("all pass");
    expect(() => parseInstallEvidence({ ...validEvidence(), assertions: {} })).toThrow("non-empty named assertions");
    expect(() => parseInstallEvidence({ ...validEvidence(), receipt: { version: 1, root: "<redacted-path>", installed: {} } })).toThrow("incomplete");
    expect(() => parseInstallEvidence({ ...validEvidence(), receipt: { ...validEvidence().receipt, root: "/Users/example" } })).toThrow("sanitized");
    expect(() => parseInstallEvidence({ ...validEvidence(), rootProfile: { source: "matthewmorek/not-ws", installedName: "ws" } })).toThrow("root profile");
    expect(() => parseInstallEvidence({ ...validEvidence(), rootProfile: { source: "matthewmorek/ws", installedName: "not-ws" } })).toThrow("root profile");
    expect(parseInstallEvidence({ ...validEvidence(), validation: { mode: "advisory", expectedToolVersions: null, discoveredToolVersions: { ocx: "9.0.0", opencode: "9.0.1" } } }).validation.discoveredToolVersions).toEqual({ ocx: "9.0.0", opencode: "9.0.1" });
    expect(() => parseInstallEvidence({ ...validEvidence(), validation: { mode: "advisory", expectedToolVersions: { ocx: "2.0.14", opencode: "1.17.15" }, discoveredToolVersions: { ocx: "9.0.0", opencode: "9.0.0" } } })).toThrow("Advisory");
    expect(sanitizeEvidenceValue({ token: "remove", location: "/Users/example/cache" })).toEqual({ location: "<redacted-path>" });
  });

  test("uses a disposable XDG root and kills timed-out children", async () => {
    const sandbox = await temporaryDirectory("sandbox-contract");
    try {
      const environment = createSandboxEnvironment(sandbox);
      expect([environment.HOME, environment.XDG_CONFIG_HOME, environment.XDG_DATA_HOME, environment.XDG_CACHE_HOME, environment.XDG_STATE_HOME].every((path) => path.startsWith(`${sandbox}/`))).toBe(true);
      expect(Object.keys(environment).some((key) => /^(OPENCODE|OCX)_/i.test(key))).toBe(false);
      await expect(run([process.execPath, "-e", "await Bun.sleep(100)"], environment, 1)).rejects.toThrow("timeout");
    } finally { await rm(sandbox, { recursive: true, force: true }); }
  });

  test("fails local server readiness without retaining a server", async () => {
    const missing = join(await temporaryDirectory("missing-registry"), "absent");
    await expect(serveRegistry(missing)).rejects.toThrow("did not become ready");
    await rm(join(missing, ".."), { recursive: true, force: true });
  });
});

describe("OCX output normalization", () => {
  test("requires exactly two packuments and fully rewrites their version contract", async () => {
    const root = await temporaryDirectory("ocx-output");
    try {
      await writeOcxOutput(root, { ws: packument(), "ws-overrides": packument() });
      await normalizeOcxOutput(root, "0.1.0"); await validateOutput(root, "0.1.0");
      const ws = JSON.parse(await Bun.file(join(root, "components/ws.json")).text());
      expect(ws.versions["0.1.0"]).toEqual({}); expect(ws["dist-tags"].latest).toBe("0.1.0");
      await writeOcxOutput(root, { ws: packument(), "ws-overrides": packument(), extra: packument() });
      await expect(normalizeOcxOutput(root, "0.1.0")).rejects.toThrow("exactly ws and ws-overrides");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("fails shape drift, stale builder versions, and partial rewrites", async () => {
    const root = await temporaryDirectory("ocx-drift");
    try {
      await writeOcxOutput(root, { ws: { versions: { "1.0.0": {}, "1.0.1": {} }, "dist-tags": { latest: "1.0.0" } }, "ws-overrides": packument() });
      await expect(normalizeOcxOutput(root, "0.1.0")).rejects.toThrow("packument shape");
      await writeOcxOutput(root, { ws: packument({ stale: "1.0.0" }), "ws-overrides": packument() });
      await normalizeOcxOutput(root, "0.1.0"); await expect(validateOutput(root, "0.1.0")).rejects.toThrow("Stale OCX builder version");
      await Bun.write(join(root, "components/ws.json"), JSON.stringify(packument()));
      await expect(validateOutput(root, "0.1.0")).rejects.toThrow("Normalized ws versions");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("deterministic artifact contracts", () => {
  test("requires exact sorted Pages membership and reproduces the same gzip bytes", async () => {
    const root = await temporaryDirectory("artifact-contract"); const pages = join(root, "pages");
    try {
      await mkdir(join(pages, "components", "ws", "profiles", "ws"), { recursive: true });
      for (const path of ["index.json", "release.json", "components/ws.json", "components/ws-overrides.json", "components/ws/profiles/ws/AGENTS.md", "components/ws/profiles/ws/ocx.jsonc"]) await Bun.write(join(pages, path), path);
      await deterministicArchive(pages, join(root, "one.tar.gz"), 1_700_000_000);
      await deterministicArchive(pages, join(root, "two.tar.gz"), 1_700_000_000);
      expect(sha256(new Uint8Array(await Bun.file(join(root, "one.tar.gz")).arrayBuffer()))).toBe(sha256(new Uint8Array(await Bun.file(join(root, "two.tar.gz")).arrayBuffer())));
      expect(() => assertPagePaths(["index.json", "release.json"])).toThrow("exactly");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("packages complete release assets in stable digest order", async () => {
    const root = await temporaryDirectory("package-contract"); const pages = join(root, "pages"); const evidence = join(root, "evidence.json");
    try {
      await mkdir(join(pages, "components", "ws", "profiles", "ws"), { recursive: true });
      for (const path of ["index.json", "components/ws.json", "components/ws-overrides.json", "components/ws/profiles/ws/AGENTS.md", "components/ws/profiles/ws/ocx.jsonc"]) await Bun.write(join(pages, path), path);
      await Bun.write(evidence, JSON.stringify(validEvidence()));
      const arguments_ = ["--version", "0.1.0", "--tag", "v0.1.0", "--commit", commit, "--tagger-epoch", "1700000000", "--pages", pages, "--evidence", evidence];
      await runScript("scripts/package-release.ts", [...arguments_, "--out-dir", join(root, "one")]);
      await runScript("scripts/package-release.ts", [...arguments_, "--out-dir", join(root, "two")]);
      const archive = "ocx-workspace-profile-v0.1.0.tar.gz";
      expect(sha256(new Uint8Array(await Bun.file(join(root, "one", archive)).arrayBuffer()))).toBe(sha256(new Uint8Array(await Bun.file(join(root, "two", archive)).arrayBuffer())));
      const checksums = (await Bun.file(join(root, "one", "SHA256SUMS")).text()).trim().split("\n");
      expect(checksums.map((line) => line.split("  ")[1])).toEqual([archive, "provenance.json", "receipt.jsonc"]);
       const bundle = JSON.parse(await Bun.file(join(root, "one", "release-bundle.json")).text());
       expect(bundle.assets.map((asset: { name: string }) => asset.name)).toEqual([archive, "provenance.json", "receipt.jsonc", "SHA256SUMS"]);
       expect(bundle.assets.map((asset: { path: string }) => asset.path)).toEqual([archive, "provenance.json", "receipt.jsonc", "SHA256SUMS"]);
      await runScript("scripts/verify-release.ts", ["bundle", "--archive", join(root, "one", archive), "--provenance", join(root, "one", "provenance.json"), "--receipt", join(root, "one", "receipt.jsonc"), "--checksums", join(root, "one", "SHA256SUMS"), "--expected-tag", "v0.1.0", "--extract-to", join(root, "extracted")]);
      await expect(runScript("scripts/verify-release.ts", ["bundle", "--archive", join(root, "one", archive), "--provenance", join(root, "one", "provenance.json"), "--receipt", join(root, "one", "receipt.jsonc"), "--checksums", join(root, "one", "SHA256SUMS"), "--expected-tag", "v0.1.1", "--extract-to", join(root, "wrong-tag")])).rejects.toThrow("filename");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects every unsafe archive entry and provenance path drift before extraction", () => {
    for (const entry of [tarEntry("/absolute", "x"), tarEntry("../parent", "x"), tarEntry("link", "x", "2"), tarEntry("hard", "x", "1"), tarEntry("device", "x", "3"), tarEntry("other", "x", "7"), tarEntry("mode", "x", "0", 0o755)]) expect(() => parseTar(archive(entry))).toThrow();
    const nonDeterministicGzip = archive(tarEntry("entry", "x")); nonDeterministicGzip[9] = 255;
    expect(() => parseTar(nonDeterministicGzip)).toThrow("gzip header");
    expect(() => parseTar(archive(tarEntry("same", "x"), tarEntry("same", "y")))).toThrow("Unsafe or non-deterministic tar entry");
    const base = { schemaVersion: 1, tag: "v0.1.0", version: "0.1.0", commit, taggerEpoch: 1_700_000_000, archiveSha256: "a".repeat(64), evidence: validEvidence(), files: [{ path: "components/ws/profiles/ws/AGENTS.md", sha256: "a".repeat(64), mode: 0o644 }, { path: "components/ws/profiles/ws/ocx.jsonc", sha256: "a".repeat(64), mode: 0o644 }, { path: "components/ws-overrides.json", sha256: "a".repeat(64), mode: 0o644 }, { path: "components/ws.json", sha256: "a".repeat(64), mode: 0o644 }, { path: "index.json", sha256: "a".repeat(64), mode: 0o644 }, { path: "release.json", sha256: "a".repeat(64), mode: 0o644 }] };
    expect(parseProvenance(base).files).toHaveLength(6);
    expect(() => parseProvenance({ ...base, files: base.files.slice(1) })).toThrow("missing, extra, or out of order");
    expect(() => parseProvenance({ ...base, files: [...base.files, { path: "extra", sha256: "a".repeat(64), mode: 0o644 }] })).toThrow("missing, extra, or out of order");
  });
});
