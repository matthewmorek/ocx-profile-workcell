import { fail, parseArguments, parseTag, readJsonc, requiredArgument } from "./common";
import { parseProvenance } from "./verify-release";

type SourceRun = Readonly<{ id: number; run_attempt: number; status: string; conclusion: string | null; event: string; path: string; head_branch: string; head_sha: string; repository: Readonly<{ full_name: string }> }>;
type Artifact = Readonly<{ id: number; name: string; expired: boolean; digest: string; workflow_run?: Readonly<{ id: number }> }>;
type TagReference = Readonly<{ object: Readonly<{ sha: string; type: string }> }>;
type AnnotatedTag = Readonly<{ sha: string; tagger: Readonly<{ date: string }>; object: Readonly<{ sha: string; type: string }> }>;

function parsePositiveInteger(value: string, name: string): number {
  if (!/^[1-9]\d*$/.test(value)) fail(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${name} must be a safe integer.`);
  return parsed;
}

function parseSha(value: string, name: string): string {
  if (!/^[a-f0-9]{40}$/i.test(value)) fail(`${name} must be a 40-character Git SHA.`);
  return value.toLowerCase();
}

function parseDigest(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) fail("artifact-digest must be a SHA-256 digest.");
  return value;
}

function sourceRun(value: unknown): SourceRun {
  if (!value || typeof value !== "object") fail("Source workflow run is malformed.");
  const run = value as Record<string, unknown>;
  const repository = run.repository;
  if (!repository || typeof repository !== "object" || typeof (repository as Record<string, unknown>).full_name !== "string") fail("Source workflow run repository is malformed.");
  if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) || typeof run.status !== "string" || (typeof run.conclusion !== "string" && run.conclusion !== null) || typeof run.event !== "string" || typeof run.path !== "string" || typeof run.head_branch !== "string" || typeof run.head_sha !== "string") fail("Source workflow run is malformed.");
  return run as SourceRun;
}

function artifacts(value: unknown): readonly Artifact[] {
  const pages = Array.isArray(value) ? value : [value];
  const values = pages.flatMap((page) => {
    if (!page || typeof page !== "object" || !Array.isArray((page as Record<string, unknown>).artifacts)) fail("Source artifact listing is malformed.");
    return (page as Record<string, unknown>).artifacts;
  });
  return values.map((value): Artifact => {
    if (!value || typeof value !== "object") fail("Source artifact is malformed.");
    const artifact = value as Record<string, unknown>;
    const workflowRun = artifact.workflow_run;
    if (!Number.isSafeInteger(artifact.id) || typeof artifact.name !== "string" || typeof artifact.expired !== "boolean" || typeof artifact.digest !== "string" || (workflowRun !== undefined && (!workflowRun || typeof workflowRun !== "object" || !Number.isSafeInteger((workflowRun as Record<string, unknown>).id)))) fail("Source artifact is malformed.");
    return artifact as Artifact;
  });
}

export function assertRecoverySource(input: Readonly<{ run: unknown; artifactPages: unknown; artifact: unknown; repository: string; tag: string; commit: string; sourceRunId: string; sourceRunAttempt: string; artifactId: string; artifactDigest: string }>): void {
  const run = sourceRun(input.run);
  const tag = parseTag(input.tag);
  const commit = parseSha(input.commit, "source commit");
  const sourceRunId = parsePositiveInteger(input.sourceRunId, "source-run-id");
  const sourceRunAttempt = parsePositiveInteger(input.sourceRunAttempt, "source-run-attempt");
  const artifactId = parsePositiveInteger(input.artifactId, "artifact-id");
  const artifactDigest = parseDigest(input.artifactDigest);
  if (run.id !== sourceRunId || run.run_attempt !== sourceRunAttempt) fail("Source workflow run ID or attempt does not match recovery input.");
  if (run.repository.full_name !== input.repository || run.event !== "push" || run.path !== ".github/workflows/release.yml" || run.head_branch !== tag || run.head_sha.toLowerCase() !== commit) fail("Source workflow run does not match the requested release tag, workflow, repository, or commit.");
  if (run.status !== "completed" || run.conclusion !== "failure") fail("Source workflow run must be completed with conclusion failure.");
  const listedArtifacts = artifacts(input.artifactPages);
  const namedArtifacts = listedArtifacts.filter((artifact) => artifact.name === "target-release-bundle");
  if (namedArtifacts.length !== 1) fail("Source run must contain exactly one target-release-bundle artifact.");
  const artifact = namedArtifacts[0];
  if (artifact.id !== artifactId || artifact.expired || artifact.digest !== artifactDigest) fail("Recovery artifact ID, expiry state, or digest does not match recovery input.");
  const [selectedArtifact] = artifacts({ artifacts: [input.artifact] });
  if (!selectedArtifact || selectedArtifact.id !== artifact.id || selectedArtifact.name !== artifact.name || selectedArtifact.expired !== artifact.expired || selectedArtifact.digest !== artifact.digest) fail("Selected recovery artifact differs from the source run artifact.");
  if (!selectedArtifact.workflow_run || selectedArtifact.workflow_run.id !== run.id) fail("Recovery artifact does not belong to the source workflow run.");
}

function tagReference(value: unknown): TagReference {
  if (!value || typeof value !== "object") fail("Remote tag reference is malformed.");
  const reference = value as Record<string, unknown>; const object = reference.object;
  if (!object || typeof object !== "object" || typeof (object as Record<string, unknown>).sha !== "string" || typeof (object as Record<string, unknown>).type !== "string") fail("Remote tag reference is malformed.");
  return reference as TagReference;
}

function annotatedTag(value: unknown): AnnotatedTag {
  if (!value || typeof value !== "object") fail("Remote annotated tag is malformed.");
  const tag = value as Record<string, unknown>; const tagger = tag.tagger; const object = tag.object;
  if (typeof tag.sha !== "string" || !tagger || typeof tagger !== "object" || typeof (tagger as Record<string, unknown>).date !== "string" || !object || typeof object !== "object" || typeof (object as Record<string, unknown>).sha !== "string" || typeof (object as Record<string, unknown>).type !== "string") fail("Remote annotated tag is malformed.");
  return tag as AnnotatedTag;
}

export function assertRecoveryTag(input: Readonly<{ reference: unknown; tag: unknown; provenance: unknown; tagObjectSha: string; commit: string }>): void {
  const reference = tagReference(input.reference); const annotated = annotatedTag(input.tag); const provenance = parseProvenance(input.provenance);
  const tagObjectSha = parseSha(input.tagObjectSha, "tag-object-sha"); const commit = parseSha(input.commit, "source commit");
  if (reference.object.type !== "tag" || parseSha(reference.object.sha, "remote tag object") !== tagObjectSha || parseSha(annotated.sha, "remote tag object") !== tagObjectSha) fail("Remote annotated tag object no longer matches the pinned tag object SHA.");
  if (annotated.object.type !== "commit" || parseSha(annotated.object.sha, "remote tag commit") !== commit || provenance.commit.toLowerCase() !== commit) fail("Remote annotated tag commit no longer matches verified provenance.");
  const taggerEpoch = Date.parse(annotated.tagger.date) / 1000;
  if (!Number.isSafeInteger(taggerEpoch) || taggerEpoch !== provenance.taggerEpoch) fail("Remote annotated tagger epoch no longer matches verified provenance.");
}

async function main(): Promise<void> {
  const command = Bun.argv[2];
  const allowed = command === "assert-source"
    ? ["--run", "--artifacts", "--artifact", "--repository", "--tag", "--commit", "--source-run-id", "--source-run-attempt", "--artifact-id", "--artifact-digest"]
    : command === "assert-tag"
      ? ["--reference", "--tag", "--provenance", "--tag-object-sha", "--commit"]
      : [];
  const values = parseArguments(Bun.argv.slice(3), allowed);
  if (command === "assert-source") return assertRecoverySource({ run: await readJsonc(requiredArgument(values, "--run")), artifactPages: await readJsonc(requiredArgument(values, "--artifacts")), artifact: await readJsonc(requiredArgument(values, "--artifact")), repository: requiredArgument(values, "--repository"), tag: requiredArgument(values, "--tag"), commit: requiredArgument(values, "--commit"), sourceRunId: requiredArgument(values, "--source-run-id"), sourceRunAttempt: requiredArgument(values, "--source-run-attempt"), artifactId: requiredArgument(values, "--artifact-id"), artifactDigest: requiredArgument(values, "--artifact-digest") });
  if (command === "assert-tag") return assertRecoveryTag({ reference: await readJsonc(requiredArgument(values, "--reference")), tag: await readJsonc(requiredArgument(values, "--tag")), provenance: await readJsonc(requiredArgument(values, "--provenance")), tagObjectSha: requiredArgument(values, "--tag-object-sha"), commit: requiredArgument(values, "--commit") });
  fail("Expected recovery subcommand assert-source or assert-tag.");
}

if (import.meta.main) await main();
