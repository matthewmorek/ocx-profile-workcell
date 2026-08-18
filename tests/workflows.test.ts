import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryRoot } from "../scripts/common";
import { releaseApiCommands } from "../scripts/release-api";
import { shouldRestoreDeployment } from "../scripts/release-state";

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };
type YamlObject = { [key: string]: YamlValue };
const actionShas = ["3d3c42e5aac5ba805825da76410c181273ba90b1", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", "45bfe0192ca1faeb007ade9deae92b16b8254a0d", "fc324d3547104276b827a68afc52ff2a11cc49c9", "cd2ce8fcbc39b97be8ca5fce6e763baed58fa128"];
const rubyYamlParser = [
  'require "json"',
  'require "psych"',
  'document = Psych.safe_load(STDIN.read, aliases: false)',
  'if document.is_a?(Hash) && document.key?(true)',
  '  raise "ambiguous root on key" if document.key?("on")',
  '  document["on"] = document.delete(true)',
  'end',
  'puts JSON.generate(document)',
].join("\n");

async function workflow(name: string): Promise<string> { return readFile(join(repositoryRoot, ".github/workflows", name), "utf8"); }
async function parseYaml(source: string): Promise<YamlObject> {
  const child = Bun.spawn(["/usr/bin/ruby", "-e", rubyYamlParser], { stdin: new Blob([source]), stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`Ruby Psych rejected YAML: ${stderr}`);
  const document = JSON.parse(stdout);
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("YAML document must be an object.");
  return document as YamlObject;
}
async function yamlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => entry.isDirectory() ? yamlFiles(join(directory, entry.name)) : /\.ya?ml$/.test(entry.name) ? [join(directory, entry.name)] : []));
  return nested.flat();
}
function object(value: YamlValue | undefined, location: string): YamlObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object.`);
  return value;
}
function steps(job: YamlObject): YamlObject[] {
  const values = job.steps;
  if (!Array.isArray(values) || values.some((step) => !step || typeof step !== "object" || Array.isArray(step))) throw new Error("Workflow job steps must be objects.");
  return values as YamlObject[];
}
function stepById(job: YamlObject, id: string): YamlObject {
  const step = steps(job).find((candidate) => candidate.id === id);
  if (!step) throw new Error(`Workflow step ${id} is missing.`);
  return step;
}
function stepByName(job: YamlObject, name: string): YamlObject {
  const step = steps(job).find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Workflow step ${name} is missing.`);
  return step;
}
function requiredJobs(job: YamlObject): string[] {
  const needs = job.needs;
  return typeof needs === "string" ? [needs] : Array.isArray(needs) && needs.every((value) => typeof value === "string") ? needs as string[] : [];
}
function jobsWithContentsWrite(jobs: YamlObject): string[] {
  return Object.entries(jobs).flatMap(([name, value]) => {
    const job = object(value, `recovery job ${name}`);
    const permissions = object(job.permissions, `recovery job ${name} permissions`);
    return permissions.contents === "write" ? [name] : [];
  });
}
function recoveryInspectionPhases(job: YamlObject): string[] {
  return steps(job).flatMap((step) => typeof step.run === "string" && step.run.includes("release:api -- inspect-first-publication-recovery") ? [...step.run.matchAll(/--phase ([a-z-]+)/g)].map((match) => match[1]!) : []);
}
function workflowReleaseApiCommands(jobs: YamlObject): string[] {
  return Object.values(jobs).flatMap((job) => steps(object(job, "workflow job")).flatMap((step) => typeof step.run === "string" ? [...step.run.matchAll(/\bbun\s+run\s+release:api\s+--\s+([a-z-]+)/g)].map((match) => match[1]!) : []));
}

describe("workflow supply-chain and production guards", () => {
  test("Ruby Psych parses every workflow and composite action, safely restoring the YAML 1.1 on key", async () => {
    const files = await yamlFiles(join(repositoryRoot, ".github"));
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const parsed = await parseYaml(await readFile(path, "utf8"));
      expect(typeof parsed).toBe("object");
      if (path.includes("/workflows/")) expect(parsed.on).toBeDefined();
    }
  });

  test("uses only implemented release API commands in normal and recovery workflows", async () => {
    for (const name of ["release.yml", "recover-release.yml"]) {
      const commands = workflowReleaseApiCommands(object((await parseYaml(await workflow(name))).jobs, `${name}.jobs`));
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) expect(releaseApiCommands).toContain(command);
    }
  });

  test("models CI jobs semantically, including pinned and advisory validation contracts", async () => {
    const ci = await parseYaml(await workflow("ci.yml")); const jobs = object(ci.jobs, "ci.jobs");
    const pinned = object(jobs["validate-pinned"], "validate-pinned"); const latest = object(jobs["validate-latest"], "validate-latest");
    expect(stepByName(pinned, "Assert trusted runner and bootstrap pinned tools").uses).toBe("./.github/actions/bootstrap-pinned");
    expect(String(stepByName(pinned, "Assert trusted runner and bootstrap pinned tools").uses)).toBe("./.github/actions/bootstrap-pinned");
    expect(String(stepByName(pinned, "Assert trusted runner and bootstrap pinned tools").name)).toBe("Assert trusted runner and bootstrap pinned tools");
    expect(String(steps(pinned).find((step) => String(step.run).includes("bun run validate"))?.run)).toContain("--validation-mode pinned --expected-ocx-version 2.0.14 --expected-opencode-version 1.17.15");
    expect(latest.if).toBe("github.event_name == 'pull_request'"); expect(latest["continue-on-error"]).toBe(true);
    expect(String(stepByName(latest, "Log discovered tool versions and run the full advisory validation contract").run)).toContain("--validation-mode advisory");
    expect(String(stepByName(latest, "Log discovered tool versions and run the full advisory validation contract").run)).not.toContain("--expected-ocx-version");
    expect(ci).not.toHaveProperty("pull_request_target"); expect(ci.permissions).toEqual({});
  });

  test("models release artifact paths, outputs, conditions, and release-to-rollback identity flow", async () => {
    const release = await parseYaml(await workflow("release.yml")); const rollback = await parseYaml(await workflow("rollback.yml")); const jobs = object(release.jobs, "release.jobs");
    const packaged = object(jobs["verify-and-package"], "verify-and-package"); const prepared = object(jobs["prepare-production"], "prepare-production"); const deployed = object(jobs["deploy-pages"], "deploy-pages"); const published = object(jobs["publish-release"], "publish-release");
    expect(stepByName(packaged, "Validate annotated tag and construct immutable bundle").run).toContain("--expected-tag \"$GITHUB_REF_NAME\"");
    expect(object(prepared.outputs, "prepare-production.outputs")).toEqual({ kind: "${{ steps.decision.outputs.kind }}", recovery_tag: "${{ steps.recovery.outputs.tag }}", recovery_available: "${{ steps.recovery.outputs.available }}" });
    expect(stepByName(prepared, "Create or verify exact immutable release assets").run).toContain("--bundle bundle/release-bundle.json");
    expect(stepById(deployed, "restore-preflight").if).toBe("always() && steps.deployment-attempt.outputs.attempted == 'true' && steps.live-verification.outputs.verified != 'true' && needs.prepare-production.outputs.recovery_available == 'true'");
    expect(object(stepById(deployed, "deploy-pages").with, "deploy-pages.with").artifact_name).toBe("target-pages-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(Array.isArray(published.needs) ? published.needs : []).toEqual(["prepare-production", "deploy-pages"]);
    const rollbackJob = object(object(rollback.jobs, "rollback.jobs").rollback, "rollback job");
    expect(rollbackJob.if).toBe("inputs.confirm == 'ROLLBACK'");
    expect(String(stepByName(rollbackJob, "Download and verify immutable release bytes").run)).toContain("--expected-tag \"$RELEASE_TAG\"");
  });

  test("models failed-tag recovery as an exact cross-run first-publication state machine", async () => {
    const recoverySource = await workflow("recover-release.yml");
    const recovery = await parseYaml(recoverySource); const jobs = object(recovery.jobs, "recovery.jobs");
    const preflight = object(jobs["preflight-recovery"], "preflight-recovery"); const prepared = object(jobs["prepare-exact-draft"], "prepare-exact-draft"); const deployed = object(jobs["deploy-exact-pages"], "deploy-exact-pages"); const published = object(jobs["publish-exact-release"], "publish-exact-release");
    const inputs = object(object(recovery.on, "recovery.on")["workflow_dispatch"], "workflow_dispatch").inputs;
    expect(object(inputs, "workflow_dispatch.inputs").confirm).toEqual({ description: "Type PUBLISH_EXACT", required: true, type: "string" });
    for (const input of ["source_run_id", "source_run_attempt", "artifact_id", "artifact_digest", "tag_object_sha"]) expect(object(inputs, "workflow_dispatch.inputs")[input]).toMatchObject({ required: true, type: "string" });
    expect(preflight.if).toBe("inputs.confirm == 'PUBLISH_EXACT'");
    expect(recovery.concurrency).toEqual({ group: "pages-production", "cancel-in-progress": false });
    expect(preflight.permissions).toEqual({ actions: "read", contents: "read" });
    expect(object(preflight.outputs, "preflight-recovery.outputs")).toEqual({ source_commit: "${{ steps.identity.outputs.source_commit }}", tag_object_sha: "${{ steps.identity.outputs.tag_object_sha }}" });
    expect(prepared.permissions).toEqual({ actions: "read", contents: "write" });
    // GitHub only lists drafts to principals with push access. This pre-deploy
    // job must re-list and hash that exact draft immediately before deployment.
    // Its Pages authority remains the existing narrowly scoped permission.
    expect(deployed.permissions).toEqual({ actions: "read", contents: "write", pages: "write", "id-token": "write" });
    expect(published.permissions).toEqual({ actions: "read", contents: "write" });
    expect(jobsWithContentsWrite(jobs)).toEqual(["prepare-exact-draft", "deploy-exact-pages", "publish-exact-release"]);
    expect(recoveryInspectionPhases(preflight)).toEqual([]);
    expect(recoveryInspectionPhases(prepared)).toEqual(["pre-draft"]);
    expect(recoveryInspectionPhases(deployed)).toEqual(["pre-deploy"]);
    expect(recoveryInspectionPhases(published)).toEqual(["pre-publish"]);
    expect(String(stepByName(preflight, "Bind immutable source identity to the failed release attempt").run)).toContain('actions/runs/$SOURCE_RUN_ID');
    expect(String(stepByName(preflight, "Bind immutable source identity to the failed release attempt").run)).toContain('actions/runs/$SOURCE_RUN_ID/attempts/$SOURCE_RUN_ATTEMPT');
    expect(String(stepByName(preflight, "Bind immutable source identity to the failed release attempt").run)).toContain("--source-run-attempt");
    expect(String(stepByName(preflight, "Bind immutable source identity to the failed release attempt").run)).toContain("--artifact-digest");
    const downloads = [preflight, prepared, deployed, published].map((job) => steps(job).find((step) => step.uses === "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"));
    expect(downloads).toHaveLength(4);
    for (const download of downloads) {
      const withValues = object(download?.with, "cross-run artifact input");
      expect(withValues).toMatchObject({ "artifact-ids": "${{ inputs.artifact_id }}", path: "bundle", "github-token": "${{ github.token }}", repository: "${{ github.repository }}", "run-id": "${{ inputs.source_run_id }}" });
      expect(withValues).not.toHaveProperty("name");
    }
    expect(recoverySource).not.toContain("bun run build");
    expect(recoverySource).not.toContain("bun run package:release");
    expect(prepared.needs).toBe("preflight-recovery"); expect(deployed.needs).toEqual(["preflight-recovery", "prepare-exact-draft"]); expect(published.needs).toEqual(["preflight-recovery", "prepare-exact-draft", "deploy-exact-pages"]);
    for (const job of [preflight, prepared, deployed, published]) {
      const dependencies = requiredJobs(job);
      for (const match of JSON.stringify(job).matchAll(/needs\.([a-z0-9-]+)\.outputs/g)) expect(dependencies).toContain(match[1]);
    }
    const deployIndex = steps(deployed).findIndex((step) => step.id === "deploy-pages"); const liveIndex = steps(deployed).findIndex((step) => step.id === "live-verification");
    expect(deployIndex).toBeGreaterThan(-1); expect(liveIndex).toBeGreaterThan(deployIndex);
    const preDeployStateIndex = steps(deployed).findIndex((step) => step.id === "decision"); const draftVerificationIndex = steps(deployed).findIndex((step) => step.name === "Reverify the sole exact draft immediately before Pages mutation");
    expect(draftVerificationIndex).toBeGreaterThan(preDeployStateIndex); expect(draftVerificationIndex).toBeLessThan(deployIndex);
    expect(String(stepById(deployed, "decision").run)).toContain("resume-live) printf 'deploy=false\\n' >> \"$GITHUB_OUTPUT\"");
    expect(stepById(deployed, "deploy-pages").if).toBe("steps.decision.outputs.deploy == 'true'");
    expect(stepById(deployed, "live-verification").if).toBe("steps.decision.outputs.deploy == 'false' || steps.deploy-pages.outcome == 'success'");
    expect(stepByName(deployed, "Fail first-publication recovery without restoration").if).toBe("always() && steps.live-verification.outputs.verified != 'true'");
    expect(recoverySource).not.toContain("restore-");
    expect(String(stepByName(published, "Reassert tag, exact draft, live Pages, and pre-publish state").run)).toContain("release:api -- publish-exact");
    expect(String(stepByName(published, "Reassert tag, exact draft, live Pages, and pre-publish state").run)).toContain("--expected-release-id");
    expect(stepByName(published, "Verify exact live Pages bytes after publication")).toBeDefined();
  });

  test("simulates success, failed deployment, failed live verification, and first-publication failure control flow", async () => {
    expect(shouldRestoreDeployment({ deploymentAttempted: true, liveVerified: true, recoveryAvailable: true })).toBe(false);
    expect(shouldRestoreDeployment({ deploymentAttempted: true, liveVerified: false, recoveryAvailable: true })).toBe(true);
    expect(shouldRestoreDeployment({ deploymentAttempted: true, liveVerified: false, recoveryAvailable: false })).toBe(false);
    expect(shouldRestoreDeployment({ deploymentAttempted: false, liveVerified: false, recoveryAvailable: true })).toBe(false);
    const deployed = object(object((await parseYaml(await workflow("release.yml"))).jobs, "release.jobs")["deploy-pages"], "deploy-pages");
    expect(stepByName(deployed, "Report failed first publication cleanup state")).toBeDefined();
    expect(stepByName(deployed, "Report restoration result loudly")).toBeDefined();
  });

  test("requires SHA-pinned third-party actions and checksum-pinned bootstrap binaries", async () => {
    const files = await Promise.all([workflow("ci.yml"), workflow("release.yml"), workflow("rollback.yml"), workflow("recover-release.yml"), readFile(join(repositoryRoot, ".github/actions/bootstrap-pinned/action.yml"), "utf8")]);
    for (const sha of actionShas) expect(files.join("\n")).toContain(sha);
    for (const checksum of ["db17588a4aea8804856825d4bead3f05e1f37276ca606f37e369b4f72f35d3fb", "1bdcb928da5d938fad787fc046e47068a87c8a2987466bba014294264efdc4b8", "9667289c143d1fbdd440055af4041bb432f44b07ddf0aef048a8c7f2f7c65e2d"]) expect(files.at(-1)).toContain(checksum);
  });
});
