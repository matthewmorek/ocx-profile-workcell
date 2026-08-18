import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fail, parseArguments, parseTag, parseVersion, readJsonc, requiredArgument, sha256File, sortedFiles, writeJsonAtomic } from "./common";
import { parseInstallEvidence } from "./evidence";
import { assertPagePaths } from "./package-release";

async function main(): Promise<void> {
  const arguments_ = parseArguments(Bun.argv.slice(2), ["--version", "--tag", "--commit", "--tagger-epoch", "--archive", "--pages", "--evidence", "--out"]);
  const version = parseVersion(requiredArgument(arguments_, "--version")); const tag = parseTag(requiredArgument(arguments_, "--tag"));
  if (tag.slice(1) !== version) fail("Tag and version differ.");
  const pages = requiredArgument(arguments_, "--pages"); const files = await sortedFiles(pages); assertPagePaths(files);
  const evidence = parseInstallEvidence(await readJsonc<unknown>(requiredArgument(arguments_, "--evidence")));
  const commit = requiredArgument(arguments_, "--commit");
  if (evidence.version !== version || evidence.commit !== commit) fail("Install evidence does not match the provenance version and commit.");
  const taggerEpoch = Number(requiredArgument(arguments_, "--tagger-epoch"));
  if (!Number.isSafeInteger(taggerEpoch) || taggerEpoch < 0) fail("tagger-epoch must be a non-negative integer.");
  await writeJsonAtomic(requiredArgument(arguments_, "--out"), { schemaVersion: 1, tag, version, commit, taggerEpoch, archiveSha256: await sha256File(requiredArgument(arguments_, "--archive")), evidence, files: await Promise.all(files.map(async (path) => ({ path, sha256: await sha256File(join(pages, path)), mode: (await stat(join(pages, path))).mode & 0o777 }))) });
}
if (import.meta.main) await main();
