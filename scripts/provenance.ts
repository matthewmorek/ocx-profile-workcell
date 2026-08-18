import { chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArguments, parseTag, parseVersion, readJsonc, requiredArgument, sha256File, sortedFiles, writeJsonAtomic } from "./common";

async function main(): Promise<void> {
  const arguments_ = parseArguments(Bun.argv.slice(2), ["--version", "--tag", "--commit", "--archive", "--pages", "--evidence", "--out"]);
  const version = parseVersion(requiredArgument(arguments_, "--version")); const tag = parseTag(requiredArgument(arguments_, "--tag"));
  if (tag.slice(1) !== version) throw new Error("Tag and version differ.");
  const pages = requiredArgument(arguments_, "--pages"); const files = await sortedFiles(pages);
  const evidence = await readJsonc<unknown>(requiredArgument(arguments_, "--evidence"));
  await writeJsonAtomic(requiredArgument(arguments_, "--out"), { schemaVersion: 1, tag, version, commit: requiredArgument(arguments_, "--commit"), archiveSha256: await sha256File(requiredArgument(arguments_, "--archive")), evidence, files: await Promise.all(files.map(async (path) => ({ path, sha256: await sha256File(join(pages, path)), mode: (await stat(join(pages, path))).mode & 0o777 }))) });
}
await main();
