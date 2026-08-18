import { fail, strictSemver } from "./common";

export type ReleaseManifest = Readonly<{
  schemaVersion: 1;
  tag: string;
  version: string;
  commit: string;
  releasedAt: string;
}>;

export type RemoteRelease = Readonly<{
  id: number;
  draft: boolean;
  tag_name: string;
}>;

export type ProductionDecision =
  | Readonly<{ kind: "first-publication" }>
  | Readonly<{ kind: "release-with-recovery"; recoveryTag: string }>
  | Readonly<{ kind: "resume-draft" }>
  | Readonly<{ kind: "published-noop" }>;

export function shouldRestoreDeployment(input: Readonly<{ deploymentAttempted: boolean; liveVerified: boolean; recoveryAvailable: boolean }>): boolean {
  return input.deploymentAttempted && !input.liveVerified && input.recoveryAvailable;
}

type ParsedVersion = Readonly<{ major: number; minor: number; patch: number; prerelease: readonly string[] }>;

function parseVersion(value: string): ParsedVersion | undefined {
  if (!strictSemver.test(value)) return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4]?.split(".") ?? [] };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareVersions(left: string, right: string): number | undefined {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return undefined;
  for (const key of ["major", "minor", "patch"] as const) {
    if (parsedLeft[key] !== parsedRight[key]) return parsedLeft[key] < parsedRight[key] ? -1 : 1;
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

export function parseReleaseManifest(value: unknown): ReleaseManifest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || typeof candidate.tag !== "string" || typeof candidate.version !== "string" || typeof candidate.commit !== "string" || typeof candidate.releasedAt !== "string") return undefined;
  if (candidate.tag !== `v${candidate.version}` || !parseVersion(candidate.version) || !/^[0-9a-f]{40}$/i.test(candidate.commit) || Number.isNaN(Date.parse(candidate.releasedAt)) || new Date(candidate.releasedAt).toISOString() !== candidate.releasedAt) return undefined;
  return candidate as ReleaseManifest;
}

export function parseRemoteRelease(value: unknown): RemoteRelease | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.id) || typeof candidate.draft !== "boolean" || typeof candidate.tag_name !== "string" || !Array.isArray(candidate.assets)) return undefined;
  return { id: candidate.id, draft: candidate.draft, tag_name: candidate.tag_name };
}

function manifestsAreIdentical(left: ReleaseManifest, right: ReleaseManifest): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.tag === right.tag
    && left.version === right.version
    && left.commit === right.commit
    && left.releasedAt === right.releasedAt;
}

/** Classifies trusted workflow inputs without making network or filesystem changes. */
export function classifyProductionState(input: Readonly<{
  target: ReleaseManifest;
  live: unknown | null;
  targetRelease: unknown | null;
  liveRelease: unknown | null;
}>): ProductionDecision {
  const target = parseReleaseManifest(input.target);
  if (!target) fail("Target release manifest is malformed.");
  const live = input.live === null ? undefined : parseReleaseManifest(input.live);
  if (input.live !== null && !live) fail("Live release.json is malformed.");
  const targetRelease = input.targetRelease === null ? undefined : parseRemoteRelease(input.targetRelease);
  if (input.targetRelease !== null && !targetRelease) fail("Target GitHub Release state is malformed.");
  if (targetRelease && targetRelease.tag_name !== target.tag) fail("Target GitHub Release tag is inconsistent.");
  const liveRelease = input.liveRelease === null ? undefined : parseRemoteRelease(input.liveRelease);
  if (input.liveRelease !== null && !liveRelease) fail("Live GitHub Release state is malformed.");

  if (!live) {
    if (targetRelease && !targetRelease.draft) fail("Published GitHub Release exists without a live registry.");
    if (target.version !== "0.1.0") fail("Only v0.1.0 may be the first publication.");
    return { kind: "first-publication" };
  }

  const comparison = compareVersions(live.version, target.version);
  if (comparison === undefined) fail("Live and target versions must be valid SemVer.");
  if (comparison > 0) fail("Live registry version is newer than the requested tag.");

  if (comparison < 0) {
    if (targetRelease && !targetRelease.draft) fail("A published target release cannot replace an older live registry.");
    if (!liveRelease || liveRelease.draft || liveRelease.tag_name !== live.tag) fail("Prior live registry has no consistent published recovery release.");
    return { kind: "release-with-recovery", recoveryTag: live.tag };
  }

  if (!manifestsAreIdentical(live, target)) fail("Live registry release.json differs from the requested release.");
  if (!targetRelease) fail("Live registry has no corresponding GitHub Release.");
  if (liveRelease && liveRelease.tag_name !== target.tag) fail("Live GitHub Release tag is inconsistent.");
  if (targetRelease.draft) return { kind: "resume-draft" };
  return { kind: "published-noop" };
}
