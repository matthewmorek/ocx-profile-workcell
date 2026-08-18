import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fail, parseArguments, parseVersion, pathExists, requiredArgument, sha256File, writeJsonAtomic } from "./common";

async function invoke(command: string[]): Promise<void> { const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" }); if ((await child.exited) !== 0) fail(`Command failed: ${command.join(" ")}`); }
async function main(): Promise<void> {
  const arguments_ = parseArguments(Bun.argv.slice(2), ["--version", "--commit", "--work-dir"]);
  const version = parseVersion(requiredArgument(arguments_, "--version")); const commit = requiredArgument(arguments_, "--commit"); const work = requiredArgument(arguments_, "--work-dir");
  const pages = join(work, "pages"); const evidence = join(work, "install-evidence.json");
  await mkdir(work, { recursive: true });
  await invoke([process.execPath, "run", "scripts/build-registry.ts", "--version", version, "--out", pages]);
  await invoke([process.execPath, "test", "tests"]);
  await invoke([process.execPath, "run", "scripts/verify-install.ts", "--registry", pages, "--version", version, "--commit", commit, "--evidence-out", evidence]);
  if (!(await pathExists(evidence))) fail("Install verification did not create evidence.");
  await writeJsonAtomic(join(work, "validation-result.json"), { schemaVersion: 1, version, commit, pages, pagesHash: await sha256File(join(pages, "index.json")), evidence, evidenceHash: await sha256File(evidence) });
}
if (import.meta.main) await main();
