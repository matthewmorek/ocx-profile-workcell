import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  agentBodyByteLimit,
  assertBuiltRegistryVersion,
  assertInstalledTools,
  assertInstalledProfileContracts,
  boundSmokeDiagnostics,
  classifyTuiResolverFailure,
  cleanupTuiProcess,
  cleanupSmokeSandbox,
  createSmokeRedactionContext,
  effectivePermissionAction,
  establishToolAcceptanceAtLivenessBoundary,
  expectedDcpSpec,
  globalDcpConflictSpec,
  httpBodyByteLimit,
  isInheritedSmokeVariable,
  npmPolicyContent,
  parseDcpMetadataReceipt,
  parseToolIds,
  parseWorkcellPlanFingerprint,
  probeAgents,
  probeToolIds,
  probeToolIdsHandshake,
  type InstalledToolsLaunchAttempt,
  type ProbeFetch,
  profileLaunchArguments,
  profileLaunchCommand,
  requiredToolIds,
  readGlobalTuiConflictImmediatelyBeforeLaunch,
  redactSmokeDiagnostics,
  requireExactlyOneMergedConfigDirectory,
  seedGlobalTuiConflict,
  smokeEnvironment,
  validateGlobalTuiConflict,
  waitForFreshDcpMetadata,
  writeSandboxNpmPolicy,
} from "../scripts/smoke-install";

const verifiedAgentEvidence = {
  verified: true,
  failureReason: undefined,
} as const;

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

function declaredShippableInventory(
  components: any[],
  physicalFiles?: string[],
): { sourceFiles: string[]; targetOwners: Map<string, string> } {
  const sourceOwners = new Map<string, string>();
  const targetOwners = new Map<string, string>();

  for (const component of components) {
    if (!Array.isArray(component.files))
      throw new Error(`Component ${component.name} must declare a file array`);
    for (const declaration of component.files) {
      const source = parseInventoryPath(
        typeof declaration === "string" ? declaration : declaration?.path,
        `Component ${component.name} source`,
      );
      const target = parseInventoryPath(
        typeof declaration === "string" ? declaration : declaration?.target,
        `Component ${component.name} target`,
      );
      if (sourceOwners.has(source))
        throw new Error(
          `Source ${source} is declared by both ${sourceOwners.get(source)} and ${component.name}`,
        );
      if (targetOwners.has(target))
        throw new Error(
          `Target ${target} is owned by both ${targetOwners.get(target)} and ${component.name}`,
        );
      sourceOwners.set(source, component.name);
      targetOwners.set(target, component.name);
    }
  }

  const sourceFiles = [...sourceOwners.keys()].sort();
  if (
    physicalFiles &&
    JSON.stringify(sourceFiles) !== JSON.stringify([...physicalFiles].sort())
  )
    throw new Error("Physical files and registry declarations do not match");
  return { sourceFiles, targetOwners };
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

  test("rejects duplicate and incomplete shippable inventories", () => {
    expect(() =>
      declaredShippableInventory([
        {
          name: "first",
          files: [{ path: "one.ts", target: "shared.ts" }],
        },
        {
          name: "second",
          files: [{ path: "two.ts", target: "shared.ts" }],
        },
      ]),
    ).toThrow("Target shared.ts is owned by both first and second");
    expect(() =>
      declaredShippableInventory(
        [
          {
            name: "first",
            files: [{ path: "one.ts", target: "one.ts" }],
          },
        ],
        ["one.ts", "undeclared.ts"],
      ),
    ).toThrow("Physical files and registry declarations do not match");
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
    expect(registry.version).toBe("0.2.8");
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
      model: "openai/gpt-5.6-sol",
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
        model: "openai/gpt-5.6-sol",
        temperature: 0.3,
        options: { reasoningEffort: "high", textVerbosity: "medium" },
        promptHash:
          "7118513f19cbf2f399f6c19427a1f26805cf3242ea7a669971793fd69e1eba6b",
        permissionHash:
          "0d454b72b405822958d92cc6a0d9a089c71ebfd9ab96695716a3155892c80607",
      },
      build: {
        mode: "primary",
        model: "openai/gpt-5.6-sol",
        temperature: 0.3,
        options: { reasoningEffort: "high", textVerbosity: "low" },
        promptHash:
          "9df5756dc38e91b4d544cfe07c6f36259fe5af4d427d632657298e246fcff98d",
        permissionHash:
          "9f3fc4cee3d4818f87a8d9f33a78ec9a2007cf5ddabdc193166d5265eddd46cc",
      },
      coder: {
        mode: "subagent",
        model: "openai/gpt-5.6-sol",
        temperature: 0.1,
        options: { reasoningEffort: "medium", textVerbosity: "low" },
        promptHash: null,
        permissionHash:
          "abc3ce922ce5e97b55b3476416fc22ee071fb67e02551fcbd70d2088488e1a9f",
      },
      debugger: {
        mode: "subagent",
        model: "openai/gpt-5.6-sol",
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
          "5f2ca9314851177457b44938ce5af0c2acd1b35c124d9a5cac15a4a6d03f379b",
      },
      reviewer: {
        mode: "subagent",
        model: "openai/gpt-5.6-sol",
        temperature: 0.1,
        options: { reasoningEffort: "high", textVerbosity: "medium" },
        promptHash: null,
        permissionHash:
          "b507ffe358db8b9a1520991e78649c39471796eb0fdd33b8f05c1df03dd43d03",
      },
      committer: {
        mode: "subagent",
        model: "openai/gpt-5.6-sol",
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
      plan: profileConfig.agent.plan.permission.skill,
      build: profileConfig.agent.build.permission.skill,
      reviewer: profileConfig.agent.reviewer.permission.skill,
    }).toEqual({ plan: "allow", build: "allow", reviewer: "allow" });
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
      plugin: [expectedDcpSpec],
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
  });

  test("declares every physical shippable file exactly once with one owner per target", async () => {
    const physicalFiles = await outputFiles(join(repositoryRoot, "files"));
    const inventory = declaredShippableInventory(
      registry.components,
      physicalFiles,
    );
    expect(inventory.sourceFiles).toEqual(physicalFiles);
    expect(inventory.targetOwners.size).toBe(inventory.sourceFiles.length);
  });

  test("contains no forbidden runtime dependency, integration, artifact, secret, symlink, or machine path", async () => {
    const sourceFiles = await outputFiles(join(repositoryRoot, "files"));
    for (const sourcePath of sourceFiles) {
      const path = `files/${sourcePath}`;
      expect(path).not.toMatch(
        /(?:\.DS_Store|node_modules|\.ocx\/|receipt|cache|lock)/i,
      );
      const content = await readFile(join(repositoryRoot, path), "utf8");
      expect(content.toLowerCase()).not.toContain(`${"lin"}${"ear"}`);
      expect(content).not.toMatch(
        /(?:kdco\/workspace|registry\.kdco\.dev|@latest|@mohak34|\/Users\/|ghp_|github_pat_|phc_|(?:^|[^a-z])sk-)/i,
      );
    }
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

  test("adds the plan-review reminder only for structured plan_save success", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "workcell-plan-save-"));
    const previousHome = process.env.HOME;
    process.env.HOME = sandbox;

    try {
      const hooks = (await WorkspacePlugin({
        directory: sandbox,
        client: {
          session: {
            get: async ({ path }: { path: { id: string } }) => ({
              data: { id: path.id },
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
      expect(successOutput.output).toContain(
        "Plan saved successfully. You MUST now delegate to the reviewer",
      );

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
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
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

  test("pins launch identities and isolates inherited launch overrides", () => {
    expect(profileLaunchCommand).toBe("ocx");
    expect(profileLaunchArguments(4096)).toEqual([
      "oc",
      "-p",
      "workcell",
      "--",
      "--print-logs",
      "--log-level",
      "DEBUG",
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4096",
    ]);
    expect(requiredToolIds).toEqual([
      "plan_save",
      "plan_read",
      "delegate",
      "delegation_read",
      "delegation_list",
      "worktree_create",
      "worktree_delete",
    ]);
    const environment = smokeEnvironment(
      {
        PATH: "/usr/bin:/bin",
        OPENCODE_CONFIG: "bad",
        OCX_PROFILE: "bad",
        npm_config_registry: "bad",
        NpM_ToKeN: "secret",
        Bun_Auth_Token: "secret",
      },
      "/tmp/ocx-smoke",
    );
    expect(environment.HOME).toBe("/tmp/ocx-smoke/home");
    expect(environment.OPENCODE_CONFIG).toBeUndefined();
    expect(environment.OCX_PROFILE).toBeUndefined();
    expect(environment.npm_config_registry).toBeUndefined();
    expect(environment.NpM_ToKeN).toBeUndefined();
    expect(environment.Bun_Auth_Token).toBeUndefined();
    expect(environment.NPM_CONFIG_USERCONFIG).toBe(
      "/tmp/ocx-smoke/home/.npmrc",
    );
    for (const inheritedName of [
      "NPM_CONFIG_REGISTRY",
      "npm_config_userconfig",
      "NPM_TOKEN",
      "npm_auth_token",
      "node_auth_token",
      "BUN_AUTH_TOKEN",
      "bun_token",
      "bun_config_token",
      "bunfig_token",
      "opencode_config",
      "ocx_profile",
    ])
      expect(isInheritedSmokeVariable(inheritedName), inheritedName).toBe(true);
    expect(isInheritedSmokeVariable("PATH")).toBe(false);
  });

  test("creates an exact sandbox npm policy and lower-precedence global DCP conflict", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "workcell-smoke-policy-"));
    try {
      const policyPath = await writeSandboxNpmPolicy(sandbox);
      const globalTuiPath = await seedGlobalTuiConflict(sandbox);
      expect(await readFile(policyPath, "utf8")).toBe(npmPolicyContent);
      expect((await readFile(policyPath, "utf8")).split("\n")).toEqual([
        "min-release-age=7",
        "engine-strict=false",
        "",
      ]);
      expect(JSON.parse(await readFile(globalTuiPath, "utf8"))).toEqual({
        plugin: [globalDcpConflictSpec],
      });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("parses the installed profile and deduplicated runtime API manifest", async () => {
    const sandbox = await mkdtemp(
      join(tmpdir(), "workcell-installed-profile-"),
    );
    try {
      await writeFile(
        join(sandbox, "tui.jsonc"),
        `{ "plugin": ["${expectedDcpSpec}"] }`,
      );
      await writeFile(
        join(sandbox, "package.json"),
        JSON.stringify({ dependencies: { "@opencode-ai/plugin": "1.18.25" } }),
      );
      await expect(
        assertInstalledProfileContracts(sandbox),
      ).resolves.toBeUndefined();
      await writeFile(
        join(sandbox, "package.json"),
        JSON.stringify({
          dependencies: {
            "@opencode-ai/plugin": "1.18.25",
            "@opencode-ai/sdk": "1.18.25",
          },
        }),
      );
      await expect(assertInstalledProfileContracts(sandbox)).rejects.toThrow(
        "must not declare @opencode-ai/sdk",
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("evaluates last-matching permission rules and selects the Workcell plan fingerprint", () => {
    const permission = [
      { permission: "delegate", pattern: "*", action: "deny" },
      { permission: "delegate", pattern: "*", action: "allow" },
      { permission: "delegation_read", pattern: "*", action: "allow" },
      { permission: "delegation_list", pattern: "*", action: "allow" },
      { permission: "plan_save", pattern: "*", action: "allow" },
      { permission: "plan_read", pattern: "*", action: "allow" },
      { permission: "task", pattern: "*", action: "deny" },
    ] as const;
    expect(effectivePermissionAction(permission, "delegate")).toBe("allow");
    expect(
      effectivePermissionAction(
        [
          { permission: "delegation_*", pattern: "*", action: "allow" },
          { permission: "delegation_read", pattern: "*", action: "deny" },
        ],
        "delegation_read",
      ),
    ).toBe("deny");
    expect(
      effectivePermissionAction(
        [
          { permission: "delegate", pattern: "child-*", action: "allow" },
          { permission: "*", pattern: "child-secret", action: "deny" },
        ],
        "delegate",
        "child-secret",
      ),
    ).toBe("deny");
    expect(
      effectivePermissionAction(
        [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "deleg*", pattern: "child-*", action: "deny" },
        ],
        "delegate",
        "child-coder",
      ),
    ).toBe("deny");
    const body = JSON.stringify([
      {
        name: "plan",
        mode: "primary",
        model: { providerID: "openai", modelID: "gpt-5.6-sol" },
        description:
          "Designs implementation-ready plans using delegated repository and external research.",
        permission,
      },
    ]);
    expect(parseWorkcellPlanFingerprint(body)).toMatchObject({
      name: "plan",
      permissions: { delegate: "allow", task: "deny" },
    });

    const shadowed = JSON.parse(body);
    shadowed[0].permission.push({
      permission: "delegate",
      pattern: "*",
      action: "deny",
    });
    expect(() =>
      parseWorkcellPlanFingerprint(JSON.stringify(shadowed)),
    ).toThrow("delegate resolved to deny; expected allow");

    for (const [field, value, expectedCause] of [
      ["mode", "subagent", "Workcell plan mode mismatch"],
      [
        "model",
        { providerID: "anthropic", modelID: "claude" },
        "Workcell plan provider/model mismatch",
      ],
      [
        "description",
        "Generic plan agent",
        "Workcell plan description mismatch",
      ],
    ] as const) {
      const mismatched = JSON.parse(body);
      mismatched[0][field] = value;
      expect(() =>
        parseWorkcellPlanFingerprint(JSON.stringify(mismatched)),
      ).toThrow(expectedCause);
    }
  });

  test("bounds and authenticates the separate agent probe", async () => {
    let observedAuthorization: string | null = null;
    const probe = await probeAgents(
      4005,
      "Basic redacted",
      async (_input, init) => {
        observedAuthorization = new Headers(init?.headers).get("Authorization");
        return Response.json([]);
      },
    );
    expect(String(observedAuthorization)).toBe("Basic redacted");
    expect(probe).toMatchObject({
      status: 200,
      body: "[]",
      bodyTruncated: false,
      requestError: undefined,
    });

    let streamCancelled = false;
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(agentBodyByteLimit + 1));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const oversizedProbe = await probeAgents(
      4005,
      "Basic redacted",
      async () => new Response(oversizedBody, { status: 200 }),
    );
    expect(oversizedProbe.bodyTruncated).toBe(true);
    expect(streamCancelled).toBe(true);
  });

  test("validates one exact DCP metadata receipt and rejects source mismatch", () => {
    const metadataRecord = {
      id: "opencode-dcp",
      spec: expectedDcpSpec,
      requested: "3.1.15",
      version: "3.1.15",
      source: "npm",
      target:
        "/private/var/folders/x/installation/node_modules/@tarquinen/opencode-dcp",
      first_time: 100,
    };
    const receipt = parseDcpMetadataReceipt(
      JSON.stringify({ "opencode-dcp": metadataRecord }),
      100,
    );
    expect(receipt.spec).toBe(expectedDcpSpec);
    expect(receipt.requested).toBe("3.1.15");
    expect(receipt.version).toBe("3.1.15");
    expect(receipt.source).toBe("npm");
    expect(receipt.firstTime).toBe(100);
    expect(() =>
      parseDcpMetadataReceipt(
        `${JSON.stringify(metadataRecord)}\n${JSON.stringify(metadataRecord)}`,
      ),
    ).toThrow("exactly one DCP record");
    expect(() =>
      parseDcpMetadataReceipt(JSON.stringify(metadataRecord), 101),
    ).toThrow("record is stale");
    for (const [changes, expectedCause] of [
      [{ requested: "latest" }, "requested version must equal 3.1.15"],
      [{ version: "3.1.16" }, "resolved version must equal 3.1.15"],
      [{ source: "config" }, "source must equal npm"],
      [
        {
          target:
            "/cache/node_modules/@tarquinen/opencode-dcp-lookalike/node_modules-marker/@tarquinen/opencode-dcp-lookalike",
        },
        "canonical path ending in node_modules/@tarquinen/opencode-dcp",
      ],
      [{ requested: 3.1 }, "requested version must equal 3.1.15"],
      [{ version: null }, "resolved version must equal 3.1.15"],
      [{ target: 42 }, "target must be a string"],
      [{ first_time: "100" }, "first_time must be a finite number"],
    ] as const) {
      expect(() =>
        parseDcpMetadataReceipt(
          JSON.stringify({ ...metadataRecord, ...changes }),
        ),
      ).toThrow(expectedCause);
    }
    expect(classifyTuiResolverFailure(true, undefined, false)).toBe("timeout");
    expect(classifyTuiResolverFailure(false, 1, false)).toBe("early-exit");
    expect(classifyTuiResolverFailure(false, undefined, false)).toBe(
      "missing-metadata",
    );
    expect(classifyTuiResolverFailure(false, undefined, true)).toBeUndefined();
  });

  test("polls until fresh complete metadata while the direct child remains live", async () => {
    const metadataRecord = JSON.stringify({
      id: "opencode-dcp",
      spec: expectedDcpSpec,
      requested: "3.1.15",
      version: "3.1.15",
      source: "npm",
      target: "/cache/node_modules/@tarquinen/opencode-dcp",
      first_time: 100,
    });
    const poll = async (
      reads: Array<string | undefined>,
      exitCode: () => number | undefined = () => undefined,
      timeout = 1_000,
    ) => {
      let now = 100;
      return waitForFreshDcpMetadata(100, timeout, {
        readMetadata: async () => reads.shift(),
        childExitCode: exitCode,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      });
    };

    await expect(poll([undefined, "", metadataRecord])).resolves.toMatchObject({
      spec: expectedDcpSpec,
    });
    await expect(
      poll(['{"id":"opencode-', metadataRecord]),
    ).resolves.toMatchObject({ spec: expectedDcpSpec });

    let malformedExitChecks = 0;
    await expect(
      poll(["{malformed}\n"], () => (malformedExitChecks++ === 0 ? 9 : 9)),
    ).rejects.toThrow("malformed JSON");
    await expect(poll([metadataRecord], () => 7)).rejects.toThrow(
      "exited with code 7 before metadata acceptance",
    );
    await expect(poll([], () => undefined, 200)).rejects.toThrow(
      "timed out before metadata acceptance",
    );
  });

  test("validates the global fixture and isolated merged-directory cardinality", async () => {
    expect(() => validateGlobalTuiConflict('{"plugin":[]}')).toThrow(
      "must contain only",
    );
    expect(() => validateGlobalTuiConflict("{changed")).toThrow(
      "invalid JSON/JSONC",
    );
    expect(
      requireExactlyOneMergedConfigDirectory([], "before-launch"),
    ).toBeUndefined();
    expect(() =>
      requireExactlyOneMergedConfigDirectory([], "acceptance"),
    ).toThrow("received 0");
    expect(() =>
      requireExactlyOneMergedConfigDirectory(["one", "two"], "acceptance"),
    ).toThrow("received 2");
    expect(requireExactlyOneMergedConfigDirectory(["one"], "acceptance")).toBe(
      "one",
    );

    const sandbox = await mkdtemp(join(tmpdir(), "workcell-tui-fixture-"));
    try {
      await expect(
        readGlobalTuiConflictImmediatelyBeforeLaunch(
          join(sandbox, "missing.json"),
        ),
      ).rejects.toThrow("missing immediately before launch");
      const changedFixture = join(sandbox, "tui.json");
      await writeFile(changedFixture, '{"plugin":[]}');
      await expect(
        readGlobalTuiConflictImmediatelyBeforeLaunch(changedFixture),
      ).rejects.toThrow("must contain only");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("redacts credentials, tokens, repository paths, and temporary paths from diagnostics", () => {
    const credentials = {
      username: "generated-user",
      password: "generated-password",
    };
    const encoded = Buffer.from(
      `${credentials.username}:${credentials.password}`,
    ).toString("base64");
    const context = createSmokeRedactionContext(
      "/tmp/private-smoke",
      credentials,
      {
        NPM_TOKEN: "npm-secret",
        npm_config_foo_authToken: "scoped-secret",
        OPENCODE_AUTH_TOKEN: "config-secret",
      },
      ["/tmp/private-smoke-sibling"],
    );
    const concreteRepositoryFile = join(
      repositoryRoot,
      "scripts",
      "smoke-install.ts",
    );
    const concreteCommandPath = join(
      repositoryRoot,
      "node_modules",
      ".bin",
      "ocx",
    );
    const diagnostic = redactSmokeDiagnostics(
      `generated-user generated-password generated-user:generated-password Basic ${encoded} NPM_TOKEN=npm-secret //registry.example/:_authToken=scoped-secret OPENCODE_AUTH_TOKEN=config-secret /tmp/private-smoke/file /tmp/private-smoke-sibling/file ${concreteRepositoryFile} ${concreteCommandPath} verify`,
      context,
    );
    for (const secret of [
      credentials.username,
      credentials.password,
      encoded,
      "npm-secret",
      "scoped-secret",
      "config-secret",
    ])
      expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain("/tmp/private-smoke");
    expect(diagnostic).not.toContain(repositoryRoot);
    expect(diagnostic).not.toContain(concreteCommandPath);
    expect(diagnostic).toContain("<redacted>");
    expect(diagnostic).toContain("<temporary-path>");
    expect(diagnostic).toContain("<repository-path>/scripts/smoke-install.ts");
    expect(diagnostic).toContain("<repository-binary-path>/ocx verify");
    const bounded = boundSmokeDiagnostics("x".repeat(70_000));
    expect(bounded.length).toBeLessThan(70_000);
    expect(bounded).toContain("characters omitted");
  });

  test("cleans detached TUI process groups with bounded fallback and unconditional terminal close", async () => {
    const signals: string[] = [];
    let terminalClosed = false;
    let alive = true;
    await expect(
      cleanupTuiProcess(
        {
          writeInterrupt: () => {
            throw new Error("write failed");
          },
          closeTerminal: () => {
            terminalClosed = true;
          },
          isGroupAlive: () => alive,
          signalGroup: (signal) => {
            signals.push(signal);
            if (signal === "SIGKILL") alive = false;
          },
          exited: Promise.resolve(0),
          sleep: async () => {},
        },
        1,
      ),
    ).rejects.toThrow("Ctrl-C write failed");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(terminalClosed).toBe(true);

    await expect(
      cleanupTuiProcess(
        {
          writeInterrupt: () => {},
          closeTerminal: () => {
            throw new Error("close failed");
          },
          isGroupAlive: () => false,
          signalGroup: () => {},
          exited: Promise.resolve(0),
          sleep: async () => {},
        },
        1,
      ),
    ).rejects.toThrow("terminal close failed");
  });

  test("refuses a stale built registry before launching Workcell", async () => {
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

  test("requires OpenCode's WWW-Authenticate challenge before sending credentials", async () => {
    let requestCount = 0;
    const fetcher: ProbeFetch = async () => {
      requestCount += 1;
      return new Response("Unauthorized", { status: 401 });
    };

    const handshake = await probeToolIdsHandshake(
      4001,
      { username: "expected-user", password: "expected-password" },
      fetcher,
    );

    expect(handshake.ownershipVerified).toBe(false);
    expect(handshake.probe.wwwAuthenticate).toBeNull();
    expect(requestCount).toBe(1);
  });

  test("rejects the wrong authentication scheme or Basic realm", async () => {
    for (const challenge of [
      'Bearer realm="Secure Area"',
      'Basic realm="Other Area"',
    ]) {
      let requestCount = 0;
      const fetcher: ProbeFetch = async () => {
        requestCount += 1;
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": challenge },
        });
      };

      const handshake = await probeToolIdsHandshake(
        4002,
        { username: "expected-user", password: "expected-password" },
        fetcher,
      );

      expect(handshake.ownershipVerified, challenge).toBe(false);
      expect(requestCount, challenge).toBe(1);
    }
  });

  test("accepts legal Basic challenge casing and whitespace only with the configured credentials", async () => {
    const correctCredentials = {
      username: "expected-user",
      password: "expected-password",
    };
    const expectedAuthorization = `Basic ${Buffer.from(
      `${correctCredentials.username}:${correctCredentials.password}`,
    ).toString("base64")}`;

    for (const challenge of [
      'Basic realm="Secure Area"',
      'bAsIc\tReAlM = "Secure Area"  ',
    ]) {
      const observedAuthorizations: Array<string | null> = [];
      const fetcher: ProbeFetch = async (_input, init) => {
        const authorization = new Headers(init?.headers).get("Authorization");
        observedAuthorizations.push(authorization);
        if (!authorization) {
          return new Response("Unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": challenge },
          });
        }
        if (authorization !== expectedAuthorization) {
          return new Response("Forbidden", { status: 403 });
        }
        return Response.json(requiredToolIds);
      };

      const validHandshake = await probeToolIdsHandshake(
        4003,
        correctCredentials,
        fetcher,
      );
      expect(validHandshake.ownershipVerified, challenge).toBe(true);
      expect(parseToolIds(validHandshake.probe), challenge).toEqual([
        ...requiredToolIds,
      ]);
      expect(observedAuthorizations, challenge).toEqual([
        null,
        expectedAuthorization,
      ]);

      const invalidHandshake = await probeToolIdsHandshake(
        4003,
        { ...correctCredentials, password: "wrong-password" },
        fetcher,
      );
      expect(invalidHandshake.ownershipVerified, challenge).toBe(false);
      expect(invalidHandshake.probe.status, challenge).toBe(403);
    }
  });

  test("cancels oversized chunked tool responses before parsing the retained prefix", async () => {
    const validJsonPrefix = JSON.stringify(requiredToolIds);
    let streamCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(validJsonPrefix));
        controller.enqueue(new Uint8Array(httpBodyByteLimit));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const fetcher: ProbeFetch = async () => new Response(body, { status: 200 });

    const probe = await probeToolIds(4004, "Basic redacted", fetcher);

    expect(probe.body).toBe(validJsonPrefix);
    expect(probe.bodyTruncated).toBe(true);
    expect(streamCancelled).toBe(true);
    expect(parseToolIds(probe)).toEqual([]);
  });

  test("retries an exited EADDRINUSE launch instead of accepting an unrelated responder", async () => {
    const ports = [4101, 4102, 4103];
    const attemptedPorts: number[] = [];
    const successfulProbe = {
      status: 200,
      body: JSON.stringify(requiredToolIds),
      bodyTruncated: false,
      wwwAuthenticate: null,
      requestError: undefined,
    };
    const successfulAttempt: InstalledToolsLaunchAttempt = {
      probe: successfulProbe,
      ...establishToolAcceptanceAtLivenessBoundary(
        successfulProbe,
        true,
        () => undefined,
        verifiedAgentEvidence,
      ),
      agentProbe: successfulProbe,
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    const collisionAttempt: InstalledToolsLaunchAttempt = {
      ...successfulAttempt,
      ...establishToolAcceptanceAtLivenessBoundary(
        successfulProbe,
        true,
        () => 1,
        verifiedAgentEvidence,
      ),
      exitCode: 1,
      stderr: "listen EADDRINUSE: address already in use 127.0.0.1:4101",
    };
    const attempts = [collisionAttempt, successfulAttempt];

    await assertInstalledTools(1, {}, "/unused", {
      reservePort: () => ports.shift()!,
      launchProbeAndCleanup: async (port) => {
        attemptedPorts.push(port);
        return attempts.shift()!;
      },
    });

    expect(attemptedPorts).toEqual([4101, 4102]);
    expect(attempts).toHaveLength(0);

    let boundedAttemptCount = 0;
    await expect(
      assertInstalledTools(1, {}, "/unused", {
        reservePort: () => 4200 + boundedAttemptCount,
        launchProbeAndCleanup: async (port) => {
          boundedAttemptCount += 1;
          return {
            ...collisionAttempt,
            stderr: `listen EADDRINUSE: address already in use 127.0.0.1:${port}`,
          };
        },
      }),
    ).rejects.toThrow("Launch attempt: 3 of 3");
    expect(boundedAttemptCount).toBe(3);
  });

  test("establishes tool acceptance atomically before intentional cleanup", async () => {
    const probe = {
      status: 200,
      body: JSON.stringify(requiredToolIds),
      bodyTruncated: false,
      wwwAuthenticate: null,
      requestError: undefined,
    };
    const exitedBeforeAcceptance = establishToolAcceptanceAtLivenessBoundary(
      probe,
      true,
      () => 17,
      verifiedAgentEvidence,
    );
    const liveAtAcceptance = establishToolAcceptanceAtLivenessBoundary(
      probe,
      true,
      () => undefined,
      verifiedAgentEvidence,
    );
    const missingAgentEvidence = establishToolAcceptanceAtLivenessBoundary(
      probe,
      true,
      () => undefined,
      {
        verified: false,
        failureReason: "bounded Workcell fingerprint mismatch",
      },
    );

    expect(exitedBeforeAcceptance.acceptedWhileChildLive).toBe(false);
    expect(exitedBeforeAcceptance.childExitCodeAtAcceptance).toBe(17);
    expect(exitedBeforeAcceptance.toolIds).toEqual([...requiredToolIds]);
    expect(exitedBeforeAcceptance.missingToolIds).toEqual([]);
    expect(Object.isFrozen(exitedBeforeAcceptance)).toBe(true);
    expect(Object.isFrozen(exitedBeforeAcceptance.toolIds)).toBe(true);
    await expect(
      assertInstalledTools(1, {}, "/unused", {
        reservePort: () => 4251,
        launchProbeAndCleanup: async () => ({
          probe,
          agentProbe: probe,
          ...exitedBeforeAcceptance,
          exitCode: 17,
          stdout: "",
          stderr: "",
        }),
      }),
    ).rejects.toThrow("Child exit code at acceptance: 17");

    expect(liveAtAcceptance.acceptedWhileChildLive).toBe(true);
    expect(missingAgentEvidence.acceptedWhileChildLive).toBe(false);
    expect(missingAgentEvidence.planFingerprintFailureReason).toBe(
      "bounded Workcell fingerprint mismatch",
    );
    await expect(
      assertInstalledTools(3, {}, "/unused", {
        reservePort: () => 4253,
        launchProbeAndCleanup: async () => ({
          probe,
          agentProbe: { ...probe, body: "FULL_AGENT_BODY_MUST_NOT_LEAK" },
          ...missingAgentEvidence,
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      }),
    ).rejects.toThrow("bounded Workcell fingerprint mismatch");
    await expect(
      assertInstalledTools(3, {}, "/unused", {
        reservePort: () => 4254,
        launchProbeAndCleanup: async () => ({
          probe,
          agentProbe: { ...probe, body: "FULL_AGENT_BODY_MUST_NOT_LEAK" },
          ...missingAgentEvidence,
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      }),
    ).rejects.not.toThrow("FULL_AGENT_BODY_MUST_NOT_LEAK");
    await assertInstalledTools(2, {}, "/unused", {
      reservePort: () => 4252,
      launchProbeAndCleanup: async () => ({
        probe,
        agentProbe: probe,
        ...liveAtAcceptance,
        exitCode: 143,
        stdout: "",
        stderr: "",
      }),
    });
  });

  test("rejects valid tool IDs when endpoint ownership was not proven", async () => {
    let attemptCount = 0;
    const probe = {
      status: 200,
      body: JSON.stringify(requiredToolIds),
      bodyTruncated: false,
      wwwAuthenticate: null,
      requestError: undefined,
    };
    const unownedAttempt: InstalledToolsLaunchAttempt = {
      probe,
      ...establishToolAcceptanceAtLivenessBoundary(
        probe,
        false,
        () => undefined,
        verifiedAgentEvidence,
      ),
      agentProbe: probe,
      exitCode: 0,
      stdout: "",
      stderr: "",
    };

    await expect(
      assertInstalledTools(1, {}, "/unused", {
        reservePort: () => 4301,
        launchProbeAndCleanup: async () => {
          attemptCount += 1;
          return unownedAttempt;
        },
      }),
    ).rejects.toThrow("Endpoint ownership verified: false");
    expect(attemptCount).toBe(1);
  });

  test("rejects an owned endpoint missing a required tool ID", async () => {
    const missingToolId = "worktree_delete";
    const probe = {
      status: 200,
      body: JSON.stringify(
        requiredToolIds.filter((toolId) => toolId !== missingToolId),
      ),
      bodyTruncated: false,
      wwwAuthenticate: null,
      requestError: undefined,
    };
    const incompleteAttempt: InstalledToolsLaunchAttempt = {
      probe,
      ...establishToolAcceptanceAtLivenessBoundary(
        probe,
        true,
        () => undefined,
        verifiedAgentEvidence,
      ),
      agentProbe: probe,
      exitCode: 0,
      stdout: "",
      stderr: "",
    };

    await expect(
      assertInstalledTools(1, {}, "/unused", {
        reservePort: () => 4351,
        launchProbeAndCleanup: async () => incompleteAttempt,
      }),
    ).rejects.toThrow(`Missing required tool IDs: ${missingToolId}`);
  });

  test("does not retry EADDRINUSE for a different listener port", async () => {
    let attemptCount = 0;
    const probe = {
      status: undefined,
      body: "",
      bodyTruncated: false,
      wwwAuthenticate: null,
      requestError: "Server did not accept a connection.",
    };
    const unrelatedCollision: InstalledToolsLaunchAttempt = {
      probe,
      ...establishToolAcceptanceAtLivenessBoundary(
        probe,
        false,
        () => 1,
        verifiedAgentEvidence,
      ),
      agentProbe: probe,
      exitCode: 1,
      stdout: "",
      stderr: "listen EADDRINUSE: address already in use 127.0.0.1:4402",
    };

    await expect(
      assertInstalledTools(1, {}, "/unused", {
        reservePort: () => 4401,
        launchProbeAndCleanup: async () => {
          attemptCount += 1;
          return unrelatedCollision;
        },
      }),
    ).rejects.toThrow(unrelatedCollision.stderr);
    expect(attemptCount).toBe(1);
  });

  test("cleans a smoke sandbox and runs all release gates with data-driven live comparison", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ocx-smoke-cleanup-"));
    let stopped = false;
    await cleanupSmokeSandbox(sandbox, {
      stop: async () => {
        stopped = true;
      },
    });
    expect(stopped).toBe(true);
    expect(await Bun.file(sandbox).exists()).toBe(false);
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

  test("rejects non-annotated release tags with an actionable error before release work", () => {
    const objectTypeCheck = 'if [ "$TAG_OBJECT_TYPE" != "tag" ]; then';
    const diagnostic =
      "::error title=Annotated tag required::Release tags must be annotated tag objects. Create one with: git tag -a vX.Y.Z -m vX.Y.Z";
    expect(releaseWorkflow).toContain(
      'TAG_OBJECT_TYPE="$(git cat-file -t "$GITHUB_REF")"',
    );
    expect(releaseWorkflow).toContain(objectTypeCheck);
    expect(releaseWorkflow).toContain(diagnostic);
    expect(releaseWorkflow.indexOf(objectTypeCheck)).toBeLessThan(
      releaseWorkflow.indexOf('SOURCE_COMMIT="$(git rev-parse'),
    );
    expect(releaseWorkflow.indexOf(diagnostic)).toBeLessThan(
      releaseWorkflow.indexOf("bun install --frozen-lockfile"),
    );
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
