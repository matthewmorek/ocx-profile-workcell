import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "jsonc-parser";
import BackgroundAgentsPlugin from "../files/plugins/background-agents";
import WorkspacePlugin from "../files/plugins/workspace-plugin";
import WorktreePlugin from "../files/plugins/worktree";
import { getProjectId } from "../files/plugins/kdco-primitives/get-project-id";
import { buildSessionLaunchArgv, parseActiveLaunchContext, parsePersistedLaunchMetadata } from "../files/plugins/worktree/launch-context";
import { addSession, getPendingDelete, getSession, initStateDb, setPendingDelete } from "../files/plugins/worktree/state";
import { buildCmuxSessionStatusTransitionForEvent } from "../files/plugins/notify/status";
import { sanitizeOscTitleText } from "../files/plugins/notify/title";
import { expectedComponents, outputDirectory, promoteStagedOutput } from "../scripts/build-registry";
import { cleanupSmokeSandbox, profileLaunchArguments, profileLaunchCommand, smokeEnvironment } from "../scripts/smoke-install";

const repositoryRoot = join(import.meta.dir, "..");
const registry = parse(await readFile(join(repositoryRoot, "registry.jsonc"), "utf8")) as any;
const profileConfig = parse(await readFile(join(repositoryRoot, "files/profiles/workcell/opencode.jsonc"), "utf8")) as any;
const packageManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as any;
const continuousIntegration = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
const releaseWorkflow = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");

function sha256(value: string | undefined): string | null {
  return value === undefined ? null : createHash("sha256").update(value).digest("hex");
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

async function worktreeStateDatabasePath(databaseDirectory: string, projectDirectory: string): Promise<string> {
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
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
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

function declaredOutputFiles(): string[] {
  return [
    "index.json",
    ...registry.components.flatMap((component: any) => [
      `components/${component.name}.json`,
      ...component.files.map((file: string | { path: string }) => `components/${component.name}/${typeof file === "string" ? file : file.path}`),
    ]),
  ].sort();
}

describe("self-contained Workcell registry", () => {
  test("declares the reviewed graph with one owner for every target", () => {
    expect(registry.version).toBe("0.2.0");
    expect(registry.opencode).toBe("1.18.27");
    expect(registry.ocx).toBe("2.0.14");
    expect(registry.components.map((component: any) => component.name)).toEqual([...expectedComponents]);
    expect(registry.components.every((component: any) => component.name === "workcell" || component.name.startsWith("workcell-"))).toBe(true);

    const profile = registry.components.find((component: any) => component.name === "workcell");
    expect(profile.dependencies).toEqual(["workcell-bundle"]);
    expect(profile.files).toEqual([
      { path: "profiles/workcell/ocx.jsonc", target: "ocx.jsonc" },
      { path: "profiles/workcell/opencode.jsonc", target: "opencode.jsonc" },
      { path: "profiles/workcell/AGENTS.md", target: "AGENTS.md" },
    ]);

    const owners = new Map<string, string>();
    for (const component of registry.components) {
      for (const file of component.files) {
        const target = typeof file === "string" ? file : file.target;
        expect(owners.has(target)).toBe(false);
        owners.set(target, component.name);
      }
      for (const dependency of component.dependencies ?? []) {
        expect(dependency).not.toContain("/");
        expect(registry.components.some((candidate: any) => candidate.name === dependency)).toBe(true);
      }
    }
    expect(owners.size).toBe(40);
  });

  test("preserves required ownership dependencies and exact npm payload pins", () => {
    const component = (name: string) => registry.components.find((candidate: any) => candidate.name === name);
    expect(component("workcell-background-agents").dependencies).toEqual(["workcell-primitives"]);
    expect(component("workcell-workspace-plugin").dependencies).toEqual(["workcell-background-agents", "workcell-primitives"]);
    expect(component("workcell-skill-plan-protocol").dependencies).toEqual(["workcell-workspace-plugin"]);
    expect(component("workcell-agent-coder").dependencies).toEqual(["workcell-background-agents"]);
    expect(component("workcell-agent-researcher").dependencies).toEqual(["workcell-background-agents"]);
    expect(component("workcell-agent-reviewer").dependencies).toEqual(["workcell-skill-code-review", "workcell-skill-plan-review"]);
    expect(component("workcell-review-command").dependencies).toEqual(["workcell-agent-reviewer"]);
    expect(component("workcell-philosophy").dependencies).toEqual(["workcell-skill-code-philosophy", "workcell-skill-frontend-philosophy"]);

    const npmPins = registry.components.flatMap((candidate: any) => candidate.npmDependencies ?? []).sort();
    expect(npmPins).toEqual([
      "detect-terminal@2.0.0",
      "jsonc-parser@3.3.1",
      "node-notifier@10.0.1",
      "unique-names-generator@4.7.1",
      "zod@4.3.5",
      "zod@4.3.5",
    ]);
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
    const expectedAgents = ["plan", "build", "coder", "debugger", "tester", "explore", "researcher", "scribe", "reviewer", "committer", "metadata"];
    expect(Object.keys(profileConfig.agent)).toEqual(expectedAgents);
    const expectedAgentMatrix = {
      plan: { mode: "primary", model: "openai/gpt-5.6-sol", temperature: 0.3, options: { reasoningEffort: "high", textVerbosity: "medium" }, promptHash: "7118513f19cbf2f399f6c19427a1f26805cf3242ea7a669971793fd69e1eba6b", permissionHash: "0d454b72b405822958d92cc6a0d9a089c71ebfd9ab96695716a3155892c80607" },
      build: { mode: "primary", model: "openai/gpt-5.6-sol", temperature: 0.3, options: { reasoningEffort: "medium", textVerbosity: "low" }, promptHash: "9df5756dc38e91b4d544cfe07c6f36259fe5af4d427d632657298e246fcff98d", permissionHash: "9f3fc4cee3d4818f87a8d9f33a78ec9a2007cf5ddabdc193166d5265eddd46cc" },
      coder: { mode: "subagent", model: "openai/gpt-5.6-sol", temperature: 0.1, options: { reasoningEffort: "medium", textVerbosity: "low" }, promptHash: null, permissionHash: "abc3ce922ce5e97b55b3476416fc22ee071fb67e02551fcbd70d2088488e1a9f" },
      debugger: { mode: "subagent", model: "openai/gpt-5.6-sol", temperature: 0.1, options: { reasoningEffort: "high", textVerbosity: "low" }, promptHash: null, permissionHash: "248d264ccca16e6ae459f95c64dde146315d52c03d3023a1ea71452280e2b8aa" },
      tester: { mode: "subagent", model: "openai/gpt-5.6-luna", temperature: null, options: { reasoningEffort: "low", textVerbosity: "low" }, promptHash: null, permissionHash: "b39b80d0763ea577f773c5b54e0f7e98a2ce3456ddee06c195c84cb7f61ca097" },
      explore: { mode: "subagent", model: "openai/gpt-5.6-luna", temperature: 0.2, options: { reasoningEffort: "medium", textVerbosity: "medium" }, promptHash: null, permissionHash: "633709901baf9320c903cd281fd313bde63c88affc0b0104e7be39983bb7eb3d" },
      researcher: { mode: "subagent", model: "openai/gpt-5.6-terra", temperature: 0.2, options: { reasoningEffort: "medium", textVerbosity: "medium" }, promptHash: null, permissionHash: "3195e419c7762ef3fc39342752d883715894a608c5a167081a73c65cb445000c" },
      scribe: { mode: "subagent", model: "openai/gpt-5.6-luna", temperature: 0.1, options: { reasoningEffort: "medium", textVerbosity: "low" }, promptHash: null, permissionHash: "5f2ca9314851177457b44938ce5af0c2acd1b35c124d9a5cac15a4a6d03f379b" },
      reviewer: { mode: "subagent", model: "openai/gpt-5.6-sol", temperature: 0.1, options: { reasoningEffort: "high", textVerbosity: "medium" }, promptHash: null, permissionHash: "b507ffe358db8b9a1520991e78649c39471796eb0fdd33b8f05c1df03dd43d03" },
      committer: { mode: "subagent", model: "openai/gpt-5.6-sol", temperature: 0.1, options: { reasoningEffort: "low", textVerbosity: "low" }, promptHash: null, permissionHash: "1996492edbd6929aa27e772435d67b5e880771fa6419622c2cdf63d196fc5bfd" },
      metadata: { mode: "subagent", model: "openai/gpt-5.6-luna", temperature: 0, options: { reasoningEffort: "low", textVerbosity: "low" }, promptHash: null, permissionHash: "38ea7f7fdf711cfa8d93ae20c92debe3909f28d6f6b4f3a82538af9f3c1c3b71" },
    };
    const actualAgentMatrix = Object.fromEntries(expectedAgents.map((name) => {
      const agent = profileConfig.agent[name];
      return [name, {
        mode: agent.mode,
        model: agent.model,
        temperature: agent.temperature ?? null,
        options: agent.options,
        promptHash: sha256(agent.prompt),
        permissionHash: sha256(JSON.stringify(agent.permission)),
      }];
    }));
    expect(actualAgentMatrix).toEqual(expectedAgentMatrix);
    expect(sha256(JSON.stringify(profileConfig.permission))).toBe("2810572f3bc9f4d8a8cb4cd62edb96a217aca74377bceadfa94c091d86828370");
    for (const name of expectedAgents) {
      expect(profileConfig.agent[name].reasoningEffort).toBeUndefined();
      expect(profileConfig.agent[name].textVerbosity).toBeUndefined();
    }
    expect({
      plan: profileConfig.agent.plan.permission.skill,
      build: profileConfig.agent.build.permission.skill,
      reviewer: profileConfig.agent.reviewer.permission.skill,
    }).toEqual({ plan: "allow", build: "allow", reviewer: "allow" });
    expect(Object.entries(profileConfig.agent.committer.permission.bash)).toEqual([
      ["*", "deny"],
      ["git status*", "allow"], ["git diff*", "allow"], ["git log*", "allow"], ["git show*", "allow"],
      ["git branch*", "allow"], ["git rev-parse*", "allow"], ["git symbolic-ref*", "allow"], ["git ls-files*", "allow"],
      ["git remote*", "allow"], ["git config --get *", "allow"], ["git add *", "allow"], ["git add .", "deny"],
      ["git add -A*", "deny"], ["git add --all*", "deny"], ["git add -u*", "deny"], ["git add --update*", "deny"],
      ["git apply --cached*", "allow"], ["git restore --staged *", "allow"], ["git commit*", "allow"],
      ["git commit -a*", "deny"], ["git commit --all*", "deny"], ["git push*", "ask"],
      ["git push --force*", "deny"], ["git push -f*", "deny"], ["gh auth status*", "allow"], ["gh repo view*", "allow"],
      ["gh pr status*", "allow"], ["gh pr list*", "allow"], ["gh pr view*", "allow"], ["gh pr create*", "allow"],
    ]);
    expect(profileConfig.agent.metadata.hidden).toBe(true);
    expect(profileConfig.mcp).toEqual({
      context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
      exa: { type: "remote", url: "https://mcp.exa.ai/mcp/oauth", enabled: true },
      gh_grep: { type: "remote", url: "https://mcp.grep.app", enabled: true },
    });
    expect(profileConfig.plugin).toEqual([
      "opencode-vibeguard@0.1.0",
      "@plannotator/opencode@0.27.11",
      "@tarquinen/opencode-dcp@3.1.15",
      "@franlol/opencode-md-table-formatter@0.0.6",
    ]);
  });

  test("contains no forbidden runtime dependency, integration, artifact, secret, symlink, or machine path", async () => {
    const sourceFiles = (await outputFiles(join(repositoryRoot, "files"))).map((path) => `files/${path}`);
    expect(sourceFiles).toHaveLength(40);
    for (const path of sourceFiles) {
      expect((await lstat(join(repositoryRoot, path))).isSymbolicLink()).toBe(false);
      expect(path).not.toMatch(/(?:\.DS_Store|node_modules|\.ocx\/|receipt|cache|lock)/i);
      const content = await readFile(join(repositoryRoot, path), "utf8");
      expect(content.toLowerCase()).not.toContain(`${"lin"}${"ear"}`);
      expect(content).not.toMatch(/(?:kdco\/workspace|registry\.kdco\.dev|@latest|@mohak34|\/Users\/|ghp_|github_pat_|phc_|(?:^|[^a-z])sk-)/i);
    }
    const profile = parse(await readFile(join(repositoryRoot, "files/profiles/workcell/ocx.jsonc"), "utf8")) as any;
    expect(profile.registries).toEqual({ matthewmorek: { url: "https://matthewmorek.github.io/ocx-profile-workcell" } });
    expect(profile.renameWindow).toBeUndefined();
    expect(profile.exclude).toEqual(["**/CLAUDE.md", "**/CONTEXT.md", "**/.opencode/**"]);
    expect(profile.include).toEqual(["**/AGENTS.md", "**/opencode.json"]);
  });

  test("preserves immutable KDCO provenance and accurate inspiration attributions", async () => {
    const notices = await readFile(join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
    const backgroundHeader = (await readFile(join(repositoryRoot, "files/plugins/background-agents.ts"), "utf8")).slice(0, 1_200);
    const worktreeHeader = (await readFile(join(repositoryRoot, "files/plugins/worktree.ts"), "utf8")).slice(0, 1_200);
    const kdcoRevision = "75e05a9a3280e5ee16953d7b9d6c42ad4d893697";
    const worktreeInspirationRevision = "93a55c23c9fd5ce9328d090d31a74e7357af5d8d";

    expect(notices).toContain(`immutable commit [\`${kdcoRevision}\`]`);
    expect(notices).toContain(`[LICENSES/KDCO-OCX-MIT.txt](LICENSES/KDCO-OCX-MIT.txt)`);
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

    expect(backgroundHeader).toContain("Copied and modified from KDCO OCX/Workspace under MIT.");
    expect(backgroundHeader).toContain("Attribution/inspiration only; no revision, file-copy mapping, or external license is asserted.");
    expect(backgroundHeader).toContain("THIRD_PARTY_NOTICES.md");
    expect(backgroundHeader).not.toContain("oh-my-opencode by @code-yeongyu (MIT License)");

    expect(worktreeHeader).toContain("Copied and modified from KDCO OCX/Workspace under MIT.");
    expect(worktreeHeader).toContain(worktreeInspirationRevision);
    expect(worktreeHeader).toContain("Apache-2.0");
    expect(worktreeHeader).toContain("THIRD_PARTY_NOTICES.md");
    expect(worktreeHeader).not.toContain("License: MIT");
  });

  test("ships every relative plugin import in the declared payload graph", async () => {
    const pluginFiles = (await outputFiles(join(repositoryRoot, "files/plugins"))).filter((path) => path.endsWith(".ts"));
    for (const pluginFile of pluginFiles) {
      const sourcePath = join(repositoryRoot, "files/plugins", pluginFile);
      const source = await readFile(sourcePath, "utf8");
      for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const importedPath = resolve(dirname(sourcePath), match[1]);
        const candidates = [importedPath, `${importedPath}.ts`, join(importedPath, "index.ts")];
        const resolvedImport = await Promise.any(candidates.map(async (candidate) => {
          if (await Bun.file(candidate).exists()) return candidate;
          throw new Error("missing");
        })).catch(() => undefined);
        expect(resolvedImport).toBeDefined();
      }
    }
  });

  test("builds exactly one packument and every declared payload file", async () => {
    const output = await buildOutput();
    try {
      expect(await outputFiles(output.directory)).toEqual(declaredOutputFiles());
      for (const name of expectedComponents) {
        const packument = JSON.parse(await Bun.file(join(output.directory, "components", `${name}.json`)).text());
        expect(Object.keys(packument.versions)).toEqual(["0.2.0"]);
        expect(packument["dist-tags"].latest).toBe("0.2.0");
      }
    } finally {
      if (output.remove) await rm(output.directory, { recursive: true, force: true });
    }
  });
});

describe("high-risk deterministic plugin boundaries", () => {
  test("parses launch context and builds profile-preserving session argv", () => {
    expect(parseActiveLaunchContext({})).toEqual({ mode: "plain" });
    expect(() => parseActiveLaunchContext({ OCX_CONTEXT: "1" })).toThrow("OCX_BIN");
    const context = parseActiveLaunchContext({ OCX_CONTEXT: "1", OCX_BIN: "/usr/local/bin/ocx", OCX_PROFILE: "workcell" });
    expect(buildSessionLaunchArgv(" session-1 ", context)).toEqual(["/usr/local/bin/ocx", "opencode", "-p", "workcell", "--session", "session-1"]);
    expect(parsePersistedLaunchMetadata({ launchMode: null })).toEqual({ mode: "plain" });
    expect(() => parsePersistedLaunchMetadata({ launchMode: "other" })).toThrow("unsupported launchMode");
  });

  test("maps stable notification states and strips title control characters", () => {
    expect(buildCmuxSessionStatusTransitionForEvent("session.status", { sessionID: " s1 ", status: { type: "BUSY" } })).toEqual({ sessionID: "s1", logicalState: "animated-busy" });
    expect(buildCmuxSessionStatusTransitionForEvent("permission.asked", { sessionID: "s1" })).toEqual({ sessionID: "s1", logicalState: "needs-input" });
    expect(buildCmuxSessionStatusTransitionForEvent("unknown", { sessionID: "s1" })).toBeNull();
    expect(sanitizeOscTitleText(" Workcell\u0007 ready ")).toBe("Workcell  ready");
  });

  test("isolates persisted delegation artifacts to valid direct-child IDs", async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), "workcell-delegations-"));
    const rootA = "root-a";
    const rootB = "root-b";
    const persistedID = "calm-blue-otter";
    const client = {
      app: { log: async () => ({}) },
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
      },
    } as any;
    const Manager = BackgroundAgentsPlugin.testInternals.DelegationManager;
    const manager = new Manager(client, baseDirectory, silentLog as any);

    try {
      await mkdir(join(baseDirectory, rootA), { recursive: true });
      await mkdir(join(baseDirectory, rootB), { recursive: true });
      await writeFile(join(baseDirectory, rootA, `${persistedID}.md`), "root A result");
      await writeFile(join(baseDirectory, rootB, `${persistedID}.md`), "root B secret");

      await expect(manager.readOutput(rootA, persistedID)).resolves.toBe("root A result");
      await expect(manager.readOutput(rootA, "missing-red-fox")).rejects.toThrow("was not found");

      for (const invalidID of [
        "",
        "malformed",
        "../root-b/calm-blue-otter",
        "/root-b/calm-blue-otter",
        "root-b/calm-blue-otter",
        "root-b\\calm-blue-otter",
        "calm--blue-otter",
      ]) {
        await expect(manager.readOutput(rootA, invalidID)).rejects.toThrow(/Delegation ID/);
      }
    } finally {
      await rm(baseDirectory, { recursive: true, force: true });
    }
  });

  test("rejects malformed generated delegation IDs before creating a child session", async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), "workcell-delegation-id-"));
    let createCalls = 0;
    const client = {
      app: {
        agents: async () => ({ data: [{ name: "explore", mode: "subagent" }] }),
        log: async () => ({}),
      },
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
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
      await expect(manager.delegate({
        parentSessionID: "root-a",
        parentMessageID: "message-1",
        parentAgent: "build",
        prompt: "Inspect the repository.",
        agent: "explore",
      })).rejects.toThrow(/Delegation ID/);
      expect(createCalls).toBe(0);
    } finally {
      await rm(baseDirectory, { recursive: true, force: true });
    }
  });

  test("keeps pending worktree deletes isolated by requesting session", () => {
    const database = createWorktreeStateDatabase();
    try {
      setPendingDelete(database, { sessionId: "session-a", branch: "branch-a", path: "/tmp/a" });
      setPendingDelete(database, { sessionId: "session-b", branch: "branch-b", path: "/tmp/b" });

      expect(getPendingDelete(database, "session-a")).toEqual({ sessionId: "session-a", branch: "branch-a", path: "/tmp/a" });
      expect(getPendingDelete(database, "session-b")).toEqual({ sessionId: "session-b", branch: "branch-b", path: "/tmp/b" });
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
      addSession(setup, { id: "legacy-session", branch: "legacy-branch", path: "/tmp/legacy", createdAt: "2026-09-03T00:00:00.000Z" });
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

      await expect(initStateDb(projectDirectory, { databaseDirectory })).rejects.toThrow("blocked legacy delete");

      const databasePath = await worktreeStateDatabasePath(databaseDirectory, projectDirectory);
      const afterRollback = new Database(databasePath);
      expect(getPendingDelete(afterRollback, "legacy-session")).toBeNull();
      expect(afterRollback.prepare("SELECT COUNT(*) AS count FROM pending_operations WHERE type = 'delete'").get()).toEqual({ count: 1 });
      afterRollback.exec("DROP TRIGGER reject_legacy_delete");
      afterRollback.close();

      const migrated = await initStateDb(projectDirectory, { databaseDirectory });
      expect(getPendingDelete(migrated, "legacy-session")).toEqual({ sessionId: "legacy-session", branch: "legacy-branch", path: "/tmp/legacy" });
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM pending_operations WHERE type = 'delete'").get()).toEqual({ count: 0 });
      migrated.exec("DELETE FROM pending_deletes");
      migrated.close();

      const concurrentWriter = new Database(databasePath);
      concurrentWriter.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE");
      concurrentWriter.exec(`
        INSERT OR REPLACE INTO pending_operations (id, type, branch, path, session_id)
        VALUES (1, 'delete', 'legacy-branch', '/tmp/legacy', NULL)
      `);

      const readyFile = join(sandbox, "initializer-ready");
      const initializer = Bun.spawn([
        process.execPath,
        "-e",
        `import { initStateDb } from "./files/plugins/worktree/state.ts"; await Bun.write(process.env.READY_FILE, "ready"); const db = await initStateDb(process.env.TEST_PROJECT_ROOT, { databaseDirectory: process.env.TEST_DB_DIRECTORY }); db.close();`,
      ], {
        cwd: repositoryRoot,
        env: { ...process.env, READY_FILE: readyFile, TEST_PROJECT_ROOT: projectDirectory, TEST_DB_DIRECTORY: databaseDirectory },
        stdout: "pipe",
        stderr: "pipe",
      });

      for (let attempt = 0; attempt < 50 && !(await Bun.file(readyFile).exists()); attempt++) await Bun.sleep(10);
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
      expect(getPendingDelete(afterContention, "legacy-session")).toEqual({ sessionId: "legacy-session", branch: "legacy-branch", path: "/tmp/legacy" });
      expect(afterContention.prepare("SELECT COUNT(*) AS count FROM pending_operations WHERE type = 'delete'").get()).toEqual({ count: 0 });
      afterContention.close();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("ignores unrelated idle events while preserving concurrent worktree deletes", async () => {
    const database = createWorktreeStateDatabase();
    const processPendingDelete = (WorktreePlugin.testInternals as any).processPendingWorktreeDelete;
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
      for (const [id, branch, path] of [["session-a", "branch-a", "/tmp/a"], ["session-b", "branch-b", "/tmp/b"]]) {
        addSession(database, { id, branch, path, createdAt: "2026-09-03T00:00:00.000Z" });
        setPendingDelete(database, { sessionId: id, branch, path });
      }

      await expect(processPendingDelete({ database, sessionID: "unrelated", repoRoot: "/repo", log: silentLog, ...dependencies })).resolves.toEqual({ status: "none" });
      expect(gitCalls).toEqual([]);
      expect(removeCalls).toEqual([]);
      expect(getPendingDelete(database, "session-a")).not.toBeNull();
      expect(getPendingDelete(database, "session-b")).not.toBeNull();

      await expect(processPendingDelete({ database, sessionID: "session-a", repoRoot: "/repo", log: silentLog, ...dependencies })).resolves.toEqual({ status: "removed", branch: "branch-a", path: "/tmp/a" });
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
    const processPendingDelete = (WorktreePlugin.testInternals as any).processPendingWorktreeDelete;
    const gitCalls: string[][] = [];
    let removeCalls = 0;
    addSession(database, { id: "session-a", branch: "branch-a", path: "/tmp/missing-a", createdAt: "2026-09-03T00:00:00.000Z" });
    setPendingDelete(database, { sessionId: "session-a", branch: "branch-a", path: "/tmp/missing-a" });

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
          return { ok: true, value: new TextEncoder().encode("worktree /repo\0HEAD abc123\0branch refs/heads/main\0\0") };
        },
        removeWorktreeFn: async () => {
          removeCalls += 1;
          return { ok: true, value: undefined };
        },
      });

      expect(outcome).toEqual({ status: "reconciled", branch: "branch-a", path: "/tmp/missing-a" });
      expect(gitCalls).toEqual([["worktree", "list", "--porcelain", "-z"]]);
      expect(removeCalls).toBe(0);
      expect(getPendingDelete(database, "session-a")).toBeNull();
      expect(getSession(database, "session-a")).toBeNull();
    } finally {
      database.close();
    }
  });

  test("retains absent worktree state when Git still registers it or verification fails", async () => {
    const processPendingDelete = (WorktreePlugin.testInternals as any).processPendingWorktreeDelete;
    const scenarios = [
      { name: "registered", gitResult: { ok: true, value: new TextEncoder().encode("worktree /tmp/missing-a\0HEAD abc123\0branch refs/heads/branch-a\0\0") }, reason: "remains registered with Git" },
      { name: "verification-failed", gitResult: { ok: false, error: "git metadata unavailable" }, reason: "git metadata unavailable" },
      { name: "unrecognized-output", gitResult: { ok: true, value: new TextEncoder().encode("worktree /repo\0HEAD abc123\0future-field value\0\0") }, reason: "unrecognized field" },
    ] as const;

    for (const scenario of scenarios) {
      const database = createWorktreeStateDatabase();
      const gitCalls: string[][] = [];
      addSession(database, { id: "session-a", branch: "branch-a", path: "/tmp/missing-a", createdAt: "2026-09-03T00:00:00.000Z" });
      setPendingDelete(database, { sessionId: "session-a", branch: "branch-a", path: "/tmp/missing-a" });

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
        expect("reason" in outcome ? outcome.reason : "", scenario.name).toContain(scenario.reason);
        expect(gitCalls, scenario.name).toEqual([["worktree", "list", "--porcelain", "-z"]]);
        expect(getPendingDelete(database, "session-a"), scenario.name).not.toBeNull();
        expect(getSession(database, "session-a"), scenario.name).not.toBeNull();
      } finally {
        database.close();
      }
    }
  });

  test("rolls back production cleanup and later reconciles through real Git", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "workcell-delete-transaction-"));
    const projectDirectory = join(sandbox, "project");
    const missingWorktreePath = join(sandbox, "missing-worktree");
    let database: Database | undefined;

    try {
      await createGitRepository(projectDirectory);
      database = await initStateDb(projectDirectory, { databaseDirectory: join(sandbox, "state") });
      addSession(database, { id: "session-a", branch: "branch-a", path: missingWorktreePath, createdAt: "2026-09-03T00:00:00.000Z" });
      setPendingDelete(database, { sessionId: "session-a", branch: "branch-a", path: missingWorktreePath });
      database.exec(`
        CREATE TRIGGER abort_session_delete
        BEFORE DELETE ON sessions
        WHEN OLD.id = 'session-a'
        BEGIN
          SELECT RAISE(ABORT, 'forced session cleanup failure');
        END;
      `);

      const createPlugin = (WorktreePlugin.testInternals as any).createWorktreePlugin;
      const plugin = await createPlugin({
        directory: projectDirectory,
        client: { app: { log: async () => ({}) } },
      }, { database });

      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-a" } } });
      expect(getPendingDelete(database, "session-a")).toEqual({ sessionId: "session-a", branch: "branch-a", path: missingWorktreePath });
      expect(getSession(database, "session-a")).not.toBeNull();

      database.exec("DROP TRIGGER abort_session_delete");
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-a" } } });
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
      await runGit(["worktree", "add", "-b", "quoted-worktree", aliasedWorktreePath], projectDirectory);
      const physicalWorktreePath = await realpath(aliasedWorktreePath);
      await rm(physicalWorktreePath, { recursive: true, force: true });

      database = await initStateDb(projectDirectory, { databaseDirectory: join(sandbox, "state") });
      addSession(database, { id: "session-a", branch: "quoted-worktree", path: aliasedWorktreePath, createdAt: "2026-09-03T00:00:00.000Z" });
      setPendingDelete(database, { sessionId: "session-a", branch: "quoted-worktree", path: aliasedWorktreePath });

      const createPlugin = (WorktreePlugin.testInternals as any).createWorktreePlugin;
      const plugin = await createPlugin({
        directory: projectDirectory,
        client: { app: { log: async () => ({}) } },
      }, { database });

      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-a" } } });

      expect(getPendingDelete(database, "session-a")).toEqual({ sessionId: "session-a", branch: "quoted-worktree", path: aliasedWorktreePath });
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
      addSession(database, { id: "session-a", branch: "branch-a", path: missingWorktreePath, createdAt: "2026-09-03T00:00:00.000Z" });
      setPendingDelete(database, { sessionId: "session-a", branch: "branch-a", path: missingWorktreePath });

      const createPlugin = (WorktreePlugin.testInternals as any).createWorktreePlugin;
      const plugin = await createPlugin({
        directory: projectDirectory,
        client: { app: { log: async () => ({}) } },
      }, { database });

      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-a" } } });

      expect(getPendingDelete(database, "session-a")).toBeNull();
      expect(getSession(database, "session-a")).toBeNull();
    } finally {
      database.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("retains worktree delete state after every snapshot or removal failure", async () => {
    const processPendingDelete = (WorktreePlugin.testInternals as any).processPendingWorktreeDelete;
    const scenarios = [
      { name: "add", results: [{ ok: false, error: "add failed" }] },
      { name: "commit", results: [{ ok: true, value: "" }, { ok: false, error: "commit failed" }] },
      { name: "status", results: [{ ok: true, value: "" }, { ok: true, value: "" }, { ok: false, error: "status failed" }] },
      { name: "dirty", results: [{ ok: true, value: "" }, { ok: true, value: "" }, { ok: true, value: " M changed.ts" }] },
      { name: "remove", results: [{ ok: true, value: "" }, { ok: true, value: "" }, { ok: true, value: "" }], removeError: "remove failed" },
    ] as const;

    for (const scenario of scenarios) {
      const database = createWorktreeStateDatabase();
      let resultIndex = 0;
      let removeCalls = 0;
      addSession(database, { id: "session-a", branch: "branch-a", path: "/tmp/a", createdAt: "2026-09-03T00:00:00.000Z" });
      setPendingDelete(database, { sessionId: "session-a", branch: "branch-a", path: "/tmp/a" });

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
            const removeError = "removeError" in scenario ? scenario.removeError : undefined;
            return removeError ? { ok: false, error: removeError } : { ok: true, value: undefined };
          },
        });

        expect(outcome.status).toBe("retained");
        expect(getPendingDelete(database, "session-a"), scenario.name).not.toBeNull();
        expect(getSession(database, "session-a"), scenario.name).not.toBeNull();
        expect(removeCalls, scenario.name).toBe(scenario.name === "remove" ? 1 : 0);
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
      await writeFile(join(projectDirectory, ".opencode", "worktree.jsonc"), JSON.stringify({ hooks: { postCreate: [], preDelete: ["exit 23"] } }));

      const createPlugin = (WorktreePlugin.testInternals as any).createWorktreePlugin;
      const plugin = await createPlugin({
        directory: projectDirectory,
        client: { app: { log: async () => ({}) } },
      }, {
        database,
        gitFn: async (args: string[]) => {
          gitCalls.push(args);
          return { ok: true, value: "" };
        },
        removeWorktreeFn: async () => {
          removeCalls += 1;
          return { ok: true, value: undefined };
        },
      });
      addSession(database, {
        id: "session-a",
        branch: "branch-a",
        path: worktreePath,
        createdAt: "2026-09-03T00:00:00.000Z",
      });

      await plugin.tool.worktree_delete.execute({ reason: "finished" }, { sessionID: "session-a" });
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "unrelated-session" } } });
      expect(getPendingDelete(database, "session-a")).not.toBeNull();
      expect(gitCalls).toEqual([]);
      expect(removeCalls).toBe(0);

      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-a" } } });
      expect(getPendingDelete(database, "session-a")).toEqual({ sessionId: "session-a", branch: "branch-a", path: worktreePath });
      expect(getSession(database, "session-a")).not.toBeNull();
      expect(gitCalls).toEqual([]);
      expect(removeCalls).toBe(0);
    } finally {
      database.close();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("production idle handling retains matched and unrelated state for schema-invalid config", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "workcell-invalid-delete-config-"));
    const projectDirectory = join(sandbox, "project");
    const database = createWorktreeStateDatabase();
    const gitCalls: string[][] = [];
    let removeCalls = 0;

    try {
      await mkdir(join(projectDirectory, ".opencode"), { recursive: true });
      await writeFile(
        join(projectDirectory, ".opencode", "worktree.jsonc"),
        JSON.stringify({ hooks: { postCreate: [], preDelete: "must-be-an-array" } }),
      );
      for (const [id, branch, worktreePath] of [
        ["session-a", "branch-a", join(sandbox, "worktree-a")],
        ["session-b", "branch-b", join(sandbox, "worktree-b")],
      ]) {
        addSession(database, { id, branch, path: worktreePath, createdAt: "2026-09-03T00:00:00.000Z" });
        setPendingDelete(database, { sessionId: id, branch, path: worktreePath });
      }

      const createPlugin = (WorktreePlugin.testInternals as any).createWorktreePlugin;
      const plugin = await createPlugin({
        directory: projectDirectory,
        client: { app: { log: async () => ({}) } },
      }, {
        database,
        gitFn: async (args: string[]) => {
          gitCalls.push(args);
          return { ok: true, value: "" };
        },
        removeWorktreeFn: async () => {
          removeCalls += 1;
          return { ok: true, value: undefined };
        },
      });

      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-a" } } });

      expect(gitCalls).toEqual([]);
      expect(removeCalls).toBe(0);
      expect(getPendingDelete(database, "session-a")).not.toBeNull();
      expect(getSession(database, "session-a")).not.toBeNull();
      expect(getPendingDelete(database, "session-b")).not.toBeNull();
      expect(getSession(database, "session-b")).not.toBeNull();

      await writeFile(join(projectDirectory, ".opencode", "worktree.jsonc"), "{ invalid jsonc");
      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-a" } } });
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
    const sandbox = await mkdtemp(join(tmpdir(), "workcell-unreadable-delete-config-"));
    const projectDirectory = join(sandbox, "project");
    const worktreePath = join(sandbox, "worktree");
    const database = createWorktreeStateDatabase();
    let gitCalls = 0;
    let removeCalls = 0;

    try {
      await mkdir(projectDirectory, { recursive: true });
      addSession(database, { id: "session-a", branch: "branch-a", path: worktreePath, createdAt: "2026-09-03T00:00:00.000Z" });
      setPendingDelete(database, { sessionId: "session-a", branch: "branch-a", path: worktreePath });

      const createPlugin = (WorktreePlugin.testInternals as any).createWorktreePlugin;
      const plugin = await createPlugin({
        directory: projectDirectory,
        client: { app: { log: async () => ({}) } },
      }, {
        database,
        readConfigFileFn: async () => {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
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
      });

      await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-a" } } });

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
      const hooks = await WorkspacePlugin({
        directory: sandbox,
        client: {
          session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) },
        },
      } as any) as any;
      const validPlan = `---\nstatus: in-progress\nphase: 1\nupdated: 2026-09-03\n---\n\n# Implementation Plan\n\n## Goal\nRepair the validated plan workflow.\n\n## Phase 1: Repair [IN PROGRESS]\n- [ ] 1.1 Apply the repair ← CURRENT\n`;
      const successOutput = { title: "", output: await hooks.tool.plan_save.execute({ content: validPlan }, { sessionID: "session-a" }), metadata: {} };
      await hooks["tool.execute.after"]({ tool: "plan_save", sessionID: "session-a", callID: "call-a" }, successOutput);
      expect(successOutput.output).toContain("Plan saved successfully. You MUST now delegate to the reviewer");

      const failureOutput = { title: "", output: await hooks.tool.plan_save.execute({ content: "not a valid plan" }, { sessionID: "session-a" }), metadata: {} };
      const originalFailure = failureOutput.output;
      await hooks["tool.execute.after"]({ tool: "plan_save", sessionID: "session-a", callID: "call-b" }, failureOutput);
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
    await expect(outputDirectory(["--out", "."], repositoryRoot)).rejects.toThrow("current directory");
    await expect(outputDirectory(["--out", dirname(repositoryRoot)], repositoryRoot)).rejects.toThrow("repository root or one of its ancestors");
    await expect(outputDirectory(["--out", "/"], repositoryRoot)).rejects.toThrow("filesystem root");
  });

  test("permits exact dist or external directories and rejects symlinks", async () => {
    const temporaryRepository = await mkdtemp(join(tmpdir(), "ocx-registry-repository-"));
    const externalOutput = await mkdtemp(join(tmpdir(), "ocx-registry-output-"));
    try {
      expect(await outputDirectory(["--out", "dist"], temporaryRepository, temporaryRepository)).toBe(join(await realpath(temporaryRepository), "dist"));
      expect(await outputDirectory(["--out", externalOutput], repositoryRoot)).toBe(await realpath(externalOutput));
      await symlink(externalOutput, join(temporaryRepository, "linked"), "dir");
      await expect(outputDirectory(["--out", "linked"], temporaryRepository, temporaryRepository)).rejects.toThrow("symbolic link");
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
      await expect(promoteStagedOutput(join(parent, "missing-stage"), output)).rejects.toThrow("previous output was restored");
      await expect(readFile(join(output, "previous.txt"), "utf8")).resolves.toBe("keep me");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("pinned automation", () => {
  test("pins package and launch identities and isolates inherited launch overrides", () => {
    expect(packageManifest).toMatchObject({ name: "ocx-profile-workcell", version: "0.2.0", packageManager: "bun@1.3.5" });
    expect(packageManifest.devDependencies).toMatchObject({ ocx: "2.0.14", "opencode-ai": "1.18.27", "@opencode-ai/plugin": "1.18.27", "@opencode-ai/sdk": "1.18.27" });
    expect(profileLaunchCommand).toBe("ocx");
    expect(profileLaunchArguments).toEqual(["oc", "-p", "workcell", "--", "--help"]);
    const environment = smokeEnvironment({ PATH: "/usr/bin:/bin", OPENCODE_CONFIG: "bad", OCX_PROFILE: "bad" }, "/tmp/ocx-smoke");
    expect(environment.HOME).toBe("/tmp/ocx-smoke/home");
    expect(environment.OPENCODE_CONFIG).toBeUndefined();
    expect(environment.OCX_PROFILE).toBeUndefined();
  });

  test("cleans a smoke sandbox and runs all release gates with data-driven live comparison", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "ocx-smoke-cleanup-"));
    let stopped = false;
    await cleanupSmokeSandbox(sandbox, { stop: async () => { stopped = true; } });
    expect(stopped).toBe(true);
    expect(await Bun.file(sandbox).exists()).toBe(false);
    for (const workflow of [continuousIntegration, releaseWorkflow]) {
      expect(workflow).toContain("bun install --frozen-lockfile");
      expect(workflow).toContain("bun run typecheck");
      expect(workflow).toContain("bun run build");
      expect(workflow).toContain("REGISTRY_DIST=dist bun run test");
      expect(workflow).toContain("REGISTRY_DIST=dist bun run smoke");
    }
    expect(releaseWorkflow).toContain("find . -type f");
    expect(releaseWorkflow).toContain("cmp \"dist/$file\"");
    expect(releaseWorkflow).not.toContain("components/ws");
  });
});
