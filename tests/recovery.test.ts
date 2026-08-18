import { describe, expect, test } from "bun:test";
import { assertRecoverySource, assertRecoveryTag } from "../scripts/recovery";

const commit = "a".repeat(40);
const tagObjectSha = "b".repeat(40);
const artifactDigest = `sha256:${"c".repeat(64)}`;
const evidence = {
  schemaVersion: 1, version: "0.1.0", commit, rootProfile: { source: "matthewmorek/ws", installedName: "ws" },
  resolvedDependencyComponents: [{ identifier: "kdco/workspace", revision: `sha256:${"a".repeat(64)}`, sha256: "a".repeat(64) }, { identifier: "matthewmorek/ws-overrides", revision: `sha256:${"a".repeat(64)}`, sha256: "a".repeat(64) }],
  assertions: { install: true }, receipt: { version: 1, root: "<redacted-path>", installed: { [`registry::kdco/workspace@sha256:${"a".repeat(64)}`]: { registryName: "kdco", name: "workspace", revision: `sha256:${"a".repeat(64)}`, hash: "a".repeat(64) }, [`registry::matthewmorek/ws-overrides@sha256:${"a".repeat(64)}`]: { registryName: "matthewmorek", name: "ws-overrides", revision: `sha256:${"a".repeat(64)}`, hash: "a".repeat(64) } } },
  validation: { mode: "pinned", expectedToolVersions: { ocx: "2.0.14", opencode: "1.17.15" }, discoveredToolVersions: { ocx: "2.0.14", opencode: "1.17.15" } },
};
const provenance = { schemaVersion: 1, tag: "v0.1.0", version: "0.1.0", commit, taggerEpoch: 1_700_000_000, archiveSha256: "d".repeat(64), evidence, files: ["components/ws/profiles/ws/AGENTS.md", "components/ws/profiles/ws/ocx.jsonc", "components/ws-overrides.json", "components/ws.json", "index.json", "release.json"].map((path) => ({ path, sha256: "e".repeat(64), mode: 0o644 })) };
const run = { id: 17, run_attempt: 3, status: "completed", conclusion: "failure", event: "push", path: ".github/workflows/release.yml", head_branch: "v0.1.0", head_sha: commit, repository: { full_name: "owner/repository" } };
const artifact = { id: 29, name: "target-release-bundle", expired: false, digest: artifactDigest, workflow_run: { id: 17 } };
const source = (overrides: Record<string, unknown> = {}) => ({ run, artifactPages: [{ artifacts: [artifact] }], artifact, repository: "owner/repository", tag: "v0.1.0", commit, sourceRunId: "17", sourceRunAttempt: "3", artifactId: "29", artifactDigest, ...overrides });
const remoteTag = (referenceSha = tagObjectSha, objectSha = tagObjectSha) => ({ reference: { object: { type: "tag", sha: referenceSha } }, tag: { sha: objectSha, tagger: { date: "2023-11-14T22:13:20Z" }, object: { type: "commit", sha: commit } }, provenance, tagObjectSha, commit });

describe("exact recovery identity guards", () => {
  test("rejects a successful source run and mismatched attempt", () => {
    expect(() => assertRecoverySource(source({ run: { ...run, conclusion: "success" } }))).toThrow("conclusion failure");
    expect(() => assertRecoverySource(source({ sourceRunAttempt: "2" }))).toThrow("attempt");
  });

  test("rejects duplicate artifact names and ID or digest drift", () => {
    expect(() => assertRecoverySource(source({ artifactPages: [{ artifacts: [artifact, { ...artifact, id: 30 }] }] }))).toThrow("exactly one");
    expect(() => assertRecoverySource(source({ artifactId: "30" }))).toThrow("ID, expiry state, or digest");
    expect(() => assertRecoverySource(source({ artifactDigest: `sha256:${"f".repeat(64)}` }))).toThrow("ID, expiry state, or digest");
    expect(() => assertRecoverySource(source({ artifact: { ...artifact, workflow_run: { id: 18 } } }))).toThrow("does not belong");
  });

  test("rejects tag replacement to the same commit and movement after preflight", () => {
    assertRecoveryTag(remoteTag());
    expect(() => assertRecoveryTag(remoteTag("f".repeat(40), "f".repeat(40)))).toThrow("tag object SHA");
    expect(() => assertRecoveryTag(remoteTag("f".repeat(40)))).toThrow("tag object SHA");
  });
});
