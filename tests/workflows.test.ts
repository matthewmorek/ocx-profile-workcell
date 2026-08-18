import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryRoot } from "../scripts/common";

const workflow = async (name: string) => readFile(join(repositoryRoot, ".github/workflows", name), "utf8");
const actionShas = [
  "3d3c42e5aac5ba805825da76410c181273ba90b1",
  "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "45bfe0192ca1faeb007ade9deae92b16b8254a0d",
  "fc324d3547104276b827a68afc52ff2a11cc49c9",
  "cd2ce8fcbc39b97be8ca5fce6e763baed58fa128",
];

describe("workflow supply-chain and production guards", () => {
  test("pins all declared Actions and keeps CI least-privileged", async () => {
    const ci = await workflow("ci.yml"); const release = await workflow("release.yml"); const rollback = await workflow("rollback.yml");
    for (const sha of actionShas) expect(`${ci}\n${release}\n${rollback}`).toContain(sha);
    for (const document of [ci, release, rollback]) expect(document).toContain("permissions: {}");
    expect(ci).toContain("validate-latest:\n    if: github.event_name == 'pull_request'\n    continue-on-error: true");
    expect(ci).not.toContain("pull_request_target"); expect(`${release}\n${rollback}`).toContain("cancel-in-progress: false");
    expect(release).toContain("permissions: { contents: write }");
    expect(release).toContain("permissions: { contents: read, pages: write, id-token: write }");
    expect(release).not.toContain("permissions: { contents: write, pages: write, id-token: write }");
  });

  test("uses verified immutable bytes and guarded recovery transitions", async () => {
    const release = await workflow("release.yml"); const rollback = await workflow("rollback.yml"); const bootstrap = await readFile(join(repositoryRoot, ".github/actions/bootstrap-pinned/action.yml"), "utf8");
    expect(release).toContain("git cat-file -t \"$GITHUB_REF\")\" = tag");
    expect(release).toContain("verify:release -- bundle"); expect(release).toContain("Create or verify exact immutable release assets");
    expect(release).toContain("steps.deployment-attempt.outputs.attempted == 'true' && steps.live-verification.outputs.verified != 'true' && needs.prepare-production.outputs.kind == 'release-with-recovery'");
    expect(rollback).toContain("inputs.confirm == 'ROLLBACK'"); expect(rollback).toContain("verify:release -- bundle");
    for (const checksum of ["db17588a4aea8804856825d4bead3f05e1f37276ca606f37e369b4f72f35d3fb", "1bdcb928da5d938fad787fc046e47068a87c8a2987466bba014294264efdc4b8", "9667289c143d1fbdd440055af4041bb432f44b07ddf0aef048a8c7f2f7c65e2d"]) expect(bootstrap).toContain(checksum);
    expect(bootstrap).toContain("/usr/bin/shasum -a 256 -c -");
  });
});
