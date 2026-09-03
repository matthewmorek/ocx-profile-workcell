export type ReleaseMetadata = {
  version: string;
  tag: string;
  commit: string;
};

export type ReleaseAction = "deploy" | "noop";

const semVerPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type ParsedSemVer = {
  core: [bigint, bigint, bigint];
  prerelease: string[];
};

type ParsedReleaseMetadata = ReleaseMetadata & {
  parsedVersion: ParsedSemVer;
};

function parseSemVer(version: string, owner: string): ParsedSemVer {
  const match = semVerPattern.exec(version);
  if (!match)
    throw new Error(`${owner} version is not valid SemVer: ${version}`);

  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber === rightNumber ? 0 : leftNumber > rightNumber ? 1 : -1;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left > right ? 1 : -1;
}

function compareSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index])
      return left.core[index] > right.core[index] ? 1 : -1;
  }

  if (!left.prerelease.length || !right.prerelease.length) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length ? -1 : 1;
  }

  const sharedLength = Math.min(
    left.prerelease.length,
    right.prerelease.length,
  );
  for (let index = 0; index < sharedLength; index += 1) {
    const result = compareIdentifier(
      left.prerelease[index],
      right.prerelease[index],
    );
    if (result !== 0) return result;
  }
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length > right.prerelease.length ? 1 : -1;
}

function parseReleaseMetadata(
  value: unknown,
  owner: string,
): ParsedReleaseMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("expected a JSON object");

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.version !== "string")
    throw new Error("version must be a string");
  const parsedVersion = parseSemVer(candidate.version, owner);
  if (typeof candidate.tag !== "string" || candidate.tag.length === 0)
    throw new Error("tag must be a non-empty string");
  if (candidate.tag !== `v${candidate.version}`)
    throw new Error(`tag must equal v${candidate.version}`);
  if (
    typeof candidate.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(candidate.commit)
  )
    throw new Error("commit must be a 40-character lowercase Git object ID");

  return {
    version: candidate.version,
    tag: candidate.tag,
    commit: candidate.commit,
    parsedVersion,
  };
}

export function decideReleaseAction(
  liveValue: unknown,
  requestedValue: unknown,
): ReleaseAction {
  let live: ParsedReleaseMetadata;
  try {
    live = parseReleaseMetadata(liveValue, "Live release");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid live release metadata: ${reason}`);
  }

  let requested: ParsedReleaseMetadata;
  try {
    requested = parseReleaseMetadata(requestedValue, "Requested release");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid requested release metadata: ${reason}`);
  }

  const comparison = compareSemVer(requested.parsedVersion, live.parsedVersion);
  if (comparison < 0)
    throw new Error(
      `Target ${requested.version} is older than live ${live.version}.`,
    );
  if (comparison > 0) return "deploy";
  if (
    live.version === requested.version &&
    live.tag === requested.tag &&
    live.commit === requested.commit
  )
    return "noop";

  throw new Error(
    `Release identity conflict: live version=${live.version} tag=${live.tag} commit=${live.commit}; requested version=${requested.version} tag=${requested.tag} commit=${requested.commit}.`,
  );
}

if (import.meta.main) {
  const [livePath, version, tag, commit] = process.argv.slice(2);
  if (!livePath || !version || !tag || !commit)
    throw new Error(
      "Usage: bun run scripts/release-policy.ts LIVE_RELEASE VERSION TAG COMMIT",
    );

  let liveValue: unknown;
  try {
    liveValue = JSON.parse(await Bun.file(livePath).text());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid live release metadata: ${reason}`);
  }
  console.log(decideReleaseAction(liveValue, { version, tag, commit }));
}
