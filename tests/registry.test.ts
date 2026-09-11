import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { parse } from "jsonc-parser";

import BackgroundAgentsPlugin from "../files/plugins/background-agents";
import { getProjectId } from "../files/plugins/kdco-primitives/get-project-id";
import { buildCmuxSessionStatusTransitionForEvent } from "../files/plugins/notify/status";
import { sanitizeOscTitleText } from "../files/plugins/notify/title";
import WorkspacePlugin from "../files/plugins/workspace-plugin";
import WorktreePlugin from "../files/plugins/worktree";
import {
  buildSessionLaunchArgv,
  parseActiveLaunchContext,
  parsePersistedLaunchMetadata,
} from "../files/plugins/worktree/launch-context";
import {
  addSession,
  getPendingDelete,
  getSession,
  initStateDb,
  setPendingDelete,
} from "../files/plugins/worktree/state";
import {
  expectedComponents,
  outputDirectory,
  promoteStagedOutput,
} from "../scripts/build-registry";
import { decideReleaseAction } from "../scripts/release-policy";
import {
  assertBuiltRegistryVersion,
  assertInstalledLayout,
  assertRemovedLayout,
  boundSmokeDiagnostics,
  cleanupSmokeSandbox,
  createSmokeRedactionContext,
  expectedDirectNpmDependencies,
  isInheritedSmokeVariable,
  npmPolicyContent,
  redactSmokeDiagnostics,
  runSmokeCommand,
  smokeEnvironment,
  writeSandboxNpmPolicy,
} from "../scripts/smoke-install";

const repositoryRoot = join(import.meta.dir, "..");
const registry = parse(
  await readFile(join(repositoryRoot, "registry.jsonc"), "utf8"),
) as any;
const profileConfig = parse(
  await readFile(
    join(repositoryRoot, "files/profiles/workcell/opencode.jsonc"),
    "utf8",
  ),
) as any;
const profileTuiConfig = parse(
  await readFile(
    join(repositoryRoot, "files/profiles/workcell/tui.jsonc"),
    "utf8",
  ),
) as any;
const packageManifest = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
) as any;
const continuousIntegration = await readFile(
  join(repositoryRoot, ".github/workflows/ci.yml"),
  "utf8",
);
const releaseWorkflow = await readFile(
  join(repositoryRoot, ".github/workflows/release.yml"),
  "utf8",
);

function sha256(value: string | undefined): string | null {
  return value === undefined
    ? null
    : createHash("sha256").update(value).digest("hex");
}

const bareSemVerPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const packageIdentityPattern =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function parseExactPackagePin(value: unknown): {
  name: string;
  version: string;
} {
  if (typeof value !== "string")
    throw new Error(`Package pin must be a string, received ${String(value)}`);

  const versionSeparator = value.lastIndexOf("@");
  const name = value.slice(0, versionSeparator);
  const version = value.slice(versionSeparator + 1);
  if (!packageIdentityPattern.test(name))
    throw new Error(`Invalid package identity in pin: ${value}`);
  if (!bareSemVerPattern.test(version))
    throw new Error(
      `Package ${name} must use exact bare SemVer, received ${version}`,
    );
  return { name, version };
}

function parseUniqueExactPackagePins(
  values: unknown,
  owner: string,
): Array<{ name: string; version: string }> {
  if (!Array.isArray(values))
    throw new Error(`${owner} package pins must be an array`);

  const pins = values.map(parseExactPackagePin);
  const identities = new Set<string>();
  for (const pin of pins) {
    if (identities.has(pin.name))
      throw new Error(`${owner} duplicates package identity ${pin.name}`);
    identities.add(pin.name);
  }
  return pins;
}

function parseInventoryPath(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${description} must be a non-empty string`);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error(
      `${description} must be a normalized relative path: ${value}`,
    );
  return value;
}

function assertReviewedBundleCoverage(
  components: any[],
  bundleName: string,
  profileName: string,
  reviewedNames: readonly string[],
): void {
  const componentsByName = new Map<string, any>();
  const dependenciesByName = new Map<string, string[]>();

  for (const component of components) {
    if (componentsByName.has(component.name))
      throw new Error(`Registry duplicates component ${component.name}`);
    componentsByName.set(component.name, component);
  }
  for (const component of components) {
    const dependencies = component.dependencies ?? [];
    if (!Array.isArray(dependencies))
      throw new Error(
        `Component ${component.name} dependencies must be an array`,
      );
    if (dependencies.some((name: unknown) => typeof name !== "string"))
      throw new Error(`Component ${component.name} has an invalid dependency`);
    if (new Set(dependencies).size !== dependencies.length)
      throw new Error(`Component ${component.name} has duplicate dependencies`);
    for (const dependency of dependencies) {
      if (!componentsByName.has(dependency))
        throw new Error(
          `Component ${component.name} depends on missing component ${dependency}`,
        );
    }
    dependenciesByName.set(component.name, dependencies);
  }

  const bundleDependencies = dependenciesByName.get(bundleName);
  if (!bundleDependencies)
    throw new Error(`Reviewed bundle ${bundleName} does not exist`);
  const expectedLeaves = reviewedNames.filter(
    (name) => name !== profileName && name !== bundleName,
  );
  const missingLeaves = expectedLeaves.filter(
    (name) => !bundleDependencies.includes(name),
  );
  const unexpectedDependencies = bundleDependencies.filter(
    (name) => !expectedLeaves.includes(name),
  );
  if (missingLeaves.length > 0)
    throw new Error(
      `Reviewed bundle is missing components: ${missingLeaves.join(", ")}`,
    );
  if (unexpectedDependencies.length > 0)
    throw new Error(
      `Reviewed bundle has unexpected dependencies: ${unexpectedDependencies.join(", ")}`,
    );
}

function createWorktreeStateDatabase(): Database {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      branch TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      launch_mode TEXT,
      profile TEXT,
      ocx_bin TEXT
    );
    CREATE TABLE pending_operations (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      type TEXT NOT NULL,
      branch TEXT NOT NULL,
      path TEXT NOT NULL,
      session_id TEXT
    );
    CREATE TABLE pending_deletes (
      session_id TEXT PRIMARY KEY,
      branch TEXT NOT NULL,
      path TEXT NOT NULL
    );
  `);
  return database;
}

async function worktreeStateDatabasePath(
  databaseDirectory: string,
  projectDirectory: string,
): Promise<string> {
  const projectId = await getProjectId(projectDirectory);
  return join(databaseDirectory, `${projectId}.sqlite`);
}

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function runGit(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
  return stdout;
}

async function createGitRepository(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await runGit(["init", "--initial-branch=main"], directory);
  await runGit(["config", "user.name", "Workcell Test"], directory);
  await runGit(["config", "user.email", "workcell@example.invalid"], directory);
  await writeFile(join(directory, "tracked.txt"), "initial\n");
  await runGit(["add", "tracked.txt"], directory);
  await runGit(["commit", "-m", "initial"], directory);
}

async function outputFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const path = relative(
      directory,
      join(entry.parentPath, entry.name),
    ).replaceAll("\\", "/");
    throw new Error(`Symbolic links are not shippable: ${path}`);
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(directory, join(entry.parentPath, entry.name)).replaceAll(
        "\\",
        "/",
      ),
    )
    .sort();
}

async function buildOutput(): Promise<{ directory: string; remove: boolean }> {
  if (process.env.REGISTRY_DIST)
    return { directory: process.env.REGISTRY_DIST, remove: false };
  const directory = await mkdtemp(join(tmpdir(), "ocx-registry-test-"));
  const child = Bun.spawn(
    [process.execPath, "run", "build", "--", "--out", directory],
    {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(`Registry build failed: ${stderr || stdout}`);
  return { directory, remove: true };
}

function declaredOutputFiles(): string[] {
  return [
    "index.json",
    ...registry.components.flatMap((component: any) => [
      `components/${component.name}.json`,
      ...component.files.map(
        (file: string | { path: string }) =>
          `components/${component.name}/${typeof file === "string" ? file : file.path}`,
      ),
    ]),
  ].sort();
}

describe("dependency and inventory policy helpers", () => {
  test("parses scoped and unscoped exact package pins", () => {
    expect(parseExactPackagePin("example-package@1.2.3")).toEqual({
      name: "example-package",
      version: "1.2.3",
    });
    expect(parseExactPackagePin("@example/plugin@2.0.0-beta.1")).toEqual({
      name: "@example/plugin",
      version: "2.0.0-beta.1",
    });
  });

  test("rejects malformed or floating package pins and duplicate identities", () => {
    for (const invalidPin of [
      "package@^1.2.3",
      "package@latest",
      "package@workspace:*",
      "package@npm:other@1.2.3",
      "package@git+https://example.invalid/repository.git",
      "https://example.invalid/package.tgz",
    ]) {
      expect(() => parseExactPackagePin(invalidPin), invalidPin).toThrow();
    }
    expect(() =>
      parseUniqueExactPackagePins(
        ["@example/plugin@1.0.0", "@example/plugin@2.0.0"],
        "Fixture",
      ),
    ).toThrow("duplicates package identity @example/plugin");
  });

  test("rejects missing bundle edges and duplicate component dependencies", () => {
    const missingBundleEdge = structuredClone(registry.components);
    const bundle = missingBundleEdge.find(
      (component: any) => component.name === "workcell-bundle",
    );
    bundle.dependencies = bundle.dependencies.filter(
      (dependency: string) => dependency !== "workcell-notify",
    );
    expect(() =>
      assertReviewedBundleCoverage(
        missingBundleEdge,
        "workcell-bundle",
        "workcell",
        expectedComponents,
      ),
    ).toThrow("Reviewed bundle is missing components: workcell-notify");

    const duplicateDependency = structuredClone(registry.components);
    const duplicateBundle = duplicateDependency.find(
      (component: any) => component.name === "workcell-bundle",
    );
    duplicateBundle.dependencies.push(duplicateBundle.dependencies[0]);
    expect(() =>
      assertReviewedBundleCoverage(
        duplicateDependency,
        "workcell-bundle",
        "workcell",
        expectedComponents,
      ),
    ).toThrow("Component workcell-bundle has duplicate dependencies");
  });

  test("rejects symlinks before selecting regular shippable files", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "workcell-file-inventory-"));
    try {
      await writeFile(join(sandbox, "payload.ts"), "export {};\n");
      await symlink("payload.ts", join(sandbox, "linked.ts"));
      await expect(outputFiles(sandbox)).rejects.toThrow(
        "Symbolic links are not shippable: linked.ts",
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe("self-contained Workcell registry", () => {
  test("declares the reviewed graph and release identity", () => {
    expect(registry.version).toBe(packageManifest.version);
    expect(registry.opencode).toBe("1.18.25");
    expect(registry.ocx).toBe("2.0.14");
    expect(registry.components.map((component: any) => component.name)).toEqual(
      [...expectedComponents],
    );
    expect(
      registry.components.every(
        (component: any) =>
          component.name === "workcell" ||
          component.name.startsWith("workcell-"),
      ),
    ).toBe(true);

    const profile = registry.components.find(
      (component: any) => component.name === "workcell",
    );
    expect(profile.dependencies).toEqual(["workcell-bundle"]);
    expect(profile.files).toEqual([
      { path: "profiles/workcell/ocx.jsonc", target: "ocx.jsonc" },
      { path: "profiles/workcell/opencode.jsonc", target: "opencode.jsonc" },
      { path: "profiles/workcell/tui.jsonc", target: "tui.jsonc" },
      { path: "profiles/workcell/AGENTS.md", target: "AGENTS.md" },
    ]);
    assertReviewedBundleCoverage(
      registry.components,
      "workcell-bundle",
      "workcell",
      expectedComponents,
    );
  });

  test("preserves required ownership dependencies and validates each component's npm pins", () => {
    const component = (name: string) =>
      registry.components.find((candidate: any) => candidate.name === name);
    expect(component("workcell-background-agents").dependencies).toEqual([
      "workcell-primitives",
    ]);
    expect(component("workcell-workspace-plugin").dependencies).toEqual([
      "workcell-background-agents",
      "workcell-primitives",
    ]);
    expect(component("workcell-skill-plan-protocol").dependencies).toEqual([
      "workcell-workspace-plugin",
    ]);
    expect(component("workcell-agent-coder").dependencies).toEqual([
      "workcell-background-agents",
    ]);
    expect(component("workcell-agent-researcher").dependencies).toEqual([
      "workcell-background-agents",
    ]);
    expect(component("workcell-agent-reviewer").dependencies).toEqual([
      "workcell-skill-code-review",
      "workcell-skill-plan-review",
    ]);
    expect(component("workcell-review-command").dependencies).toEqual([
      "workcell-agent-reviewer",
    ]);
    expect(component("workcell-philosophy").dependencies).toEqual([
      "workcell-skill-code-philosophy",
      "workcell-skill-frontend-philosophy",
    ]);

    for (const candidate of registry.components) {
      if (candidate.npmDependencies === undefined) continue;
      parseUniqueExactPackagePins(
        candidate.npmDependencies,
        `Component ${candidate.name}`,
      );
    }

    const expectedRuntimeDependencies: Record<string, string[]> = {
      "workcell-background-agents": [
        "@opencode-ai/plugin@1.18.25",
        "unique-names-generator@4.7.1",
      ],
      "workcell-workspace-plugin": ["@opencode-ai/plugin@1.18.25", "zod@4.3.5"],
      "workcell-notify": ["node-notifier@10.0.1", "detect-terminal@2.0.0"],
      "workcell-worktree": [
        "@opencode-ai/plugin@1.18.25",
        "zod@4.3.5",
        "jsonc-parser@3.3.1",
      ],
    };
    for (const [name, dependencies] of Object.entries(
      expectedRuntimeDependencies,
    ))
      expect(component(name).npmDependencies).toEqual(dependencies);
    for (const candidate of registry.components) {
      if (candidate.name in expectedRuntimeDependencies) continue;
      expect(candidate.npmDependencies).toBeUndefined();
    }
    const pluginOwners = registry.components
      .filter((candidate: any) =>
        candidate.npmDependencies?.some((pin: string) =>
          pin.startsWith("@opencode-ai/plugin@"),
        ),
      )
      .map((candidate: any) => candidate.name);
    expect(pluginOwners).toEqual([
      "workcell-background-agents",
      "workcell-workspace-plugin",
      "workcell-worktree",
    ]);
    expect(
      registry.components.some((candidate: any) =>
        candidate.npmDependencies?.some((pin: string) =>
          pin.startsWith("@opencode-ai/sdk@"),
        ),
      ),
    ).toBe(false);
  });

  test("publishes the canonical profile configuration with all identities and nested options", () => {
    expect(profileConfig).toMatchObject({
      model: "openai/gpt-6-astra",
      small_model: "openai/gpt-5.6-luna",
      default_agent: "plan",
      subagent_depth: 1,
      lsp: true,
      formatter: true,
      instructions: ["./tools/philosophy.md"],
      permission: { "*": "deny" },
    });
    const expectedAgents = [
      "plan",
      "build",
      "coder",
      "debugger",
      "tester",
      "explore",
      "researcher",
      "scribe",
      "reviewer",
      "committer",
      "metadata",
    ];
    expect(Object.keys(profileConfig.agent)).toEqual(expectedAgents);
    const expectedAgentMatrix = {
      plan: {
        mode: "primary",
        model: "openai/gpt-6-astra",
        temperature: 0.3,
        options: { reasoningEffort: "high", textVerbosity: "medium" },
        promptHash:
          "1b9505d51aa4a77167fd6c7ebe786ae99a74eefb368aecadae07af3ac7df3473",
        permissionHash:
          "a38d357aca6878996cd35d9bf3d890aea290dcbbd5474e7772aae916942821bd",
      },
      build: {
        mode: "primary",
        model: "openai/gpt-6-astra",
        temperature: 0.3,
        options: { reasoningEffort: "high", textVerbosity: "low" },
        promptHash:
          "886bd7a56665bb5701fe3fc3964941018887515da9857bf7cdb8a3df02135c03",
        permissionHash:
          "0a9b4ecd6b8cb6af1e731c34fe2f836e1fb8e2830796e8a3423008e1469e256e",
      },
      coder: {
        mode: "subagent",
        model: "openai/gpt-6-astra",
        temperature: 0.1,
        options: { reasoningEffort: "medium", textVerbosity: "low" },
        promptHash: null,
        permissionHash:
          "abc3ce922ce5e97b55b3476416fc22ee071fb67e02551fcbd70d2088488e1a9f",
      },
      debugger: {
        mode: "subagent",
        model: "openai/gpt-6-astra",
        temperature: 0.1,
        options: { reasoningEffort: "high", textVerbosity: "low" },
        promptHash: null,
        permissionHash:
          "248d264ccca16e6ae459f95c64dde146315d52c03d3023a1ea71452280e2b8aa",
      },
      tester: {
        mode: "subagent",
        model: "openai/gpt-5.6-luna",
        temperature: null,
        options: { reasoningEffort: "low", textVerbosity: "low" },
        promptHash: null,
        permissionHash:
          "b39b80d0763ea577f773c5b54e0f7e98a2ce3456ddee06c195c84cb7f61ca097",
      },
      explore: {
        mode: "subagent",
        model: "openai/gpt-5.6-luna",
        temperature: 0.2,
        options: { reasoningEffort: "medium", textVerbosity: "medium" },
        promptHash: null,
        permissionHash:
          "633709901baf9320c903cd281fd313bde63c88affc0b0104e7be39983bb7eb3d",
      },
      researcher: {
        mode: "subagent",
        model: "openai/gpt-5.6-terra",
        temperature: 0.2,
        options: { reasoningEffort: "medium", textVerbosity: "medium" },
        promptHash: null,
        permissionHash:
          "3195e419c7762ef3fc39342752d883715894a608c5a167081a73c65cb445000c",
      },
      scribe: {
        mode: "subagent",
        model: "openai/gpt-5.6-luna",
        temperature: 0.1,
        options: { reasoningEffort: "medium", textVerbosity: "low" },
        promptHash: null,
        permissionHash:
          "9733bac4d4ea7387f6287099b3f3911126aa9b5a1cf789ceeab5104267c2e810",
      },
      reviewer: {
        mode: "subagent",
        model: "openai/gpt-6-astra",
        temperature: 0.1,
        options: { reasoningEffort: "high", textVerbosity: "medium" },
        promptHash: null,
        permissionHash:
          "b507ffe358db8b9a1520991e78649c39471796eb0fdd33b8f05c1df03dd43d03",
      },
      committer: {
        mode: "subagent",
        model: "openai/gpt-6-astra",
        temperature: 0.1,
        options: { reasoningEffort: "low", textVerbosity: "low" },
        promptHash: null,
        permissionHash:
          "1996492edbd6929aa27e772435d67b5e880771fa6419622c2cdf63d196fc5bfd",
      },
      metadata: {
        mode: "subagent",
        model: "openai/gpt-5.6-luna",
        temperature: 0,
        options: { reasoningEffort: "low", textVerbosity: "low" },
        promptHash: null,
        permissionHash:
          "38ea7f7fdf711cfa8d93ae20c92debe3909f28d6f6b4f3a82538af9f3c1c3b71",
      },
    };
    const actualAgentMatrix = Object.fromEntries(
      expectedAgents.map((name) => {
        const agent = profileConfig.agent[name];
        return [
          name,
          {
            mode: agent.mode,
            model: agent.model,
            temperature: agent.temperature ?? null,
            options: agent.options,
            promptHash: sha256(agent.prompt),
            permissionHash: sha256(JSON.stringify(agent.permission)),
          },
        ];
      }),
    );
    expect(actualAgentMatrix).toEqual(expectedAgentMatrix);
    expect(sha256(JSON.stringify(profileConfig.permission))).toBe(
      "2810572f3bc9f4d8a8cb4cd62edb96a217aca74377bceadfa94c091d86828370",
    );
    for (const name of expectedAgents) {
      expect(profileConfig.agent[name].reasoningEffort).toBeUndefined();
      expect(profileConfig.agent[name].textVerbosity).toBeUndefined();
    }
    expect({
      planSkill: profileConfig.agent.plan.permission.skill,
      planTodoWrite: profileConfig.agent.plan.permission.todowrite,
      buildSkill: profileConfig.agent.build.permission.skill,
      buildTodoRead: profileConfig.agent.build.permission.todoread,
      reviewerSkill: profileConfig.agent.reviewer.permission.skill,
    }).toEqual({
      planSkill: "allow",
      planTodoWrite: "allow",
      buildSkill: "allow",
      buildTodoRead: "allow",
      reviewerSkill: "allow",
    });
    expect(
      Object.entries(profileConfig.agent.committer.permission.bash),
    ).toEqual([
      ["*", "deny"],
      ["git status*", "allow"],
      ["git diff*", "allow"],
      ["git log*", "allow"],
      ["git show*", "allow"],
      ["git branch*", "allow"],
      ["git rev-parse*", "allow"],
      ["git symbolic-ref*", "allow"],
      ["git ls-files*", "allow"],
      ["git remote*", "allow"],
      ["git config --get *", "allow"],
      ["git add *", "allow"],
      ["git add .", "deny"],
      ["git add -A*", "deny"],
      ["git add --all*", "deny"],
      ["git add -u*", "deny"],
      ["git add --update*", "deny"],
      ["git apply --cached*", "allow"],
      ["git restore --staged *", "allow"],
      ["git commit*", "allow"],
      ["git commit -a*", "deny"],
      ["git commit --all*", "deny"],
      ["git push*", "ask"],
      ["git push --force*", "deny"],
      ["git push -f*", "deny"],
      ["gh auth status*", "allow"],
      ["gh repo view*", "allow"],
      ["gh pr status*", "allow"],
      ["gh pr list*", "allow"],
      ["gh pr view*", "allow"],
      ["gh pr create*", "allow"],
    ]);
    expect(profileConfig.agent.metadata.hidden).toBe(true);
    expect(profileConfig.mcp).toEqual({
      context7: {
        type: "remote",
        url: "https://mcp.context7.com/mcp",
        enabled: true,
      },
      exa: {
        type: "remote",
        url: "https://mcp.exa.ai/mcp/oauth",
        enabled: true,
      },
      gh_grep: { type: "remote", url: "https://mcp.grep.app", enabled: true },
    });
    const runtimePlugins = parseUniqueExactPackagePins(
      profileConfig.plugin,
      "Profile runtime plugins",
    );
    expect(runtimePlugins.map(({ name }) => name)).toEqual([
      "opencode-vibeguard",
      "@tarquinen/opencode-dcp",
      "@franlol/opencode-md-table-formatter",
    ]);
    expect(
      runtimePlugins.find(({ name }) => name === "@tarquinen/opencode-dcp")
        ?.version,
    ).toBe("3.1.15");
    expect(profileTuiConfig).toEqual({
      $schema: "https://opencode.ai/tui.json",
      plugin: ["@tarquinen/opencode-dcp@3.1.15"],
    });
    expect(
      runtimePlugins.filter(({ name }) => name === "@tarquinen/opencode-dcp"),
    ).toHaveLength(1);
    expect(
      runtimePlugins.some(({ name }) => /notif(?:y|ier)/i.test(name)),
    ).toBe(false);
    for (const agentName of ["plan", "build"]) {
      expect(profileConfig.agent[agentName].permission).toMatchObject({
        delegate: "allow",
        delegation_read: "allow",
        delegation_list: "allow",
      });
    }
    expect(profileConfig.agent.plan.permission).toMatchObject({
      plan_save: "allow",
      plan_read: "allow",
      task: "deny",
    });
    for (const agent of [
      "coder",
      "debugger",
      "tester",
      "scribe",
      "committer",
      "reviewer",
      "explore",
      "researcher",
    ]) {
      expect(profileConfig.agent[agent].permission).toMatchObject({
        external_directory: "deny",
        plan_read: ["explore", "researcher"].includes(agent) ? "deny" : "allow",
      });
    }
  });

  test("contains no forbidden runtime dependency, integration, artifact, secret, symlink, or machine path", async () => {
    const profile = parse(
      await readFile(
        join(repositoryRoot, "files/profiles/workcell/ocx.jsonc"),
        "utf8",
      ),
    ) as any;
    expect(profile.registries).toEqual({
      matthewmorek: {
        url: "https://matthewmorek.github.io/ocx-profile-workcell",
      },
    });
    expect(profile.renameWindow).toBeUndefined();
    expect(profile.exclude).toEqual(["**/CONTEXT.md", "**/.opencode/**"]);
    expect(profile.include).toEqual([
      "**/CLAUDE.md",
      "**/AGENTS.md",
      "**/opencode.json",
    ]);
  });

  test("preserves immutable KDCO provenance and accurate inspiration attributions", async () => {
    const notices = await readFile(
      join(repositoryRoot, "THIRD_PARTY_NOTICES.md"),
      "utf8",
    );
    const backgroundHeader = (
      await readFile(
        join(repositoryRoot, "files/plugins/background-agents.ts"),
        "utf8",
      )
    ).slice(0, 1_200);
    const worktreeHeader = (
      await readFile(join(repositoryRoot, "files/plugins/worktree.ts"), "utf8")
    ).slice(0, 1_200);
    const kdcoRevision = "75e05a9a3280e5ee16953d7b9d6c42ad4d893697";
    const worktreeInspirationRevision =
      "93a55c23c9fd5ce9328d090d31a74e7357af5d8d";

    expect(notices).toContain(`immutable commit [\`${kdcoRevision}\`]`);
    expect(notices).toContain(
      `[LICENSES/KDCO-OCX-MIT.txt](LICENSES/KDCO-OCX-MIT.txt)`,
    );
    for (const mapping of [
      "| `files/agents/**` | `workers/kdco-registry/files/agents/**` |",
      "| `files/skills/**` | `workers/kdco-registry/files/skills/**` |",
      "| `files/commands/**` | `workers/kdco-registry/files/commands/**` |",
      "| `files/tools/**` | `workers/kdco-registry/files/tools/**` |",
      "| `files/plugins/workspace-plugin.ts` | `workers/kdco-registry/files/plugins/workspace-plugin.ts` |",
      "| `files/plugins/background-agents.ts` | `workers/kdco-registry/files/plugins/background-agents.ts` |",
      "| `files/plugins/notify.ts` and `files/plugins/notify/**` | `workers/kdco-registry/files/plugins/notify.ts` and `workers/kdco-registry/files/plugins/notify/**` |",
      "| `files/plugins/kdco-primitives/**` | `workers/kdco-registry/files/plugins/kdco-primitives/**` |",
      "| `files/plugins/worktree.ts` and `files/plugins/worktree/**` | `workers/kdco-registry/files/plugins/worktree.ts` and `workers/kdco-registry/files/plugins/worktree/**` |",
    ]) {
      expect(notices).toContain(mapping);
    }

    expect(backgroundHeader).toContain(
      "Copied and modified from KDCO OCX/Workspace under MIT.",
    );
    expect(backgroundHeader).toContain(
      "Attribution/inspiration only; no revision, file-copy mapping, or external license is asserted.",
    );
    expect(backgroundHeader).toContain("THIRD_PARTY_NOTICES.md");
    expect(backgroundHeader).not.toContain(
      "oh-my-opencode by @code-yeongyu (MIT License)",
    );

    expect(worktreeHeader).toContain(
      "Copied and modified from KDCO OCX/Workspace under MIT.",
    );
    expect(worktreeHeader).toContain(worktreeInspirationRevision);
    expect(worktreeHeader).toContain("Apache-2.0");
    expect(worktreeHeader).toContain("THIRD_PARTY_NOTICES.md");
    expect(worktreeHeader).not.toContain("License: MIT");
  });

  test("ships every relative plugin import in the declared payload graph", async () => {
    const pluginFiles = (
      await outputFiles(join(repositoryRoot, "files/plugins"))
    ).filter((path) => path.endsWith(".ts"));
    for (const pluginFile of pluginFiles) {
      const sourcePath = join(repositoryRoot, "files/plugins", pluginFile);
      const source = await readFile(sourcePath, "utf8");
      for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const importedPath = resolve(dirname(sourcePath), match[1]);
        const candidates = [
          importedPath,
          `${importedPath}.ts`,
          join(importedPath, "index.ts"),
        ];
        const resolvedImport = await Promise.any(
          candidates.map(async (candidate) => {
            if (await Bun.file(candidate).exists()) return candidate;
            throw new Error("missing");
          }),
        ).catch(() => undefined);
        expect(resolvedImport).toBeDefined();
      }
    }
  });

  test("builds exactly one packument and every declared payload file", async () => {
    const output = await buildOutput();
    try {
      expect(await outputFiles(output.directory)).toEqual(
        declaredOutputFiles(),
      );
      for (const name of expectedComponents) {
        const packument = JSON.parse(
          await Bun.file(
            join(output.directory, "components", `${name}.json`),
          ).text(),
        );
        expect(Object.keys(packument.versions)).toEqual([registry.version]);
        expect(packument["dist-tags"].latest).toBe(registry.version);
      }
    } finally {
      if (output.remove)
        await rm(output.directory, { recursive: true, force: true });
    }
  });
});

describe("high-risk deterministic plugin boundaries", () => {
  test("parses launch context and builds profile-preserving session argv", () => {
    expect(parseActiveLaunchContext({})).toEqual({ mode: "plain" });
    expect(() => parseActiveLaunchContext({ OCX_CONTEXT: "1" })).toThrow(
      "OCX_BIN",
    );
    const context = parseActiveLaunchContext({
      OCX_CONTEXT: "1",
      OCX_BIN: "/usr/local/bin/ocx",
      OCX_PROFILE: "workcell",
    });
    expect(buildSessionLaunchArgv(" session-1 ", context)).toEqual([
      "/usr/local/bin/ocx",
      "opencode",
      "-p",
      "workcell",
      "--session",
      "session-1",
    ]);
    expect(parsePersistedLaunchMetadata({ launchMode: null })).toEqual({
      mode: "plain",
    });
    expect(() => parsePersistedLaunchMetadata({ launchMode: "other" })).toThrow(
      "unsupported launchMode",
    );
  });

  test("maps stable notification states and strips title control characters", () => {
    expect(
      buildCmuxSessionStatusTransitionForEvent("session.status", {
        sessionID: " s1 ",
        status: { type: "BUSY" },
      }),
    ).toEqual({ sessionID: "s1", logicalState: "animated-busy" });
    expect(
      buildCmuxSessionStatusTransitionForEvent("permission.asked", {
        sessionID: "s1",
      }),
    ).toEqual({ sessionID: "s1", logicalState: "needs-input" });
    expect(
      buildCmuxSessionStatusTransitionForEvent("unknown", { sessionID: "s1" }),
    ).toBeNull();
    expect(sanitizeOscTitleText(" Workcell\u0007 ready ")).toBe(
      "Workcell  ready",
    );
  });

  test("isolates persisted delegation artifacts to valid direct-child IDs", async () => {
    const baseDirectory = await mkdtemp(
      join(tmpdir(), "workcell-delegations-"),
    );
    const rootA = "root-a";
    const rootB = "root-b";
    const persistedID = "calm-blue-otter";
    const client = {
      app: { log: async () => ({}) },
      session: {
        get: async ({ path }: { path: { id: string } }) => ({
          data: { id: path.id },
        }),
      },
    } as any;
    const Manager = BackgroundAgentsPlugin.testInternals.DelegationManager;
    const manager = new Manager(client, baseDirectory, silentLog as any);

    try {
      await mkdir(join(baseDirectory, rootA), { recursive: true });
      await mkdir(join(baseDirectory, rootB), { recursive: true });
      await writeFile(
        join(baseDirectory, rootA, `${persistedID}.md`),
        "root A result",
      );
      await writeFile(
        join(baseDirectory, rootB, `${persistedID}.md`),
        "root B secret",
      );

      await expect(manager.readOutput(rootA, persistedID)).resolves.toBe(
        "root A result",
      );
      await expect(
        manager.readOutput(rootA, "missing-red-fox"),
      ).rejects.toThrow("was not found");

      for (const invalidID of [
        "",
        "malformed",
        "../root-b/calm-blue-otter",
        "/root-b/calm-blue-otter",
        "root-b/calm-blue-otter",
        "root-b\\calm-blue-otter",
        "calm--blue-otter",
      ]) {
        await expect(manager.readOutput(rootA, invalidID)).rejects.toThrow(
          /Delegation ID/,
        );
      }
    } finally {
      await rm(baseDirectory, { recursive: true, force: true });
    }
  });

  test("preserves reviewer read configuration and gates metadata enrichment through the existing manager", async () => {
    const { DelegationManager, generateFallbackMetadata } = BackgroundAgentsPlugin.testInternals;
    const previousMetadata = process.env.KDCO_BACKGROUND_METADATA;
    const result = "Repository checks complete\nEvidence: existing verification passed.";
    const generated = { title: "Verified repository", description: "Existing verification passed." };
    const scenarios = [
      { env: undefined, agent: "reviewer", mode: "disabled" },
      { env: "0", agent: "explore", mode: "disabled" },
      { env: "true", agent: "researcher", mode: "disabled" },
      { env: "01", agent: "reviewer", mode: "disabled" },
      { env: "1 ", agent: "explore", mode: "disabled" },
      { env: "1", agent: "reviewer", mode: "success" },
      { env: "1", agent: "explore", mode: "invalid-response" },
      { env: "1", agent: "researcher", mode: "missing-agent" },
      { env: "1", agent: "reviewer", mode: "model-error" },
      { env: undefined, agent: "reviewer", mode: "injected-success" },
      { env: "0", agent: "explore", mode: "injected-error" },
    ];
    try {
      for (const scenario of scenarios) {
        if (scenario.env === undefined) delete process.env.KDCO_BACKGROUND_METADATA;
        else process.env.KDCO_BACKGROUND_METADATA = scenario.env;
        const baseDirectory = await mkdtemp(join(tmpdir(), "workcell-metadata-"));
        const requests: Array<{ path: { id: string }; body: any }> = [];
        const created: any[] = [];
        const deleted: string[] = [];
        const logs: string[] = [];
        let discoveryCalls = 0;
        let generatorCalls = 0;
        let releaseGenerator: () => void = () => {};
        const generatorGate = new Promise<void>((resolve) => { releaseGenerator = resolve; });
        const client = {
          app: {
            agents: async () => {
              discoveryCalls += 1;
              return { data: [
                { name: scenario.agent, mode: "subagent" },
                ...(scenario.mode === "missing-agent" ? [] : [{ name: "metadata", mode: "subagent" }]),
              ] };
            },
            log: async () => ({}),
          },
          session: {
            get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
            create: async ({ body }: { body: any }) => {
              created.push(body);
              return { data: { id: created.length === 1 ? "child" : "metadata-child" } };
            },
            delete: async ({ path }: { path: { id: string } }) => { deleted.push(path.id); return {}; },
            prompt: async (request: { path: { id: string }; body: any }) => {
              requests.push(request);
              if (request.body.agent === "metadata" && scenario.mode === "model-error") throw new Error("model unavailable");
              const text = request.path.id === "child" ? result
                : scenario.mode === "invalid-response" ? "not JSON" : JSON.stringify(generated);
              return { data: { parts: [{ type: "text", text }] } };
            },
          },
        };
        const injected = scenario.mode.startsWith("injected-");
        const manager = new DelegationManager(client as any, baseDirectory, {
          ...silentLog,
          debug: (message: string) => { logs.push(message); },
        } as any, {
          idGenerator: () => "calm-blue-otter",
          allCompleteQuietPeriodMs: 1,
          ...(injected ? { metadataGenerator: async (...args: any[]) => {
            generatorCalls += 1;
            expect(args.slice(0, 4)).toEqual([client, result, "child", "calm-blue-otter"]);
            await generatorGate;
            if (scenario.mode === "injected-error") throw new Error("injected metadata failure");
            return generated;
          } } : {}),
        });
        // Opt-in is captured at construction, not read during completion.
        if (scenario.env === "1") delete process.env.KDCO_BACKGROUND_METADATA;
        else process.env.KDCO_BACKGROUND_METADATA = "1";
        try {
          const record = await manager.delegate({
            parentSessionID: "root", parentMessageID: "message", parentAgent: "build",
            prompt: "Inspect the bounded repository scope.", agent: scenario.agent,
          });
          const initialArtifact = await manager.readOutput("root", record.id);
          expect(record.status, scenario.mode).toBe("complete");
          expect(initialArtifact).toContain(result);
          const childRequest = requests.find((request) => request.path.id === "child")!;
          const denied = { task: false, delegate: false, todowrite: false, plan_save: false };
          expect(childRequest.body.tools).toEqual(scenario.agent === "reviewer" ? denied : {
            ...denied, delegation_read: false, delegation_list: false,
          });
          if (scenario.agent === "reviewer") {
            for (const permission of ["allow", "deny"] as const) {
              const configured = { delegation_read: permission, delegation_list: permission };
              expect({ ...configured, ...childRequest.body.tools }).toMatchObject(configured);
            }
          }
          const fallback = generateFallbackMetadata(result, record.id);
          if (injected) {
            expect(record.title).toBe(fallback.title);
            expect(initialArtifact).toContain(fallback.title);
            releaseGenerator();
          }
          const enriched = scenario.mode === "success" || scenario.mode === "injected-success";
          const expected = enriched ? generated : fallback;
          const persistedCount = scenario.mode === "disabled" || scenario.mode === "injected-error" ? 1 : 2;
          const deadline = Date.now() + 1_000;
          while (Date.now() < deadline && (
            logs.filter((line) => line.startsWith("persistOutput: wrote ")).length < persistedCount ||
            (scenario.mode === "injected-error" && !logs.some((line) => line.includes("injected metadata failure")))
          )) await Bun.sleep(5);
          expect(logs.filter((line) => line.startsWith("persistOutput: wrote ")).length, scenario.mode).toBe(persistedCount);
          expect(record.title, scenario.mode).toBe(expected.title);
          expect(record.description, scenario.mode).toBe(expected.description);
          const artifact = await manager.readOutput("root", record.id);
          expect(artifact).toContain(expected.title);
          expect(artifact).toContain(result);
          expect(generatorCalls).toBe(injected ? 1 : 0);
          expect(discoveryCalls, scenario.mode).toBe(scenario.mode === "disabled" || injected ? 1 : 2);
          const usesModel = ["success", "invalid-response", "model-error"].includes(scenario.mode);
          expect(created).toHaveLength(usesModel ? 2 : 1);
          expect(requests.filter((request) => request.body.agent === "metadata")).toHaveLength(usesModel ? 1 : 0);
          expect(deleted).toEqual(usesModel ? ["metadata-child"] : []);
        } finally {
          releaseGenerator();
          await rm(baseDirectory, { recursive: true, force: true });
        }
      }
    } finally {
      if (previousMetadata === undefined) delete process.env.KDCO_BACKGROUND_METADATA;
      else process.env.KDCO_BACKGROUND_METADATA = previousMetadata;
    }
  });

  test("rejects malformed generated delegation IDs before creating a child session", async () => {
    const baseDirectory = await mkdtemp(
      join(tmpdir(), "workcell-delegation-id-"),
    );
    let createCalls = 0;
    const client = {
      app: {
        agents: async () => ({ data: [{ name: "explore", mode: "subagent" }] }),
        log: async () => ({}),
      },
      session: {
        get: async ({ path }: { path: { id: string } }) => ({
          data: { id: path.id },
        }),
        create: async () => {
          createCalls += 1;
          return { data: { id: "child" } };
        },
      },
    } as any;
    const Manager = BackgroundAgentsPlugin.testInternals.DelegationManager;
    const manager = new Manager(client, baseDirectory, silentLog as any, {
      idGenerator: () => "../root-b/stolen-result",
    });

    try {
      await expect(
        manager.delegate({
          parentSessionID: "root-a",
          parentMessageID: "message-1",
          parentAgent: "build",
          prompt: "Inspect the repository.",
          agent: "explore",
        }),
      ).rejects.toThrow(/Delegation ID/);
      expect(createCalls).toBe(0);
    } finally {
      await rm(baseDirectory, { recursive: true, force: true });
    }
  });

  test("keeps pending worktree deletes isolated by requesting session", () => {
    const database = createWorktreeStateDatabase();
    try {
      setPendingDelete(database, {
        sessionId: "session-a",
        branch: "branch-a",
        path: "/tmp/a",
      });
      setPendingDelete(database, {
        sessionId: "session-b",
        branch: "branch-b",
        path: "/tmp/b",
      });

      expect(getPendingDelete(database, "session-a")).toEqual({
        sessionId: "session-a",
        branch: "branch-a",
        path: "/tmp/a",
      });
      expect(getPendingDelete(database, "session-b")).toEqual({
        sessionId: "session-b",
        branch: "branch-b",
        path: "/tmp/b",
      });
      expect(getPendingDelete(database, "unrelated-session")).toBeNull();
    } finally {
      database.close();
    }
  });

  test("migrates legacy pending deletes atomically in a bounded file-backed initialization", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "workcell-state-migration-"));
    const projectDirectory = join(sandbox, "project");
    const databaseDirectory = join(sandbox, "state");

    try {
      await mkdir(projectDirectory, { recursive: true });
      const setup = await initStateDb(projectDirectory, { databaseDirectory });
      addSession(setup, {
        id: "legacy-session",
        branch: "legacy-branch",
        path: "/tmp/legacy",
        createdAt: "2026-09-03T00:00:00.000Z",
      });
      setup.exec(`
        INSERT INTO pending_operations (id, type, branch, path, session_id)
        VALUES (1, 'delete', 'legacy-branch', '/tmp/legacy', NULL);
        CREATE TRIGGER reject_legacy_delete
        BEFORE DELETE ON pending_operations
        WHEN OLD.type = 'delete'
        BEGIN
          SELECT RAISE(ABORT, 'blocked legacy delete');
        END;
      `);
      setup.close();

      await expect(
        initStateDb(projectDirectory, { databaseDirectory }),
      ).rejects.toThrow("blocked legacy delete");

      const databasePath = await worktreeStateDatabasePath(
        databaseDirectory,
        projectDirectory,
      );
      const afterRollback = new Database(databasePath);
      expect(getPendingDelete(afterRollback, "legacy-session")).toBeNull();
      expect(
        afterRollback
          .prepare(
            "SELECT COUNT(*) AS count FROM pending_operations WHERE type = 'delete'",
          )
          .get(),
      ).toEqual({ count: 1 });
      afterRollback.exec("DROP TRIGGER reject_legacy_delete");
      afterRollback.close();

      const migrated = await initStateDb(projectDirectory, {
        databaseDirectory,
      });
      expect(getPendingDelete(migrated, "legacy-session")).toEqual({
        sessionId: "legacy-session",
        branch: "legacy-branch",
        path: "/tmp/legacy",
      });
      expect(
        migrated
          .prepare(
            "SELECT COUNT(*) AS count FROM pending_operations WHERE type = 'delete'",
          )
          .get(),
      ).toEqual({ count: 0 });
      migrated.exec("DELETE FROM pending_deletes");
      migrated.close();

      const concurrentWriter = new Database(databasePath);
      concurrentWriter.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
      concurrentWriter.exec(`
        INSERT OR REPLACE INTO pending_operations (id, type, branch, path, session_id)
        VALUES (1, 'delete', 'legacy-branch', '/tmp/legacy', NULL)
      `);

      const readyFile = join(sandbox, "initializer-ready");
      const initializer = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { initStateDb } from "./files/plugins/worktree/state.ts"; await Bun.write(process.env.READY_FILE, "ready"); const db = await initStateDb(process.env.TEST_PROJECT_ROOT, { databaseDirectory: process.env.TEST_DB_DIRECTORY }); db.close();`,
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            READY_FILE: readyFile,
            TEST_PROJECT_ROOT: projectDirectory,
            TEST_DB_DIRECTORY: databaseDirectory,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      for (
        let attempt = 0;
        attempt < 50 && !(await Bun.file(readyFile).exists());
        attempt++
      )
        await Bun.sleep(10);
      expect(await Bun.file(readyFile).exists()).toBe(true);
      const exitedWhileWriteLocked = await Promise.race([
        initializer.exited.then(() => true),
        Bun.sleep(100).then(() => false),
      ]);
      expect(exitedWhileWriteLocked).toBe(false);

      concurrentWriter.exec("COMMIT");
      concurrentWriter.close();
      const exitCode = await Promise.race([
        initializer.exited,
        Bun.sleep(7_000).then(() => null),
      ]);
      if (exitCode === null) initializer.kill();
      const initializerError = await new Response(initializer.stderr).text();
      expect(exitCode, initializerError).toBe(0);

      const afterContention = new Database(databasePath);
      expect(getPendingDelete(afterContention, "legacy-session")).toEqual({
        sessionId: "legacy-session",
        branch: "legacy-branch",
        path: "/tmp/legacy",
      });
      expect(
        afterContention
          .prepare(
            "SELECT COUNT(*) AS count FROM pending_operations WHERE type = 'delete'",
          )
          .get(),
      ).toEqual({ count: 0 });
      afterContention.close();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("ignores unrelated idle events while preserving concurrent worktree deletes", async () => {
    const database = createWorktreeStateDatabase();
    const processPendingDelete = (WorktreePlugin.testInternals as any)
      .processPendingWorktreeDelete;
    const gitCalls: string[][] = [];
    const removeCalls: string[] = [];
    const dependencies = {
      prepareDeleteFn: async () => undefined,
      pathExistsFn: async () => true,
      gitFn: async (args: string[]) => {
        gitCalls.push(args);
        return { ok: true, value: "" };
      },
      removeWorktreeFn: async (_repoRoot: string, worktreePath: string) => {
        removeCalls.push(worktreePath);
        return { ok: true, value: undefined };
      },
    };

    try {
      for (const [id, branch, path] of [
        ["session-a", "branch-a", "/tmp/a"],
        ["session-b", "branch-b", "/tmp/b"],
      ]) {
        addSession(database, {
          id,
          branch,
          path,
          createdAt: "2026-09-03T00:00:00.000Z",
        });
        setPendingDelete(database, { sessionId: id, branch, path });
      }

      await expect(
        processPendingDelete({
          database,
          sessionID: "unrelated",
          repoRoot: "/repo",
          log: silentLog,
          ...dependencies,
        }),
      ).resolves.toEqual({ status: "none" });
      expect(gitCalls).toEqual([]);
      expect(removeCalls).toEqual([]);
      expect(getPendingDelete(database, "session-a")).not.toBeNull();
      expect(getPendingDelete(database, "session-b")).not.toBeNull();

      await expect(
        processPendingDelete({
          database,
          sessionID: "session-a",
          repoRoot: "/repo",
          log: silentLog,
          ...dependencies,
        }),
      ).resolves.toEqual({
        status: "removed",
        branch: "branch-a",
        path: "/tmp/a",
      });
      expect(getPendingDelete(database, "session-a")).toBeNull();
      expect(getSession(database, "session-a")).toBeNull();
      expect(getPendingDelete(database, "session-b")).not.toBeNull();
      expect(getSession(database, "session-b")).not.toBeNull();
    } finally {
      database.close();
    }
  });

  test("reconciles an absent worktree only after Git confirms it is unregistered", async () => {
    const database = createWorktreeStateDatabase();
    const processPendingDelete = (WorktreePlugin.testInternals as any)
      .processPendingWorktreeDelete;
    const gitCalls: string[][] = [];
    let removeCalls = 0;
    addSession(database, {
      id: "session-a",
      branch: "branch-a",
      path: "/tmp/missing-a",
      createdAt: "2026-09-03T00:00:00.000Z",
    });
    setPendingDelete(database, {
      sessionId: "session-a",
      branch: "branch-a",
      path: "/tmp/missing-a",
    });

    try {
      const outcome = await processPendingDelete({
        database,
        sessionID: "session-a",
        repoRoot: "/repo",
        log: silentLog,
        prepareDeleteFn: async () => undefined,
        pathExistsFn: async () => false,
        gitRawFn: async (args: string[]) => {
          gitCalls.push(args);
          return {
            ok: true,
            value: new TextEncoder().encode(
              "worktree /repo\0HEAD abc123\0branch refs/heads/main\0\0",
            ),
          };
        },
        removeWorktreeFn: async () => {
          removeCalls += 1;
          return { ok: true, value: undefined };
        },
      });

      expect(outcome).toEqual({
        status: "reconciled",
        branch: "branch-a",
        path: "/tmp/missing-a",
      });
      expect(gitCalls).toEqual([["worktree", "list", "--porcelain", "-z"]]);
      expect(removeCalls).toBe(0);
      expect(getPendingDelete(database, "session-a")).toBeNull();
      expect(getSession(database, "session-a")).toBeNull();
    } finally {
      database.close();
    }
  });

  test("retains absent worktree state when Git still registers it or verification fails", async () => {
    const processPendingDelete = (WorktreePlugin.testInternals as any)
      .processPendingWorktreeDelete;
    const scenarios = [
      {
        name: "registered",
        gitResult: {
          ok: true,
          value: new TextEncoder().encode(
            "worktree /tmp/missing-a\0HEAD abc123\0branch refs/heads/branch-a\0\0",
          ),
        },
        reason: "remains registered with Git",
      },
      {
        name: "verification-failed",
        gitResult: { ok: false, error: "git metadata unavailable" },
        reason: "git metadata unavailable",
      },
      {
        name: "unrecognized-output",
        gitResult: {
          ok: true,
          value: new TextEncoder().encode(
            "worktree /repo\0HEAD abc123\0future-field value\0\0",
          ),
        },
        reason: "unrecognized field",
      },
    ] as const;

    for (const scenario of scenarios) {
      const database = createWorktreeStateDatabase();
      const gitCalls: string[][] = [];
      addSession(database, {
        id: "session-a",
        branch: "branch-a",
        path: "/tmp/missing-a",
        createdAt: "2026-09-03T00:00:00.000Z",
      });
      setPendingDelete(database, {
        sessionId: "session-a",
        branch: "branch-a",
        path: "/tmp/missing-a",
      });

      try {
        const outcome = await processPendingDelete({
          database,
          sessionID: "session-a",
          repoRoot: "/repo",
          log: silentLog,
          prepareDeleteFn: async () => undefined,
          pathExistsFn: async () => false,
          gitRawFn: async (args: string[]) => {
            gitCalls.push(args);
            return scenario.gitResult;
          },
          removeWorktreeFn: async () => {
            throw new Error("removal must not run during reconciliation");
          },
        });

        expect(outcome.status, scenario.name).toBe("retained");
        expect(
          "reason" in outcome ? outcome.reason : "",
          scenario.name,
        ).toContain(scenario.reason);
        expect(gitCalls, scenario.name).toEqual([
          ["worktree", "list", "--porcelain", "-z"],
        ]);
        expect(
          getPendingDelete(database, "session-a"),
          scenario.name,
        ).not.toBeNull();
        expect(getSession(database, "session-a"), scenario.name).not.toBeNull();
      } finally {
        database.close();
      }
    }
  });

  test("rolls back production cleanup and later reconciles through real Git", async () => {
    const sandbox = await mkdtemp(
      join(tmpdir(), "workcell-delete-transaction-"),
    );
    const projectDirectory = join(sandbox, "project");
    const missingWorktreePath = join(sandbox, "missing-worktree");
    let database: Database | undefined;

    try {
      await createGitRepository(projectDirectory);
      database = await initStateDb(projectDirectory, {
        databaseDirectory: join(sandbox, "state"),
      });
      addSession(database, {
        id: "session-a",
        branch: "branch-a",
        path: missingWorktreePath,
        createdAt: "2026-09-03T00:00:00.000Z",
      });
      setPendingDelete(database, {
        sessionId: "session-a",
        branch: "branch-a",
        path: missingWorktreePath,
      });
      database.exec(`
        CREATE TRIGGER abort_session_delete
        BEFORE DELETE ON sessions
        WHEN OLD.id = 'session-a'
        BEGIN
          SELECT RAISE(ABORT, 'forced session cleanup failure');
        END;
      `);

      const createPlugin = (WorktreePlugin.testInternals as any)
        .createWorktreePlugin;
      const plugin = await createPlugin(
        {
          directory: projectDirectory,
          client: { app: { log: async () => ({}) } },
        },
        { database },
      );

      await plugin.event({
        event: { type: "session.idle", properties: { sessionID: "session-a" } },
      });
      expect(getPendingDelete(database, "session-a")).toEqual({
        sessionId: "session-a",
        branch: "branch-a",
        path: missingWorktreePath,
      });
      expect(getSession(database, "session-a")).not.toBeNull();

      database.exec("DROP TRIGGER abort_session_delete");
      await plugin.event({
        event: { type: "session.idle", properties: { sessionID: "session-a" } },
      });
      expect(getPendingDelete(database, "session-a")).toBeNull();
      expect(getSession(database, "session-a")).toBeNull();
    } finally {
      database?.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("production reconciliation retains a missing quoted worktree registered through a symlink alias", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "workcell-quoted-worktree-"));
    const projectDirectory = join(sandbox, "project");
    const realWorktreeParent = join(sandbox, "real-worktrees");
    const aliasedWorktreeParent = join(sandbox, "aliased-worktrees");
    const aliasedWorktreePath = join(aliasedWorktreeParent, "quoted\nworktree");
    let database: Database | undefined;

    try {
      await createGitRepository(projectDirectory);
      await mkdir(realWorktreeParent, { recursive: true });
      await symlink(realWorktreeParent, aliasedWorktreeParent);
      await runGit(
        ["worktree", "add", "-b", "quoted-worktree", aliasedWorktreePath],
        projectDirectory,
      );
      const physicalWorktreePath = await realpath(aliasedWorktreePath);
      await rm(physicalWorktreePath, { recursive: true, force: true });

      database = await initStateDb(projectDirectory, {
        databaseDirectory: join(sandbox, "state"),
      });
      addSession(database, {
        id: "session-a",
        branch: "quoted-worktree",
        path: aliasedWorktreePath,
        createdAt: "2026-09-03T00:00:00.000Z",
      });
      setPendingDelete(database, {
        sessionId: "session-a",
        branch: "quoted-worktree",
        path: aliasedWorktreePath,
      });

      const createPlugin = (WorktreePlugin.testInternals as any)
        .createWorktreePlugin;
      const plugin = await createPlugin(
        {
          directory: projectDirectory,
          client: { app: { log: async () => ({}) } },
        },
        { database },
      );

      await plugin.event({
        event: { type: "session.idle", properties: { sessionID: "session-a" } },
      });

      expect(getPendingDelete(database, "session-a")).toEqual({
        sessionId: "session-a",
        branch: "quoted-worktree",
        path: aliasedWorktreePath,
      });
      expect(getSession(database, "session-a")).not.toBeNull();
    } finally {
      database?.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("production reconciliation does not run preDelete hooks in an absent worktree", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "workcell-absent-predelete-"));
    const projectDirectory = join(sandbox, "project");
    const missingWorktreePath = join(sandbox, "missing-worktree");
    const database = createWorktreeStateDatabase();

    try {
      await createGitRepository(projectDirectory);
      await mkdir(join(projectDirectory, ".opencode"), { recursive: true });
      await writeFile(
        join(projectDirectory, ".opencode", "worktree.jsonc"),
        JSON.stringify({ hooks: { postCreate: [], preDelete: ["exit 23"] } }),
      );
      addSession(database, {
        id: "session-a",
        branch: "branch-a",
        path: missingWorktreePath,
        createdAt: "2026-09-03T00:00:00.000Z",
      });
      setPendingDelete(database, {
        sessionId: "session-a",
        branch: "branch-a",
        path: missingWorktreePath,
      });

      const createPlugin = (WorktreePlugin.testInternals as any)
        .createWorktreePlugin;
      const plugin = await createPlugin(
        {
          directory: projectDirectory,
          client: { app: { log: async () => ({}) } },
        },
        { database },
      );

      await plugin.event({
        event: { type: "session.idle", properties: { sessionID: "session-a" } },
      });

      expect(getPendingDelete(database, "session-a")).toBeNull();
      expect(getSession(database, "session-a")).toBeNull();
    } finally {
      database.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("retains worktree delete state after every snapshot or removal failure", async () => {
    const processPendingDelete = (WorktreePlugin.testInternals as any)
      .processPendingWorktreeDelete;
    const scenarios = [
      { name: "add", results: [{ ok: false, error: "add failed" }] },
      {
        name: "commit",
        results: [
          { ok: true, value: "" },
          { ok: false, error: "commit failed" },
        ],
      },
      {
        name: "status",
        results: [
          { ok: true, value: "" },
          { ok: true, value: "" },
          { ok: false, error: "status failed" },
        ],
      },
      {
        name: "dirty",
        results: [
          { ok: true, value: "" },
          { ok: true, value: "" },
          { ok: true, value: " M changed.ts" },
        ],
      },
      {
        name: "remove",
        results: [
          { ok: true, value: "" },
          { ok: true, value: "" },
          { ok: true, value: "" },
        ],
        removeError: "remove failed",
      },
    ] as const;

    for (const scenario of scenarios) {
      const database = createWorktreeStateDatabase();
      let resultIndex = 0;
      let removeCalls = 0;
      addSession(database, {
        id: "session-a",
        branch: "branch-a",
        path: "/tmp/a",
        createdAt: "2026-09-03T00:00:00.000Z",
      });
      setPendingDelete(database, {
        sessionId: "session-a",
        branch: "branch-a",
        path: "/tmp/a",
      });

      try {
        const outcome = await processPendingDelete({
          database,
          sessionID: "session-a",
          repoRoot: "/repo",
          log: silentLog,
          prepareDeleteFn: async () => undefined,
          pathExistsFn: async () => true,
          gitFn: async () => scenario.results[resultIndex++],
          removeWorktreeFn: async () => {
            removeCalls += 1;
            const removeError =
              "removeError" in scenario ? scenario.removeError : undefined;
            return removeError
              ? { ok: false, error: removeError }
              : { ok: true, value: undefined };
          },
        });

        expect(outcome.status).toBe("retained");
        expect(
          getPendingDelete(database, "session-a"),
          scenario.name,
        ).not.toBeNull();
        expect(getSession(database, "session-a"), scenario.name).not.toBeNull();
        expect(removeCalls, scenario.name).toBe(
          scenario.name === "remove" ? 1 : 0,
        );
      } finally {
        database.close();
      }
    }
  });

  test("production idle handling retains the matching session when preDelete fails", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "workcell-predelete-"));
    const projectDirectory = join(sandbox, "project");
    const worktreePath = join(sandbox, "worktree");
    const database = createWorktreeStateDatabase();
    const gitCalls: string[][] = [];
    let removeCalls = 0;

    try {
      await mkdir(join(projectDirectory, ".opencode"), { recursive: true });
      await mkdir(worktreePath, { recursive: true });
      await writeFile(
        join(projectDirectory, ".opencode", "worktree.jsonc"),
        JSON.stringify({ hooks: { postCreate: [], preDelete: ["exit 23"] } }),
      );

      const createPlugin = (WorktreePlugin.testInternals as any)
        .createWorktreePlugin;
      const plugin = await createPlugin(
        {
          directory: projectDirectory,
          client: { app: { log: async () => ({}) } },
        },
        {
          database,
          gitFn: async (args: string[]) => {
            gitCalls.push(args);
            return { ok: true, value: "" };
          },
          removeWorktreeFn: async () => {
            removeCalls += 1;
            return { ok: true, value: undefined };
          },
        },
      );
      addSession(database, {
        id: "session-a",
        branch: "branch-a",
        path: worktreePath,
        createdAt: "2026-09-03T00:00:00.000Z",
      });

      await plugin.tool.worktree_delete.execute(
        { reason: "finished" },
        { sessionID: "session-a" },
      );
      await plugin.event({
        event: {
          type: "session.idle",
          properties: { sessionID: "unrelated-session" },
        },
      });
      expect(getPendingDelete(database, "session-a")).not.toBeNull();
      expect(gitCalls).toEqual([]);
      expect(removeCalls).toBe(0);

      await plugin.event({
        event: { type: "session.idle", properties: { sessionID: "session-a" } },
      });
      expect(getPendingDelete(database, "session-a")).toEqual({
        sessionId: "session-a",
        branch: "branch-a",
        path: worktreePath,
      });
      expect(getSession(database, "session-a")).not.toBeNull();
      expect(gitCalls).toEqual([]);
      expect(removeCalls).toBe(0);
    } finally {
      database.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("production idle handling retains matched and unrelated state for schema-invalid config", async () => {
    const sandbox = await mkdtemp(
      join(tmpdir(), "workcell-invalid-delete-config-"),
    );
    const projectDirectory = join(sandbox, "project");
    const database = createWorktreeStateDatabase();
    const gitCalls: string[][] = [];
    let removeCalls = 0;

    try {
      await mkdir(join(projectDirectory, ".opencode"), { recursive: true });
      await writeFile(
        join(projectDirectory, ".opencode", "worktree.jsonc"),
        JSON.stringify({
          hooks: { postCreate: [], preDelete: "must-be-an-array" },
        }),
      );
      for (const [id, branch, worktreePath] of [
        ["session-a", "branch-a", join(sandbox, "worktree-a")],
        ["session-b", "branch-b", join(sandbox, "worktree-b")],
      ]) {
        addSession(database, {
          id,
          branch,
          path: worktreePath,
          createdAt: "2026-09-03T00:00:00.000Z",
        });
        setPendingDelete(database, {
          sessionId: id,
          branch,
          path: worktreePath,
        });
      }

      const createPlugin = (WorktreePlugin.testInternals as any)
        .createWorktreePlugin;
      const plugin = await createPlugin(
        {
          directory: projectDirectory,
          client: { app: { log: async () => ({}) } },
        },
        {
          database,
          gitFn: async (args: string[]) => {
            gitCalls.push(args);
            return { ok: true, value: "" };
          },
          removeWorktreeFn: async () => {
            removeCalls += 1;
            return { ok: true, value: undefined };
          },
        },
      );

      await plugin.event({
        event: { type: "session.idle", properties: { sessionID: "session-a" } },
      });

      expect(gitCalls).toEqual([]);
      expect(removeCalls).toBe(0);
      expect(getPendingDelete(database, "session-a")).not.toBeNull();
      expect(getSession(database, "session-a")).not.toBeNull();
      expect(getPendingDelete(database, "session-b")).not.toBeNull();
      expect(getSession(database, "session-b")).not.toBeNull();

      await writeFile(
        join(projectDirectory, ".opencode", "worktree.jsonc"),
        "{ invalid jsonc",
      );
      await plugin.event({
        event: { type: "session.idle", properties: { sessionID: "session-a" } },
      });
      expect(gitCalls).toEqual([]);
      expect(removeCalls).toBe(0);
      expect(getPendingDelete(database, "session-a")).not.toBeNull();
      expect(getSession(database, "session-a")).not.toBeNull();
    } finally {
      database.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("production idle handling retains state on non-ENOENT config read failure", async () => {
    const sandbox = await mkdtemp(
      join(tmpdir(), "workcell-unreadable-delete-config-"),
    );
    const projectDirectory = join(sandbox, "project");
    const worktreePath = join(sandbox, "worktree");
    const database = createWorktreeStateDatabase();
    let gitCalls = 0;
    let removeCalls = 0;

    try {
      await mkdir(projectDirectory, { recursive: true });
      addSession(database, {
        id: "session-a",
        branch: "branch-a",
        path: worktreePath,
        createdAt: "2026-09-03T00:00:00.000Z",
      });
      setPendingDelete(database, {
        sessionId: "session-a",
        branch: "branch-a",
        path: worktreePath,
      });

      const createPlugin = (WorktreePlugin.testInternals as any)
        .createWorktreePlugin;
      const plugin = await createPlugin(
        {
          directory: projectDirectory,
          client: { app: { log: async () => ({}) } },
        },
        {
          database,
          readConfigFileFn: async () => {
            const error = new Error(
              "permission denied",
            ) as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
          },
          gitFn: async () => {
            gitCalls += 1;
            return { ok: true, value: "" };
          },
          removeWorktreeFn: async () => {
            removeCalls += 1;
            return { ok: true, value: undefined };
          },
        },
      );

      await plugin.event({
        event: { type: "session.idle", properties: { sessionID: "session-a" } },
      });

      expect(gitCalls).toBe(0);
      expect(removeCalls).toBe(0);
      expect(getPendingDelete(database, "session-a")).not.toBeNull();
      expect(getSession(database, "session-a")).not.toBeNull();
    } finally {
      database.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("normalizes standalone tester statuses with balanced Markdown", async () => {
    const hooks = await WorkspacePlugin({ directory: repositoryRoot, client: {} } as any) as any;
    const renderings = [
      (status: string) => `RESULT: ${status}`,
      (status: string) => `  result: ${status.toUpperCase()}  \r\nCOMMANDS: bun run test`,
      (status: string) => `**RESULT:** ${status}`,
      (status: string) => `__RESULT:__ ${status}`,
      (status: string) => `**RESULT: ${status}**`,
      (status: string) => `__RESULT: ${status}__`,
      (status: string) => `\`RESULT: ${status}\``,
      (status: string) => `RESULT: **${status}**`,
      (status: string) => `RESULT: __${status}__`,
      (status: string) => `RESULT: \`${status}\``,
      (status: string) => `RESULT: ${status}\n**RESULT: ${status.toUpperCase()}**`,
    ];
    for (const status of ["passed", "failed", "blocked", "infrastructure-error"]) {
      for (const [index, render] of renderings.entries()) {
        const input = { tool: "task", sessionID: "status-normalization", callID: `${status}-${index}` };
        await hooks["tool.execute.before"](input, { args: { subagent_type: "tester" } });
        const output = { title: "", output: render(status), metadata: {} };
        await hooks["tool.execute.after"](input, output);
        expect(output.output).toContain(`Tester RESULT is ${status}.`);
        expect(output.output).not.toContain("Tester result is invalid");
      }
    }
  });

  test.each([
    "No status supplied",
    "RESULT: unknown",
    "RESULT: passed\nRESULT: failed",
    "**RESULT: passed**\nRESULT: __blocked__",
    "RESULT: passed\nRESULT: unknown",
    "**RESULT: passed__",
    "RESULT: **passed__",
    "RESULT: `passed",
    "RESULT: passed**",
    "The RESULT: passed",
    "> RESULT: passed",
    "RESULT: passed with limitations",
  ])("requests report-only correction, not blind reruns, for %s", async (report) => {
    const hooks = await WorkspacePlugin({ directory: repositoryRoot, client: {} } as any) as any;
    const input = { tool: "task", sessionID: "invalid-status", callID: "invalid-status-call" };
    await hooks["tool.execute.before"](input, { args: { subagent_type: "tester" } });
    const output = { title: "", output: report, metadata: {} };
    await hooks["tool.execute.after"](input, output);
    const reminder = output.output.slice(report.length);
    expect(reminder).toContain("Tester result is invalid");
    expect(reminder).toContain("report-only correction");
    expect(reminder).toContain("existing tester evidence");
    expect(reminder).toContain("do not rerun commands solely for formatting");
    expect(reminder).toMatch(/If actual verification evidence is missing.*fresh verification of the gap/s);
    expect(reminder).toContain("Do not route a reporting failure to debugger");
    expect(reminder).not.toContain("proceed to `reviewer`");
  });

  test.each(["coder", "tester"])("tracks concurrent %s calls per session without claiming whole-plan completion", async (agent) => {
    const hooks = await WorkspacePlugin({ directory: repositoryRoot, client: {} } as any) as any;
    const calls = ["first", "second", "other-root"].map((callID) => ({
      tool: "task", sessionID: callID === "other-root" ? "batch-b" : "batch-a", callID: `${agent}-${callID}`,
    }));
    await Promise.all(calls.map((input) => hooks["tool.execute.before"](input, { args: { subagent_type: agent } })));
    const result = agent === "coder" ? "RESULT: completed" : "RESULT: passed";
    const finish = async (input: typeof calls[number]) => {
      const output = { title: "", output: result, metadata: {} };
      await hooks["tool.execute.after"](input, output);
      return output.output;
    };
    expect(await finish(calls[0]!)).toBe(result);

    const completed = await finish(calls[1]!);
    if (agent === "coder") {
      expect(completed).toContain("When an implementation batch is ready");
      expect(completed).toContain("does not mean the final planned task");
      expect(completed).toContain("independent existing verification");
    } else {
      expect(completed).toContain("only the verified scope");
      expect(completed).toContain("do not imply the entire plan is verified");
    }
    expect(await finish(calls[1]!)).toBe(result);
    expect(await finish(calls[2]!)).toContain("<system-reminder>");
  });

  test("plan_read explicit archive path never substitutes the shared plan", async () => {
    const sandbox = await mkdtemp(join(repositoryRoot, ".plan-read-test-"));
    const home = spyOn(os, "homedir").mockReturnValue(sandbox);
    const keys = ["HOME", "PLANNOTATOR_DATA_DIR", "XDG_DATA_HOME"] as const;
    const previous = keys.map((key) => process.env[key]);
    process.env.HOME = sandbox;
    delete process.env.PLANNOTATOR_DATA_DIR;
    delete process.env.XDG_DATA_HOME;
    try {
      const archive = join(sandbox, ".plannotator", "plans");
      await mkdir(archive, { recursive: true });
      const selected = join(archive, "selected.md");
      const markdown =
        "# User-selected archive\n\nArbitrary Markdown — not a Workcell plan.\n";
      await writeFile(selected, markdown);
      const hooks = (await WorkspacePlugin({
        directory: sandbox,
        client: {
          session: {
            get: async ({ path }: { path: { id: string } }) => ({
              data: {
                id: path.id,
                parentID: path.id === "child" ? "root" : undefined,
              },
            }),
          },
        },
      } as any)) as any;
      const shared =
        "---\nstatus: in-progress\nphase: 1\nupdated: 2026-09-10\n---\n\n## Goal\nKeep the different shared plan.\n\n## Phase 1: Work [IN PROGRESS]\n- [ ] 1.1 Keep shared state ← CURRENT\n";
      expect(
        await hooks.tool.plan_save.execute(
          { content: shared },
          { sessionID: "root" },
        ),
      ).toBe("Plan saved.");
      expect(
        await hooks.tool.plan_read.execute(
          { reason: "Selected source", path: selected },
          { sessionID: "child" },
        ),
      ).toBe(markdown);
      const read = (path: string, sessionID = "child") =>
        hooks.tool.plan_read.execute(
          { reason: "Selected source", path },
          { sessionID },
        );
      expect(await read("~/.plannotator/plans/selected.md")).toBe(markdown);
      expect(await read(selected, "no-shared-plan")).toBe(markdown);
      expect(
        await hooks.tool.plan_read.execute(
          { reason: "Guard", path: selected },
          {},
        ),
      ).toContain("requires sessionID");
      const before = await readdir(sandbox, { recursive: true });
      for (const input of [
        "",
        "selected.md",
        "https://example.com/plan.md",
        "file:///plan.md",
        "~other/plans/a.md",
        "$HOME/a.md",
        `${archive}/$(id).md`,
        `${archive}/*.md`,
      ]) {
        expect(await read(input)).toContain("Archive plan input:");
      }
      for (const input of [
        `${archive}/../outside.md`,
        `${archive}-sibling/a.md`,
        join(sandbox, "unrelated.md"),
      ]) {
        expect(await read(input)).toContain("Archive plan location:");
      }
      expect(await read(join(archive, "a.txt"))).toContain("select a .md file");
      expect(await read(join(archive, "missing", "a.md"))).toContain(
        "Archive plan missing:",
      );
      expect((await readdir(sandbox, { recursive: true })).sort()).toEqual(
        before.sort(),
      );
      await mkdir(join(archive, "directory.md"));
      expect(await read(join(archive, "directory.md"))).toContain(
        "Archive plan nonregular",
      );
      await symlink(selected, join(archive, "linked.md"));
      await symlink(archive, join(archive, "linked-dir"));
      expect(await read(join(archive, "linked.md"))).toContain(
        "Archive plan symlink:",
      );
      expect(await read(join(archive, "linked-dir", "selected.md"))).toContain(
        "Archive plan symlink:",
      );
      const fifo = join(archive, "pipe.md");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      expect(await read(fifo)).toContain("Archive plan nonregular");
      const limit = join(archive, "limit.md");
      const exact = "é".repeat(512 * 1024);
      await writeFile(limit, exact);
      expect(await read(limit)).toBe(exact);
      await writeFile(limit, `${exact}x`);
      expect(await read(limit)).toContain("Archive plan size:");
      expect(await readFile(selected, "utf8")).toBe(markdown);
      expect(
        await hooks.tool.plan_read.execute(
          { reason: "Shared unchanged" },
          { sessionID: "child" },
        ),
      ).toBe(shared);
      const compacted = { context: [] as string[] };
      await hooks["experimental.session.compacting"](
        { sessionID: "child" },
        compacted,
      );
      expect(compacted.context.join("\n")).toContain(shared);
      expect(compacted.context.join("\n")).not.toContain(markdown);
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      home.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test.each(["configured", "legacy"])("archive startup failure (%s) preserves shared plan tools and compaction", async (source) => {
    const sandbox = await mkdtemp(join(repositoryRoot, ".plan-read-test-"));
    const home = spyOn(os, "homedir").mockReturnValue(sandbox);
    const keys = ["HOME", "PLANNOTATOR_DATA_DIR", "XDG_DATA_HOME"] as const;
    const previous = keys.map((key) => process.env[key]);
    try {
      const blocker = join(sandbox, "blocker");
      await writeFile(blocker, "not a directory");
      process.env.HOME = source === "legacy" ? blocker : sandbox;
      if (source === "configured") {
        process.env.PLANNOTATOR_DATA_DIR = join(blocker, "nested", "data");
      } else {
        delete process.env.PLANNOTATOR_DATA_DIR;
      }
      process.env.XDG_DATA_HOME = join(sandbox, "xdg");
      const selected = join(
        source === "configured" ? process.env.PLANNOTATOR_DATA_DIR! : join(blocker, ".plannotator"),
        "plans", "selected.md",
      );
      const hooks = (await WorkspacePlugin({
        directory: sandbox,
        client: {
          session: {
            get: async ({ path }: { path: { id: string } }) => ({
              data: { id: path.id, parentID: path.id === "child" ? "root" : undefined },
            }),
          },
        },
      } as any)) as any;
      const shared = "---\nstatus: in-progress\nphase: 1\nupdated: 2026-09-10\n---\n\n## Goal\nKeep shared tools available.\n\n## Phase 1: Work [IN PROGRESS]\n- [ ] 1.1 Preserve shared state ← CURRENT\n";
      expect(await hooks.tool.plan_save.execute({ content: shared }, { sessionID: "root" })).toBe("Plan saved.");
      const read = (path?: string) => hooks.tool.plan_read.execute(
        { reason: "Startup failure isolation", ...(path === undefined ? {} : { path }) },
        { sessionID: "child" },
      );
      expect(await read()).toBe(shared);
      const failure = await read(selected);
      expect(failure).toContain("Archive plan unavailable");
      expect(failure).toContain("ENOTDIR");
      expect(failure).toContain(blocker);
      expect(failure).toContain("restart");
      expect(failure).not.toContain(shared);
      // A later valid configuration must not revive or redirect this startup reader.
      process.env.HOME = sandbox;
      process.env.PLANNOTATOR_DATA_DIR = join(sandbox, "valid-data");
      await mkdir(join(process.env.PLANNOTATOR_DATA_DIR, "plans"), { recursive: true });
      const other = join(process.env.PLANNOTATOR_DATA_DIR, "plans", "other.md");
      await writeFile(other, "A different archive plan");
      expect(await read(other)).toBe(failure);
      expect(await read()).toBe(shared);
      const compacted = { context: [] as string[] };
      await hooks["experimental.session.compacting"]({ sessionID: "child" }, compacted);
      expect(compacted.context.join("\n")).toContain(shared);
      expect(compacted.context.join("\n")).not.toContain("A different archive plan");
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      home.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("plan_read archive captures startup precedence and rejects linked roots without creating state", async () => {
    const sandbox = await mkdtemp(join(repositoryRoot, ".plan-read-test-"));
    const keys = ["HOME", "PLANNOTATOR_DATA_DIR", "XDG_DATA_HOME"] as const;
    const previous = keys.map((key) => process.env[key]);
    process.env.HOME = sandbox;
    delete process.env.PLANNOTATOR_DATA_DIR;
    process.env.XDG_DATA_HOME = join(sandbox, "xdg");
    try {
      // An ancestry lookup would fail: explicit reads require a session, not its tree.
      const create = async () => {
        const hooks = (await WorkspacePlugin({
          directory: sandbox,
          client: {},
        } as any)) as any;
        return hooks.tool.plan_read;
      };
      const read = (tool: any, path: string) =>
        tool.execute(
          { reason: "Archive boundary", path },
          { sessionID: "child" },
        );
      const put = async (data: string) => {
        await mkdir(join(data, "plans"), { recursive: true });
        const file = join(data, "plans", "plan.md");
        await writeFile(file, data);
        return file;
      };
      const xdg = join(sandbox, "xdg", "plannotator");
      const xdgFile = await put(xdg);
      const xdgReader = await create();
      expect(await read(xdgReader, xdgFile)).toBe(xdg);
      const legacy = join(sandbox, ".plannotator");
      const legacyFile = await put(legacy);
      process.env.PLANNOTATOR_DATA_DIR = "  ";
      const legacyReader = await create();
      expect(await read(legacyReader, legacyFile)).toBe(legacy);
      expect(await read(xdgReader, legacyFile)).toContain(
        "Archive plan location:",
      );
      const custom = join(sandbox, "custom");
      const customFile = await put(custom);
      for (const configured of [
        custom,
        "~/custom",
        relative(process.cwd(), custom),
      ]) {
        process.env.PLANNOTATOR_DATA_DIR = configured;
        const captured = await create();
        process.env.PLANNOTATOR_DATA_DIR = legacy;
        process.env.HOME = join(sandbox, "changed-home");
        const cwd = spyOn(process, "cwd").mockReturnValue(sandbox);
        try {
          expect(await read(captured, customFile)).toBe(custom);
        } finally {
          cwd.mockRestore();
        }
        expect(await read(captured, "~/custom/plans/plan.md")).toBe(custom);
        expect(await read(captured, legacyFile)).toContain(
          "Archive plan location:",
        );
        process.env.HOME = sandbox;
      }
      const alias = join(sandbox, "home-alias");
      await symlink(sandbox, alias);
      process.env.HOME = alias;
      delete process.env.PLANNOTATOR_DATA_DIR;
      const aliasReader = await create();
      expect(await read(aliasReader, legacyFile)).toBe(legacy);
      expect(await read(aliasReader, "~/.plannotator/plans/plan.md")).toBe(
        legacy,
      );
      await rm(alias);
      process.env.HOME = sandbox;
      const linkedData = join(sandbox, "linked-data");
      await symlink(custom, linkedData);
      process.env.PLANNOTATOR_DATA_DIR = linkedData;
      expect(
        await read(await create(), join(linkedData, "plans", "plan.md")),
      ).toContain("Archive plan symlink:");
      const linkedArchive = join(sandbox, "linked-archive");
      await mkdir(linkedArchive);
      await symlink(join(custom, "plans"), join(linkedArchive, "plans"));
      process.env.PLANNOTATOR_DATA_DIR = linkedArchive;
      expect(
        await read(await create(), join(linkedArchive, "plans", "plan.md")),
      ).toContain("Archive plan symlink:");
      await rm(legacy, { recursive: true });
      process.env.PLANNOTATOR_DATA_DIR = "  ";
      expect(await read(await create(), xdgFile)).toBe(xdg);
      delete process.env.PLANNOTATOR_DATA_DIR;
      process.env.XDG_DATA_HOME = "relative-xdg";
      const before = await readdir(sandbox, { recursive: true });
      expect(await read(await create(), legacyFile)).toContain(
        "Archive plan missing:",
      );
      delete process.env.XDG_DATA_HOME;
      expect(await read(await create(), legacyFile)).toContain(
        "Archive plan missing:",
      );
      process.env.PLANNOTATOR_DATA_DIR = join(sandbox, "absent");
      expect(
        await read(await create(), join(sandbox, "absent", "plans", "a.md")),
      ).toContain("Archive plan missing:");
      expect((await readdir(sandbox, { recursive: true })).sort()).toEqual(
        before.sort(),
      );
      await mkdir(join(sandbox, "absent"));
      expect(
        await read(await create(), join(sandbox, "absent", "plans", "a.md")),
      ).toContain("Archive plan missing:");
      await writeFile(join(sandbox, "absent", "plans"), "not a directory");
      expect(
        await read(await create(), join(sandbox, "absent", "plans", "a.md")),
      ).toContain("Archive plan nonregular");
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("saves shared plans without review reminders and preserves validation and root isolation", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "workcell-plan-save-"));
    const home = spyOn(os, "homedir").mockReturnValue(sandbox);
    const previousHome = process.env.HOME;
    process.env.HOME = sandbox;

    try {
      const hooks = (await WorkspacePlugin({
        directory: sandbox,
        client: {
          session: {
            get: async ({ path }: { path: { id: string } }) => ({
              data: {
                id: path.id,
                parentID: new Map([["child", "session-a"], ["grandchild", "child"]]).get(path.id),
              },
            }),
          },
        },
      } as any)) as any;
      const validPlan = `---\nstatus: in-progress\nphase: 1\nupdated: 2026-09-03\n---\n\n# Implementation Plan\n\n## Goal\nRepair the validated plan workflow.\n\n## Phase 1: Repair [IN PROGRESS]\n- [ ] 1.1 Apply the repair ← CURRENT\n`;
      const successOutput = {
        title: "",
        output: await hooks.tool.plan_save.execute(
          { content: validPlan },
          { sessionID: "session-a" },
        ),
        metadata: {},
      };
      await hooks["tool.execute.after"](
        { tool: "plan_save", sessionID: "session-a", callID: "call-a" },
        successOutput,
      );
      expect(successOutput.output).toBe("Plan saved.");
      const readPlan = (sessionID: string) =>
        hooks.tool.plan_read.execute({ reason: "Verify session scope" }, { sessionID });
      expect(await readPlan("session-a")).toBe(validPlan);
      expect(await readPlan("child")).toBe(validPlan);
      expect(await readPlan("grandchild")).toBe(validPlan);
      expect(await readPlan("session-b")).toBe("No plan found.");

      const otherPlan = validPlan.replace("Repair the validated plan workflow.", "Keep unrelated work isolated.");
      await hooks.tool.plan_save.execute({ content: otherPlan }, { sessionID: "session-b" });
      const revisedPlan = validPlan.replace("Apply the repair", "Apply the revised repair");
      expect(await hooks.tool.plan_save.execute(
        { content: revisedPlan }, { sessionID: "grandchild" },
      )).toBe("Plan saved.");
      expect(await readPlan("session-a")).toBe(revisedPlan);
      expect(await readPlan("child")).toBe(revisedPlan);
      expect(await readPlan("session-b")).toBe(otherPlan);

      const compacted = { context: [] as string[] };
      await hooks["experimental.session.compacting"]({ sessionID: "child" }, compacted);
      expect(compacted.context.join("\n")).toContain(revisedPlan);
      expect(compacted.context.join("\n")).not.toContain(otherPlan);
      expect(compacted.context.join("\n")).toContain("may not reflect execution progress");

      const failureOutput = {
        title: "",
        output: await hooks.tool.plan_save.execute(
          { content: "not a valid plan" },
          { sessionID: "session-a" },
        ),
        metadata: {},
      };
      const originalFailure = failureOutput.output;
      await hooks["tool.execute.after"](
        { tool: "plan_save", sessionID: "session-a", callID: "call-b" },
        failureOutput,
      );
      expect(failureOutput.output).toBe(originalFailure);
      expect(failureOutput.output).not.toContain("delegate to the reviewer");
      expect(failureOutput.output).toContain("❌");
      expect(await readPlan("session-a")).toBe(revisedPlan);
      expect(await readPlan("session-b")).toBe(otherPlan);

      const warningOutput = {
        title: "",
        output: await hooks.tool.plan_save.execute(
          { content: `${revisedPlan}\n## Phase 2: Follow-up [IN PROGRESS]\n- [ ] 2.1 Check the revision\n` },
          { sessionID: "child" },
        ),
        metadata: {},
      };
      const originalWarning = warningOutput.output;
      await hooks["tool.execute.after"](
        { tool: "plan_save", sessionID: "child", callID: "warning-call" }, warningOutput,
      );
      expect(warningOutput.output).toBe(originalWarning);
      expect(warningOutput.output).toContain("Plan saved.");
      expect(warningOutput.output).toContain("warnings:");

      for (const agent of ["plan", "build"]) {
        const output = { system: [] as string[] };
        await hooks["experimental.chat.system.transform"]({ agent }, output);
        const rules = output.system.join("\n");
        expect(rules).toContain("design artifact, not a live progress ledger");
        expect(rules).toContain("does not automatically require review, delegation, or a reread");
        expect(rules).toContain("do not repeat reads for each task");
        expect(rules).toContain("do not copy the full plan into prompts");
        expect(rules).toContain("task IDs or section references");
        expect(rules).not.toContain("Update immediately");
        if (agent === "build") {
          expect(rules).toContain("Do not claim completion without independent tester evidence");
          expect(rules).toContain("Do NOT review before tester evidence");
        }
      }

      for (const [agent, result, reminder] of [
        ["coder", "Implementation ready", "independent existing verification"],
        ["tester", "RESULT: passed", "proceed to `reviewer`"],
        ["tester", "RESULT: failed", "Route correction"],
        ["tester", "RESULT: blocked", "material verification limitation"],
        ["tester", "RESULT: infrastructure-error", "material verification limitation"],
        ["tester", "No result", "Tester result is invalid"],
      ]) {
        const input = { tool: "task", sessionID: "session-a", callID: `verify-${agent}-${result}` };
        await hooks["tool.execute.before"](input, { args: { subagent_type: agent } });
        const output = { title: "", output: result, metadata: {} };
        await hooks["tool.execute.after"](input, output);
        expect(output.output).toContain(reminder);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      home.mockRestore();
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe("registry build output boundary", () => {
  test("rejects unsafe output paths", async () => {
    await expect(
      outputDirectory(["--out", "."], repositoryRoot),
    ).rejects.toThrow("current directory");
    await expect(
      outputDirectory(["--out", dirname(repositoryRoot)], repositoryRoot),
    ).rejects.toThrow("repository root or one of its ancestors");
    await expect(
      outputDirectory(["--out", "/"], repositoryRoot),
    ).rejects.toThrow("filesystem root");
  });

  test("permits exact dist or external directories and rejects symlinks", async () => {
    const temporaryRepository = await mkdtemp(
      join(tmpdir(), "ocx-registry-repository-"),
    );
    const externalOutput = await mkdtemp(
      join(tmpdir(), "ocx-registry-output-"),
    );
    try {
      expect(
        await outputDirectory(
          ["--out", "dist"],
          temporaryRepository,
          temporaryRepository,
        ),
      ).toBe(join(await realpath(temporaryRepository), "dist"));
      expect(
        await outputDirectory(["--out", externalOutput], repositoryRoot),
      ).toBe(await realpath(externalOutput));
      await symlink(externalOutput, join(temporaryRepository, "linked"), "dir");
      await expect(
        outputDirectory(
          ["--out", "linked"],
          temporaryRepository,
          temporaryRepository,
        ),
      ).rejects.toThrow("symbolic link");
    } finally {
      await rm(temporaryRepository, { recursive: true, force: true });
      await rm(externalOutput, { recursive: true, force: true });
    }
  });

  test("restores an existing output when promotion fails", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ocx-registry-promotion-"));
    const output = join(parent, "output");
    try {
      await mkdir(output);
      await writeFile(join(output, "previous.txt"), "keep me");
      await expect(
        promoteStagedOutput(join(parent, "missing-stage"), output),
      ).rejects.toThrow("previous output was restored");
      await expect(
        readFile(join(output, "previous.txt"), "utf8"),
      ).resolves.toBe("keep me");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("pinned automation", () => {
  test("pins manifest dependencies without duplicating their versions", () => {
    expect(packageManifest.name).toBe("ocx-profile-workcell");
    expect(packageManifest.version).toMatch(bareSemVerPattern);

    const packageManager = parseExactPackagePin(packageManifest.packageManager);
    expect(packageManager.name).toBe("bun");
    expect(packageManager.version).toBe("1.4.1");
    expect(packageManifest.devDependencies["@types/bun"]).toBe(
      packageManager.version,
    );

    const dependencySections = [
      packageManifest.dependencies ?? {},
      packageManifest.devDependencies ?? {},
    ];
    for (const dependencies of dependencySections) {
      for (const [name, version] of Object.entries(dependencies)) {
        expect(name).toMatch(packageIdentityPattern);
        expect(version, name).toMatch(bareSemVerPattern);
      }
    }
    const manifestDependencies = Object.assign({}, ...dependencySections);
    for (const requiredPackage of [
      "ocx",
      "opencode-ai",
      "@opencode-ai/plugin",
      "@opencode-ai/sdk",
    ]) {
      expect(manifestDependencies, requiredPackage).toHaveProperty(
        requiredPackage,
      );
    }
    expect(packageManifest.devDependencies).toMatchObject({
      "@opencode-ai/plugin": "1.18.25",
      "@opencode-ai/sdk": "1.18.25",
      "@types/bun": "1.4.1",
      "opencode-ai": "1.18.25",
      ocx: "2.0.15",
    });
  });

  const receiptComponentNames = expectedComponents.filter(
    (name) => name !== "workcell",
  );

  async function createInstalledLayout(root: string): Promise<void> {
    await mkdir(join(root, ".ocx"), { recursive: true });
    for (const target of [
      "ocx.jsonc",
      "opencode.jsonc",
      "tui.jsonc",
      "AGENTS.md",
    ])
      await writeFile(join(root, target), "{}\n");
    const installed = Object.fromEntries(
      receiptComponentNames.map((name, index) => [
        `component-${index}`,
        { registryName: "matthewmorek", name },
      ]),
    );
    await writeFile(
      join(root, ".ocx", "receipt.jsonc"),
      JSON.stringify({ version: 1, installed }),
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: expectedDirectNpmDependencies,
        devDependencies: {},
        optionalDependencies: {},
        peerDependencies: {},
      }),
    );
    for (const [name, version] of Object.entries(
      expectedDirectNpmDependencies,
    )) {
      const packageDirectory = join(root, "node_modules", name);
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        join(packageDirectory, "package.json"),
        JSON.stringify({ name, version }),
      );
    }
  }

  async function withInstalledLayout(
    action: (root: string) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "workcell-installed-layout-"));
    try {
      await createInstalledLayout(root);
      await action(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("accepts the exact installed profile contract", async () => {
    expect(receiptComponentNames).toHaveLength(23);
    expect(Object.keys(expectedDirectNpmDependencies)).toHaveLength(6);
    await withInstalledLayout(async (root) => {
      await expect(assertInstalledLayout(root)).resolves.toBeUndefined();
    });
  });

  test.each([
    ["missing", async (root: string) => rm(join(root, "tui.jsonc"))],
    [
      "non-regular",
      async (root: string) => {
        await rm(join(root, "tui.jsonc"));
        await mkdir(join(root, "tui.jsonc"));
      },
    ],
  ])("rejects a %s profile target", async (_case, mutate) => {
    await withInstalledLayout(async (root) => {
      await mutate(root);
      await expect(assertInstalledLayout(root)).rejects.toThrow(
        "profile target tui.jsonc must be a regular file",
      );
    });
  });

  test.each([
    [
      "malformed receipt JSONC",
      async (root: string) =>
        writeFile(join(root, ".ocx", "receipt.jsonc"), "{ malformed"),
      "invalid JSON/JSONC",
    ],
    [
      "missing receipt identity",
      async (root: string) => {
        const path = join(root, ".ocx", "receipt.jsonc");
        const receipt = JSON.parse(await readFile(path, "utf8"));
        delete receipt.installed["component-22"];
        await writeFile(path, JSON.stringify(receipt));
      },
      "exactly 23 entries",
    ],
    [
      "duplicate receipt identity",
      async (root: string) => {
        const path = join(root, ".ocx", "receipt.jsonc");
        const receipt = JSON.parse(await readFile(path, "utf8"));
        receipt.installed["component-22"] = receipt.installed["component-0"];
        await writeFile(path, JSON.stringify(receipt));
      },
      "duplicates identity",
    ],
    [
      "unexpected receipt identity",
      async (root: string) => {
        const path = join(root, ".ocx", "receipt.jsonc");
        const receipt = JSON.parse(await readFile(path, "utf8"));
        receipt.installed["component-22"].name = "workcell-unreviewed";
        await writeFile(path, JSON.stringify(receipt));
      },
      "component set is incorrect",
    ],
    [
      "wrong receipt registry",
      async (root: string) => {
        const path = join(root, ".ocx", "receipt.jsonc");
        const receipt = JSON.parse(await readFile(path, "utf8"));
        receipt.installed["component-0"].registryName = "other";
        await writeFile(path, JSON.stringify(receipt));
      },
      "expected matthewmorek",
    ],
    [
      "malformed root manifest",
      async (root: string) => writeFile(join(root, "package.json"), "["),
      "invalid JSON/JSONC",
    ],
    [
      "missing direct dependency",
      async (root: string) => {
        const dependencies = { ...expectedDirectNpmDependencies } as Record<
          string,
          string
        >;
        delete dependencies.zod;
        await writeFile(
          join(root, "package.json"),
          JSON.stringify({ dependencies }),
        );
      },
      "missing: zod",
    ],
    [
      "unexpected direct dependency",
      async (root: string) =>
        writeFile(
          join(root, "package.json"),
          JSON.stringify({
            dependencies: {
              ...expectedDirectNpmDependencies,
              unexpected: "1.0.0",
            },
          }),
        ),
      "unexpected: unexpected",
    ],
    [
      "root direct dependency version mismatch",
      async (root: string) =>
        writeFile(
          join(root, "package.json"),
          JSON.stringify({
            dependencies: {
              ...expectedDirectNpmDependencies,
              zod: "4.3.4",
            },
          }),
        ),
      "expected 4.3.5",
    ],
    [
      "missing direct package manifest",
      async (root: string) =>
        rm(join(root, "node_modules", "zod", "package.json")),
      "direct package zod manifest must be a regular file",
    ],
    [
      "malformed direct package manifest",
      async (root: string) =>
        writeFile(join(root, "node_modules", "zod", "package.json"), "{"),
      "invalid JSON/JSONC",
    ],
    [
      "installed direct package version mismatch",
      async (root: string) =>
        writeFile(
          join(root, "node_modules", "zod", "package.json"),
          JSON.stringify({ name: "zod", version: "4.3.4" }),
        ),
      "expected 4.3.5",
    ],
  ])("rejects %s", async (_case, mutate, diagnostic) => {
    await withInstalledLayout(async (root) => {
      await mutate(root);
      await expect(assertInstalledLayout(root)).rejects.toThrow(diagnostic);
    });
  });

  test.each([
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const)("rejects non-empty %s", async (section) => {
    await withInstalledLayout(async (root) => {
      const manifestPath = join(root, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest[section] = { unexpected: "1.0.0" };
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(assertInstalledLayout(root)).rejects.toThrow(
        `${section} must be empty; received: unexpected`,
      );
    });
  });

  test.each([
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const)("rejects malformed %s", async (section) => {
    await withInstalledLayout(async (root) => {
      const manifestPath = join(root, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest[section] = [];
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(assertInstalledLayout(root)).rejects.toThrow(
        `${section} must be an object`,
      );
    });
  });

  test.each(["directory", "symlink", "file"])(
    "rejects a surviving Workcell %s",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "workcell-removal-"));
      const workcell = join(root, "workcell");
      const defaultProfile = join(root, "default");
      try {
        await mkdir(defaultProfile);
        if (kind === "directory") await mkdir(workcell);
        if (kind === "file") await writeFile(workcell, "survived");
        if (kind === "symlink") await symlink(defaultProfile, workcell);
        await expect(
          assertRemovedLayout(workcell, defaultProfile),
        ).rejects.toThrow("Workcell profile root still exists");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each(["missing", "file", "symlink"])(
    "rejects a %s default profile after Workcell removal",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "workcell-removal-"));
      const defaultProfile = join(root, "default");
      try {
        if (kind === "file") await writeFile(defaultProfile, "not a directory");
        if (kind === "symlink") {
          await mkdir(join(root, "target"));
          await symlink(join(root, "target"), defaultProfile);
        }
        await expect(
          assertRemovedLayout(join(root, "workcell"), defaultProfile),
        ).rejects.toThrow("default profile must remain a directory");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("accepts Workcell ENOENT while retaining the default directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "workcell-removal-"));
    try {
      await mkdir(join(root, "default"));
      await expect(
        assertRemovedLayout(join(root, "workcell"), join(root, "default")),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("isolates inherited launch overrides and writes the exact npm policy", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "workcell-smoke-policy-"));
    try {
      const environment = smokeEnvironment(
        {
          PATH: "/usr/bin:/bin",
          OPENCODE_CONFIG: "bad",
          OCX_PROFILE: "bad",
          npm_config_registry: "bad",
          NPM_TOKEN: "secret",
        },
        sandbox,
      );
      expect(environment.OPENCODE_CONFIG).toBeUndefined();
      expect(environment.OCX_PROFILE).toBeUndefined();
      expect(environment.npm_config_registry).toBeUndefined();
      expect(environment.NPM_TOKEN).toBeUndefined();
      expect(environment.HOME).toBe(join(sandbox, "home"));
      expect(environment.TMPDIR).toBe(join(sandbox, "tmp"));
      for (const name of [
        "NPM_CONFIG_REGISTRY",
        "npm_config_userconfig",
        "NODE_AUTH_TOKEN",
        "BUN_AUTH_TOKEN",
        "opencode_config",
        "ocx_profile",
      ])
        expect(isInheritedSmokeVariable(name), name).toBe(true);
      const policyPath = await writeSandboxNpmPolicy(sandbox);
      expect(policyPath).toBe(environment.NPM_CONFIG_USERCONFIG);
      expect(await readFile(policyPath, "utf8")).toBe(npmPolicyContent);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("redacts and bounds smoke diagnostics", () => {
    const context = createSmokeRedactionContext(
      "/tmp/private-smoke",
      { NPM_TOKEN: "npm-secret" },
      ["/tmp/private-smoke-sibling"],
    );
    const diagnostic = redactSmokeDiagnostics(
      `NPM_TOKEN=npm-secret /tmp/private-smoke/file /tmp/private-smoke-sibling/file ${join(repositoryRoot, "scripts", "smoke-install.ts")} ${join(repositoryRoot, "node_modules", ".bin", "ocx")} verify`,
      context,
    );
    expect(diagnostic).not.toContain("npm-secret");
    expect(diagnostic).not.toContain("/tmp/private-smoke");
    expect(diagnostic).not.toContain(repositoryRoot);
    expect(diagnostic).toContain("<redacted>");
    expect(diagnostic).toContain("<temporary-path>");
    expect(diagnostic).toContain("<repository-path>/scripts/smoke-install.ts");
    expect(diagnostic).toContain("<repository-binary-path>/ocx verify");
    expect(boundSmokeDiagnostics("x".repeat(70_000))).toContain(
      "characters omitted",
    );
  });

  test("times out when a descendant retains the completed leader's output pipes", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "workcell-command-timeout-"));
    const startedAt = Date.now();
    try {
      await expect(
        runSmokeCommand(
          "/bin/sh",
          ["-c", "sleep 10 &"],
          process.env,
          sandbox,
          createSmokeRedactionContext(sandbox),
          100,
        ),
      ).rejects.toThrow("timed out after 100ms");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("refuses a stale built registry", async () => {
    const registryDirectory = await mkdtemp(
      join(tmpdir(), "workcell-stale-registry-"),
    );
    try {
      await writeFile(
        join(registryDirectory, "index.json"),
        JSON.stringify({ version: "0.2.5" }),
      );
      await expect(
        assertBuiltRegistryVersion(registryDirectory, "0.2.6"),
      ).rejects.toThrow("Built registry is stale: source version is 0.2.6");
    } finally {
      await rm(registryDirectory, { recursive: true, force: true });
    }
  });

  test("awaits registry shutdown before deleting a smoke sandbox", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ocx-smoke-cleanup-"));
    let finishStop: (() => void) | undefined;
    let stopStarted = false;
    const stopFinished = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const cleanup = cleanupSmokeSandbox(sandbox, {
      stop: async () => {
        stopStarted = true;
        await stopFinished;
      },
    });
    await Bun.sleep(10);
    expect(stopStarted).toBe(true);
    await expect(lstat(sandbox)).resolves.toBeDefined();
    finishStop?.();
    await cleanup;
    await expect(lstat(sandbox)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("surfaces registry shutdown failure after deleting the sandbox", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ocx-smoke-cleanup-"));
    await expect(
      cleanupSmokeSandbox(sandbox, {
        stop: async () => {
          throw new Error("registry stop failed");
        },
      }),
    ).rejects.toThrow("registry stop failed");
    await expect(lstat(sandbox)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("runs all release gates with data-driven live comparison", () => {
    for (const workflow of [continuousIntegration, releaseWorkflow]) {
      expect(workflow).toContain("npm install --global bun@1.4.1");
      expect(workflow).toContain('test "$(bun --version)" = 1.4.1');
      expect(workflow).toContain("bun install --frozen-lockfile");
      expect(workflow).toContain(
        'test "$(./node_modules/.bin/opencode --version)" = 1.18.25',
      );
      expect(workflow).toContain("bun run typecheck");
      expect(workflow).toContain("bun run build");
      expect(workflow).toContain("REGISTRY_DIST=dist bun run test");
      expect(workflow).toContain("REGISTRY_DIST=dist bun run smoke");
    }
    expect(releaseWorkflow).toContain("find . -type f");
    expect(releaseWorkflow).toContain('cmp "dist/$file"');
    expect(releaseWorkflow).not.toContain("components/ws");
  });

  test("releases main tags regardless of tag type or creation path", () => {
    expect(releaseWorkflow).toContain("release:\n    types: [published]");
    expect(releaseWorkflow).toContain(
      'SOURCE_COMMIT="$(git rev-parse "$GITHUB_REF^{commit}")"',
    );
    expect(releaseWorkflow).toContain(
      'git merge-base --is-ancestor "$SOURCE_COMMIT" origin/main',
    );
    expect(releaseWorkflow).not.toContain("TAG_OBJECT_TYPE=");
    expect(releaseWorkflow).not.toContain("Annotated tag required");
  });

  test("treats an exact live release identity as an idempotent no-op", () => {
    const release = {
      version: "0.2.2",
      tag: "v0.2.2",
      commit: "a".repeat(40),
    };
    expect(decideReleaseAction(release, release)).toBe("noop");
    expect(releaseWorkflow).toContain(
      "if: steps.release-policy.outputs.should_deploy == 'true'",
    );
  });

  test("verifies and finalizes exact-live retries without redeploying Pages", () => {
    const step = (marker: string): string => {
      const start = releaseWorkflow.indexOf(marker);
      expect(start, marker).toBeGreaterThanOrEqual(0);
      const end = releaseWorkflow.indexOf("\n      - ", start + marker.length);
      return releaseWorkflow.slice(start, end === -1 ? undefined : end);
    };
    const upload = step("uses: actions/upload-pages-artifact@");
    const deploy = step("id: deploy-pages");
    const compare = step("name: Compare the live registry with dist");
    const finalize = step(
      "name: Create the GitHub Release when it does not already exist",
    );

    for (const deploymentStep of [upload, deploy])
      expect(deploymentStep).toContain(
        "if: steps.release-policy.outputs.should_deploy == 'true'",
      );
    for (const retryStep of [compare, finalize])
      expect(retryStep).not.toContain(
        "if: steps.release-policy.outputs.should_deploy == 'true'",
      );
    expect(compare).toContain("BASE_URL: ${{ steps.pages.outputs.base_url }}");
    expect(compare).not.toContain("steps.deploy-pages.outputs.page_url");
    expect(finalize).toContain('STATUS="$(curl');
    expect(finalize).toContain("https://api.github.com/repos/");
    expect(finalize).toContain("200)");
    expect(finalize).toContain(
      '404) gh release create "$GITHUB_REF_NAME" --verify-tag',
    );
    expect(finalize.match(/gh release create/g)).toHaveLength(1);
    expect(finalize).toContain(
      '*) echo "Unable to look up GitHub Release $GITHUB_REF_NAME (HTTP $STATUS)."',
    );
  });

  test("rejects equal-version releases with conflicting immutable identities", () => {
    const live = {
      version: "0.2.2",
      tag: "v0.2.2",
      commit: "a".repeat(40),
    };
    expect(() =>
      decideReleaseAction(live, { ...live, commit: "b".repeat(40) }),
    ).toThrow("Release identity conflict: live version=0.2.2");
  });

  test("deploys newer releases and rejects older releases", () => {
    const identity = { tag: "v0.2.2", commit: "a".repeat(40) };
    expect(
      decideReleaseAction(
        { version: "0.2.2", ...identity },
        { version: "0.2.3", tag: "v0.2.3", commit: "b".repeat(40) },
      ),
    ).toBe("deploy");
    expect(() =>
      decideReleaseAction(
        { version: "0.2.2", ...identity },
        { version: "0.2.1", tag: "v0.2.1", commit: "b".repeat(40) },
      ),
    ).toThrow("Target 0.2.1 is older than live 0.2.2");
  });

  test("rejects malformed requested metadata before deploying a newer version", () => {
    const live = {
      version: "0.2.2",
      tag: "v0.2.2",
      commit: "a".repeat(40),
    };
    expect(() =>
      decideReleaseAction(live, {
        version: "0.2.3",
        tag: "v9.9.9",
        commit: "b".repeat(40),
      }),
    ).toThrow("Invalid requested release metadata: tag must equal v0.2.3");
    expect(() =>
      decideReleaseAction(live, {
        version: "0.2.3",
        tag: "v0.2.3",
        commit: "not-a-commit",
      }),
    ).toThrow(
      "Invalid requested release metadata: commit must be a 40-character lowercase Git object ID",
    );
  });

  test("rejects malformed live release metadata", () => {
    expect(() =>
      decideReleaseAction(
        { version: "0.2.2", tag: "v0.2.2" },
        {
          version: "0.2.3",
          tag: "v0.2.3",
          commit: "b".repeat(40),
        },
      ),
    ).toThrow("Invalid live release metadata: commit must be");
  });

  test("rejects an inconsistent live tag before deploying a newer version", () => {
    expect(() =>
      decideReleaseAction(
        {
          version: "0.2.2",
          tag: "v9.9.9",
          commit: "a".repeat(40),
        },
        {
          version: "0.2.3",
          tag: "v0.2.3",
          commit: "b".repeat(40),
        },
      ),
    ).toThrow("Invalid live release metadata: tag must equal v0.2.2");
  });
});
