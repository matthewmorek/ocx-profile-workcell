import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fail, parseArguments, parseVersion, promoteDirectory, readJsonc, repositoryRoot, requiredArgument, temporaryDirectory } from "./common";

type Registry = { version?: unknown; components?: unknown[] };
export const expectedComponents = ["ws", "ws-overrides"] as const;

async function main(): Promise<void> {
  const arguments_ = parseArguments(Bun.argv.slice(2), ["--version", "--out"]);
  const version = parseVersion(requiredArgument(arguments_, "--version"));
  const output = requiredArgument(arguments_, "--out");
  const registry = await readJsonc<Registry>(join(repositoryRoot, "registry.jsonc"));
  if (registry.version !== version) fail(`registry.jsonc version ${String(registry.version)} does not equal requested ${version}.`);
  if (!Array.isArray(registry.components)) fail("registry.jsonc components must be an array.");
  const components = registry.components.map((component) => (component as { name?: unknown }).name).sort();
  if (JSON.stringify(components) !== JSON.stringify(expectedComponents)) fail("Registry source must contain exactly ws and ws-overrides.");
  const stagedParent = await temporaryDirectory("ocx-build");
  const stagedOutput = join(stagedParent, "registry");
  try {
    const executable = process.env.OCX_BIN ?? "ocx";
    const child = Bun.spawn([executable, "build", repositoryRoot, "--out", stagedOutput], { stdout: "inherit", stderr: "inherit" });
    if ((await child.exited) !== 0) fail("OCX registry build failed.");
    await rm(join(stagedOutput, ".well-known"), { recursive: true, force: true });
    await normalizeOcxOutput(stagedOutput, version);
    await validateOutput(stagedOutput, version);
    await mkdir(join(output, ".."), { recursive: true });
    await promoteDirectory(stagedOutput, output);
  } finally { await rm(stagedParent, { recursive: true, force: true }); }
}

export async function normalizeOcxOutput(directory: string, version: string): Promise<void> {
  const index = await readJsonc<{ version?: unknown }>(join(directory, "index.json"));
  if (typeof index.version !== "string") fail("OCX output index.json has no version.");
  const componentDirectory = join(directory, "components");
  const names = (await readdir(componentDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const expectedNames = expectedComponents.map((component) => `${component}.json`).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) fail("OCX output must contain exactly ws and ws-overrides packuments.");
  index.version = version;
  await Bun.write(join(directory, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  for (const component of expectedComponents) {
    const path = join(directory, "components", `${component}.json`);
    const packument = await readJsonc<{ versions?: Record<string, unknown>; [key: string]: unknown }>(path);
    if (!packument.versions || typeof packument.versions !== "object" || Object.keys(packument.versions).length !== 1) fail(`Unexpected OCX packument shape for ${component}.`);
    const [builderVersion] = Object.keys(packument.versions);
    const manifest = packument.versions[builderVersion] as Record<string, unknown>;
    if (!manifest || typeof manifest !== "object" || "version" in manifest) fail(`Component manifest ${component} unexpectedly contains a version field.`);
    packument.versions = { [version]: manifest };
    const tags = packument["dist-tags"] as Record<string, unknown> | undefined;
    if (!tags || typeof tags !== "object") fail(`Packument ${component} has no dist-tags.`);
    tags.latest = version;
    await Bun.write(path, `${JSON.stringify(packument, null, 2)}\n`);
  }
}

export async function validateOutput(directory: string, version: string): Promise<void> {
  const index = await readJsonc<{ version?: unknown }>(join(directory, "index.json"));
  if (index.version !== version) fail("Normalized index version is incorrect.");
  for (const component of expectedComponents) {
    const packument = await readJsonc<{ versions?: Record<string, unknown>; "dist-tags"?: { latest?: unknown } }>(join(directory, "components", `${component}.json`));
    if (JSON.stringify(Object.keys(packument.versions ?? {})) !== JSON.stringify([version])) fail(`Normalized ${component} versions are incorrect.`);
    if (packument["dist-tags"]?.latest !== version) fail(`Normalized ${component} latest tag is incorrect.`);
    if (version !== "1.0.0" && JSON.stringify(packument).includes('"1.0.0"')) fail(`Stale OCX builder version remains in ${component}.`);
  }
}

if (import.meta.main) await main();
