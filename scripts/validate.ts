import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fail, parseArguments, parseVersion, pathExists, requiredArgument, sha256File, writeJsonAtomic } from "./common";

const runtime = process.execPath;
async function invoke(command: string[]): Promise<void> { const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" }); if ((await child.exited) !== 0) fail(`Command failed: ${command.join(" ")}`); }
function validationArguments(mode: string, expectedOcxVersion: string | undefined, expectedOpenCodeVersion: string | undefined): string[] {
  if (mode === "advisory") {
    if (expectedOcxVersion !== undefined || expectedOpenCodeVersion !== undefined) fail("Advisory validation must not receive expected tool versions.");
    return ["--validation-mode", mode];
  }
  if (mode !== "pinned" || expectedOcxVersion !== "2.0.14" || expectedOpenCodeVersion !== "1.17.15") fail("Pinned validation requires OCX 2.0.14 and OpenCode 1.17.15.");
  return ["--validation-mode", mode, "--expected-ocx-version", expectedOcxVersion, "--expected-opencode-version", expectedOpenCodeVersion];
}
async function main(): Promise<void> {
  const arguments_ = parseArguments(Bun.argv.slice(2), ["--version", "--commit", "--work-dir", "--validation-mode", "--expected-ocx-version", "--expected-opencode-version"]);
  const version = parseVersion(requiredArgument(arguments_, "--version")); const commit = requiredArgument(arguments_, "--commit"); const work = requiredArgument(arguments_, "--work-dir");
  const pages = join(work, "pages"); const evidence = join(work, "install-evidence.json");
  const validationMode = requiredArgument(arguments_, "--validation-mode");
  const expectedOcxVersion = arguments_.get("--expected-ocx-version");
  const expectedOpenCodeVersion = arguments_.get("--expected-opencode-version");
  const installValidationArguments = validationArguments(validationMode, expectedOcxVersion, expectedOpenCodeVersion);
  await mkdir(work, { recursive: true });
  await invoke([runtime, "run", "scripts/build-registry.ts", "--version", version, "--out", pages]);
  await invoke([runtime, "test", "tests"]);
  await invoke([runtime, "run", "scripts/verify-install.ts", "--registry", pages, "--version", version, "--commit", commit, "--evidence-out", evidence, "--diagnostics-dir", join(work, "install-diagnostics"), ...installValidationArguments]);
  if (!(await pathExists(evidence))) fail("Install verification did not create evidence.");
  await writeJsonAtomic(join(work, "validation-result.json"), { schemaVersion: 1, version, commit, validationMode, expectedToolVersions: validationMode === "pinned" ? { ocx: expectedOcxVersion, opencode: expectedOpenCodeVersion } : null, pages, pagesHash: await sha256File(join(pages, "index.json")), evidence, evidenceHash: await sha256File(evidence) });
}
if (import.meta.main) await main();
