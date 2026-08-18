import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryRoot } from "../scripts/common";
import { shouldRestoreDeployment } from "../scripts/release-state";

type WorkflowJob = Readonly<{ name: string; body: string; needs: readonly string[]; if?: string; continueOnError: boolean; outputs: readonly string[]; steps: readonly string[] }>;
const actionShas = ["3d3c42e5aac5ba805825da76410c181273ba90b1", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", "45bfe0192ca1faeb007ade9deae92b16b8254a0d", "fc324d3547104276b827a68afc52ff2a11cc49c9", "cd2ce8fcbc39b97be8ca5fce6e763baed58fa128"];

async function workflow(name: string): Promise<string> { return readFile(join(repositoryRoot, ".github/workflows", name), "utf8"); }
/** A deliberately narrow, deterministic YAML job model for the repository workflow grammar. */
function parseWorkflow(source: string): Map<string, WorkflowJob> {
  const jobs = new Map<string, WorkflowJob>();
  const jobSection = source.slice(source.indexOf("jobs:\n") + "jobs:\n".length);
  const matches = [...jobSection.matchAll(/^  ([A-Za-z][\w-]*):\n([\s\S]*?)(?=^  [A-Za-z][\w-]*:\n|(?![\s\S]))/gm)];
  for (const match of matches) {
    const body = match[2]; const name = match[1];
    const needs = (body.match(/^    needs: (.+)$/m)?.[1] ?? "").replace(/[\[\],]/g, "").split(/\s+/).filter(Boolean);
    const ifCondition = body.match(/^    if: (.+)$/m)?.[1];
    const outputs = [...body.matchAll(/^      ([\w-]+): \$\{\{ steps\.[\w-]+\.outputs\.[\w-]+ \}\}$/gm)].map((entry) => entry[1]);
    const steps = [...body.matchAll(/^      - (?:id: ([\w-]+)|name: (.+)|uses: (.+)|run: (.+))$/gm)].map((entry) => entry.slice(1).find(Boolean)!);
    jobs.set(name, { name, body, needs, if: ifCondition, continueOnError: /^    continue-on-error: true$/m.test(body), outputs, steps });
  }
  return jobs;
}

describe("workflow supply-chain and production guards", () => {
  test("models CI jobs semantically, including the advisory current-tool validation lane", async () => {
    const ci = await workflow("ci.yml"); const jobs = parseWorkflow(ci); const pinned = jobs.get("validate-pinned"); const latest = jobs.get("validate-latest");
    expect(pinned?.steps).toContain("Assert trusted runner and bootstrap pinned tools");
    expect(pinned?.body).toContain("name: validation"); expect(pinned?.body).toContain("if: always()");
    expect(latest?.if).toBe("github.event_name == 'pull_request'"); expect(latest?.continueOnError).toBe(true);
    expect(latest?.body).not.toContain("./.github/actions/bootstrap-pinned");
    expect(latest?.body).toContain("/releases/latest"); expect(latest?.body).toContain("bun run validate --");
    expect(latest?.body).toContain('"$OCX_BIN" --version'); expect(latest?.body).toContain('"$OPENCODE_BIN" --version');
    expect(ci).not.toContain("pull_request_target"); expect(ci).toContain("permissions: {}");
  });

  test("models release artifact paths, outputs, and release-to-rollback identity flow", async () => {
    const release = await workflow("release.yml"); const rollback = await workflow("rollback.yml"); const jobs = parseWorkflow(release);
    const packaged = jobs.get("verify-and-package"); const prepared = jobs.get("prepare-production"); const deployed = jobs.get("deploy-pages"); const published = jobs.get("publish-release");
    expect(packaged?.body).toContain("name: target-release-bundle"); expect(packaged?.body).toContain("--expected-tag \"$GITHUB_REF_NAME\"");
    expect(prepared?.needs).toEqual(["verify-and-package"]); expect(prepared?.outputs).toEqual(["kind", "recovery_tag", "recovery_available"]);
    expect(prepared?.body).toContain("name: verified-recovery-release-bundle"); expect(prepared?.body).toContain("path: recovery");
    expect(deployed?.needs).toEqual(["prepare-production"]); expect(deployed?.body).toContain("name: target-pages-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(deployed?.body).toContain("artifact_name: target-pages-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(deployed?.body).toContain("if: always() && steps.deployment-attempt.outputs.attempted == 'true'");
    expect(deployed?.body).toContain("name: recovery-pages-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(published?.needs).toEqual(["prepare-production", "deploy-pages"]); expect(published?.body).toContain("ensure-draft");
    expect(rollback).toContain("inputs.confirm == 'ROLLBACK'"); expect(rollback).toContain("--expected-tag \"$RELEASE_TAG\""); expect(rollback).toContain("--expected-tag \"${{ inputs.tag }}\"");
  });

  test("simulates success, failed deployment, failed live verification, and first-publication failure control flow", async () => {
    expect(shouldRestoreDeployment({ deploymentAttempted: true, liveVerified: true, recoveryAvailable: true })).toBe(false);
    expect(shouldRestoreDeployment({ deploymentAttempted: true, liveVerified: false, recoveryAvailable: true })).toBe(true);
    expect(shouldRestoreDeployment({ deploymentAttempted: true, liveVerified: false, recoveryAvailable: false })).toBe(false);
    expect(shouldRestoreDeployment({ deploymentAttempted: false, liveVerified: false, recoveryAvailable: true })).toBe(false);
    const release = await workflow("release.yml");
    expect(release).toContain("Report failed first publication cleanup state"); expect(release).toContain("Report restoration result loudly");
  });

  test("requires SHA-pinned third-party actions and checksum-pinned bootstrap binaries", async () => {
    const files = await Promise.all([workflow("ci.yml"), workflow("release.yml"), workflow("rollback.yml"), readFile(join(repositoryRoot, ".github/actions/bootstrap-pinned/action.yml"), "utf8")]);
    for (const sha of actionShas) expect(files.join("\n")).toContain(sha);
    for (const checksum of ["db17588a4aea8804856825d4bead3f05e1f37276ca606f37e369b4f72f35d3fb", "1bdcb928da5d938fad787fc046e47068a87c8a2987466bba014294264efdc4b8", "9667289c143d1fbdd440055af4041bb432f44b07ddf0aef048a8c7f2f7c65e2d"]) expect(files.at(-1)).toContain(checksum);
  });
});
