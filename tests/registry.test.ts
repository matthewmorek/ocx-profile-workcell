import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parse } from "jsonc-parser";
import { outputDirectory, promoteStagedOutput } from "../scripts/build-registry";
import { cleanupSmokeSandbox, profileLaunchArguments, profileLaunchCommand, smokeEnvironment } from "../scripts/smoke-install";

const repositoryRoot = join(import.meta.dir, "..");
const registrySource = await readFile(join(repositoryRoot, "registry.jsonc"), "utf8");
const registry = parse(registrySource) as any;
const hashes = JSON.parse(await readFile(join(repositoryRoot, "tests/fixtures/canonical-hashes.json"), "utf8")) as Record<string, string>;
const expected = JSON.parse(await readFile(join(repositoryRoot, "tests/fixtures/expected-overrides.json"), "utf8")) as any;
const continuousIntegration = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
const releaseWorkflow = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
const ws = registry.components.find((component: any) => component.name === "ws");
const overrides = registry.components.find((component: any) => component.name === "ws-overrides");
const canonicalize = (value: any): any => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) : value;
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

async function outputFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(directory, join(entry.parentPath, entry.name)).replaceAll("\\", "/")).sort();
}

async function buildOutput(): Promise<{ directory: string; remove: boolean }> {
  if (process.env.REGISTRY_DIST) return { directory: process.env.REGISTRY_DIST, remove: false };
  const directory = await mkdtemp(join(tmpdir(), "ocx-registry-test-"));
  const child = Bun.spawn([process.execPath, "run", "build", "--", "--out", directory], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`Registry build failed: ${stderr || stdout}`);
  return { directory, remove: true };
}

describe("minimal workspace registry", () => {
  test("contains exactly the ordered profile and fileless override bundle", () => {
    expect(registry.version).toBe("0.1.1");
    expect(registry.components.map((component: any) => component.name)).toEqual(["ws", "ws-overrides"]);
    expect(ws.dependencies).toEqual(["kdco/workspace", "ws-overrides"]);
    expect(ws.files).toEqual([
      { path: "profiles/ws/ocx.jsonc", target: "ocx.jsonc" },
      { path: "profiles/ws/AGENTS.md", target: "AGENTS.md" },
    ]);
    expect(overrides.files).toBeUndefined();
  });

  test("preserves the profile payload and derivative-owned overrides", async () => {
    for (const [path, digest] of Object.entries(hashes).filter(([path]) => path !== "schemaVersion")) expect(sha256(await readFile(join(repositoryRoot, path)))).toBe(digest);
    expect(parse(await readFile(join(repositoryRoot, "files/profiles/ws/ocx.jsonc"), "utf8")).registries.kdco).toEqual({ url: "https://registry.kdco.dev" });
    expect(sha256(JSON.stringify(canonicalize(overrides.opencode)))).toBe(expected.canonicalOverrideSha256);
    expect(overrides.opencode.model).toBe(expected.models.model);
    expect(overrides.opencode.small_model).toBe(expected.models.small_model);
    expect(Object.keys(overrides.opencode.mcp).sort()).toEqual(expected.mcpKeys);
    expect(overrides.opencode.plugin).toEqual(expected.plugins);
  });

  test("keeps request controls in supported agent options and excludes local artifacts", async () => {
    const expectedOptions = { plan: ["high", "low"], build: ["high", "low"], coder: ["medium", "low"], explore: ["medium", "medium"], researcher: ["medium", "medium"], scribe: ["medium", "low"], reviewer: ["high", "medium"] };
    for (const [name, [reasoningEffort, textVerbosity]] of Object.entries(expectedOptions)) {
      const agent = overrides.opencode.agent[name];
      expect(agent.options).toEqual({ reasoningEffort, textVerbosity });
      expect(agent.reasoningEffort).toBeUndefined();
      expect(agent.textVerbosity).toBeUndefined();
    }
    expect(registrySource).not.toMatch(/posthog|tuple|@latest|\/Users\/|(?:ghp_|github_pat_|phc_|sk-)/i);
    await expect(Bun.file(join(repositoryRoot, "files/profiles/ws/opencode.jsonc")).exists()).resolves.toBe(false);
  });

  test("builds the expected installable registry files", async () => {
    const output = await buildOutput();
    try {
      expect(await outputFiles(output.directory)).toEqual([
        "components/ws-overrides.json",
        "components/ws.json",
        "components/ws/profiles/ws/AGENTS.md",
        "components/ws/profiles/ws/ocx.jsonc",
        "index.json",
      ]);
      const index = JSON.parse(await Bun.file(join(output.directory, "index.json")).text());
      expect(index.version).toBe("0.1.1");
      for (const name of ["ws", "ws-overrides"]) {
        const packument = JSON.parse(await Bun.file(join(output.directory, "components", `${name}.json`)).text());
        expect(Object.keys(packument.versions)).toEqual(["0.1.1"]);
        expect(packument["dist-tags"].latest).toBe("0.1.1");
      }
    } finally {
      if (output.remove) await rm(output.directory, { recursive: true, force: true });
    }
  });
});

describe("registry build output boundary", () => {
  test("rejects current directory, repository ancestors, and filesystem root", async () => {
    await expect(outputDirectory(["--out", "."], repositoryRoot)).rejects.toThrow("current directory");
    await expect(outputDirectory(["--out", dirname(repositoryRoot)], repositoryRoot)).rejects.toThrow("repository root or one of its ancestors");
    await expect(outputDirectory(["--out", "/"], repositoryRoot)).rejects.toThrow("filesystem root");
  });

  test("permits only exact dist within a repository and preserves rejected children", async () => {
    const temporaryRepository = await mkdtemp(join(tmpdir(), "ocx-registry-repository-"));
    const temporaryOutput = await mkdtemp(join(tmpdir(), "ocx-registry-output-"));
    try {
      const documentationDirectory = join(temporaryRepository, "docs");
      const documentationFile = join(documentationDirectory, "keep.txt");
      await mkdir(documentationDirectory);
      await writeFile(documentationFile, "keep me");
      await expect(outputDirectory(["--out", "docs"], temporaryRepository, temporaryRepository)).rejects.toThrow("exact repository dist directory");
      await expect(readFile(documentationFile, "utf8")).resolves.toBe("keep me");
      await expect(outputDirectory(["--out", "future-output"], temporaryRepository, temporaryRepository)).rejects.toThrow("exact repository dist directory");
      expect(await outputDirectory(["--out", "dist"], temporaryRepository, temporaryRepository)).toBe(join(await realpath(temporaryRepository), "dist"));
      expect(await outputDirectory(["--out", temporaryOutput], repositoryRoot)).toBe(await realpath(temporaryOutput));
    } finally {
      await rm(temporaryRepository, { recursive: true, force: true });
      await rm(temporaryOutput, { recursive: true, force: true });
    }
  });

  test("rejects existing default and custom output symlinks without touching their targets", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ocx-registry-output-symlink-"));
    const externalOutput = await mkdtemp(join(tmpdir(), "ocx-registry-external-output-"));
    try {
      await writeFile(join(externalOutput, "keep.txt"), "keep me");
      await symlink(externalOutput, join(parent, "dist"), "dir");
      await expect(outputDirectory([], parent, parent)).rejects.toThrow("existing symbolic link");
      await symlink(externalOutput, join(parent, "custom"), "dir");
      await expect(outputDirectory(["--out", "custom"], parent, parent)).rejects.toThrow("existing symbolic link");
      await expect(readFile(join(externalOutput, "keep.txt"), "utf8")).resolves.toBe("keep me");
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(externalOutput, { recursive: true, force: true });
    }
  });

  test("permits only absent paths or existing directories as output", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ocx-registry-output-type-"));
    const output = join(parent, "output");
    try {
      await writeFile(output, "not a directory");
      await expect(outputDirectory(["--out", output], repositoryRoot)).rejects.toThrow("absent or an existing directory");
      expect((await lstat(output)).isFile()).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("rejects an existing FIFO output without renaming it on Unix", async () => {
    if (process.platform === "win32") return;
    const parent = await mkdtemp(join(tmpdir(), "ocx-registry-output-fifo-"));
    const output = join(parent, "output");
    try {
      const fifo = Bun.spawn(["mkfifo", output]);
      expect(await fifo.exited).toBe(0);
      expect((await lstat(output)).isFIFO()).toBe(true);
      await expect(outputDirectory(["--out", output], repositoryRoot)).rejects.toThrow("absent or an existing directory");
      await expect(promoteStagedOutput(join(parent, "staged-output"), output)).rejects.toThrow("absent or an existing directory");
      expect((await lstat(output)).isFIFO()).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("rejects a symlink alias of the current directory and an external current-directory ancestor", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ocx-registry-current-directory-"));
    const currentDirectory = join(parent, "workspace");
    const currentDirectoryAlias = join(parent, "workspace-alias");
    try {
      await mkdir(currentDirectory);
      await symlink(currentDirectory, currentDirectoryAlias, "dir");
      await expect(outputDirectory(["--out", currentDirectoryAlias], repositoryRoot)).rejects.toThrow("existing symbolic link");
      await expect(outputDirectory(["--out", parent], currentDirectory)).rejects.toThrow("current directory or one of its ancestors");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("preserves an existing output when staged-output promotion fails", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ocx-registry-promotion-"));
    const output = join(parent, "output");
    try {
      await mkdir(output);
      await writeFile(join(output, "previous.txt"), "keep me");
      await expect(promoteStagedOutput(join(parent, "missing-stage"), output)).rejects.toThrow("previous output was restored");
      await expect(readFile(join(output, "previous.txt"), "utf8")).resolves.toBe("keep me");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("preserves an existing output when the build cannot start", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ocx-registry-build-failure-"));
    const output = join(parent, "output");
    try {
      await mkdir(output);
      await writeFile(join(output, "previous.txt"), "keep me");
      const child = Bun.spawn([process.execPath, "scripts/build-registry.ts", "--out", output], {
        cwd: repositoryRoot,
        env: { ...process.env, PATH: "/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).not.toBe(0);
      await expect(readFile(join(output, "previous.txt"), "utf8")).resolves.toBe("keep me");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("pinned automation", () => {
  test("launches the installed profile through pinned local OCX and OpenCode", () => {
    expect(profileLaunchCommand).toBe("ocx");
    expect(profileLaunchArguments).toEqual(["oc", "-p", "ws", "--", "--help"]);
    const environment = smokeEnvironment({
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      OPENCODE_CONFIG: "/unexpected/config.json",
      OPENCODE_CONFIG_CONTENT: "unexpected",
      OPENCODE_CONFIG_DIR: "/unexpected/config",
      OPENCODE_AUTH_CONTENT: "unexpected",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_MCP: "1",
      OCX_PROFILE: "unexpected",
      OCX_CONTEXT: "unexpected",
      OCX_BIN: "/unexpected/opencode",
      OCX_LAUNCH_OVERRIDE: "unexpected",
    }, "/tmp/ocx-smoke");
    expect(environment).toMatchObject({
      PATH: `${join(repositoryRoot, "node_modules", ".bin")}:/usr/bin:/bin`,
      LANG: "en_US.UTF-8",
      HOME: "/tmp/ocx-smoke/home",
      XDG_CONFIG_HOME: "/tmp/ocx-smoke/config",
      XDG_DATA_HOME: "/tmp/ocx-smoke/data",
      XDG_CACHE_HOME: "/tmp/ocx-smoke/cache",
      XDG_STATE_HOME: "/tmp/ocx-smoke/state",
    });
    for (const name of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR", "OPENCODE_AUTH_CONTENT", "OPENCODE_PURE", "OPENCODE_DISABLE_MCP", "OCX_PROFILE", "OCX_CONTEXT", "OCX_BIN", "OCX_LAUNCH_OVERRIDE"]) {
      expect(environment[name]).toBeUndefined();
    }
  });

  test("cleans a smoke sandbox and stops its server", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ocx-smoke-cleanup-"));
    let stopped = false;
    try {
      await cleanupSmokeSandbox(sandbox, { stop: () => { stopped = true; } });
      expect(stopped).toBe(true);
      await expect(Bun.file(sandbox).exists()).resolves.toBe(false);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("runs the disposable installation smoke in required validation", () => {
    expect(continuousIntegration).toContain("bun run build");
    expect(continuousIntegration).toContain("REGISTRY_DIST=dist bun run test");
    expect(continuousIntegration).toContain("REGISTRY_DIST=dist bun run smoke");
    expect(releaseWorkflow).toContain("REGISTRY_DIST=dist bun run smoke");
  });

  test("guards Pages versions and compares every published registry file before creating a release", () => {
    expect(releaseWorkflow).toContain("cancel-in-progress: false");
    expect(releaseWorkflow).toContain("name: github-pages");
    expect(releaseWorkflow).toContain("url: ${{ steps.deploy-pages.outputs.page_url }}");
    expect(releaseWorkflow).toContain("- id: deploy-pages");
    expect(releaseWorkflow).toContain("git cat-file -t \"$GITHUB_REF\")");
    expect(releaseWorkflow).toContain("git merge-base --is-ancestor \"$SOURCE_COMMIT\" origin/main");
    expect(releaseWorkflow.indexOf("REGISTRY_DIST=dist bun run smoke")).toBeGreaterThan(releaseWorkflow.indexOf("REGISTRY_DIST=dist bun run test"));
    expect(releaseWorkflow.indexOf("REGISTRY_DIST=dist bun run smoke")).toBeLessThan(releaseWorkflow.indexOf("dist/release.json"));
    expect(releaseWorkflow.indexOf("REGISTRY_DIST=dist bun run smoke")).toBeLessThan(releaseWorkflow.indexOf("actions/configure-pages@"));
    expect(releaseWorkflow.indexOf("Reject a stale Pages version")).toBeLessThan(releaseWorkflow.indexOf("actions/deploy-pages@"));
    for (const file of ["release.json", "index.json", "components/ws.json", "components/ws-overrides.json", "components/ws/profiles/ws/AGENTS.md", "components/ws/profiles/ws/ocx.jsonc"]) {
      expect(releaseWorkflow).toContain(`cmp \"dist/${file}\" \"$RUNNER_TEMP/live/${file}\"`);
    }
    expect(releaseWorkflow).toContain("gh release view");
    expect(releaseWorkflow).toContain("gh release create");
  });
});
