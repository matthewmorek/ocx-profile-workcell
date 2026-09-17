import { expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import { join, resolve } from "node:path";

import type { PluginInput } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";

import BackgroundAgentsPlugin from "../files/plugins/background-agents";
import { createAuthenticatedGit } from "../files/plugins/review/auth";
import { registerReviewBridge } from "../files/plugins/review/bridge";
import {
  git,
  gitEnvironment,
  gitOptions,
  type Command,
} from "../files/plugins/review/process";
import { ReviewRuntime } from "../files/plugins/review/runtime";
import { ReviewStore } from "../files/plugins/review/store";

test("review delegation routes through owned slots, never normal artifacts or peer reads", async () => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await realpath(
    await mkdtemp(resolve(".tmp/review-integration-")),
  );
  const project = join(root, "project");
  await mkdir(project);
  const home = spyOn(os, "homedir").mockReturnValue(root);
  try {
    await git(project, ["init", "--template=", "-b", "main"]);
    await writeFile(join(project, "file.txt"), "fixture\n");
    await git(project, ["add", "file.txt"]);
    await git(project, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const sessions = new Map<string, Record<string, unknown>>();
    let next = 0;
    const prompts: string[] = [];
    let archivedOutput: string | undefined = undefined;
    let onPrompt: (id: string) => Promise<void> = async () => {};
    const client = {
      session: {
        list: async () => ({ data: [...sessions.values()] }),
        create: async ({ body }: { body: Record<string, unknown> }) => {
          const id = `session${++next}`;
          const data = { ...body, id, directory: project };
          sessions.set(id, data);
          return { data };
        },
        get: async ({ path }: { path: { id: string } }) => ({
          data: sessions.get(path.id),
          response: { status: sessions.has(path.id) ? 200 : 404 },
        }),
        prompt: async ({ path }: { path: { id: string } }) => {
          prompts.push(path.id);
          await onPrompt(path.id);
          return { data: { parts: [{ type: "text", text: "worker ended" }] } };
        },
        status: async () => ({ data: {} }),
        messages: async () => ({
          data: archivedOutput
            ? [
                {
                  parts: [
                    {
                      type: "tool",
                      tool: "review_start",
                      state: { status: "completed", output: archivedOutput },
                    },
                  ],
                },
              ]
            : [],
        }),
        abort: async () => ({ data: true }),
        delete: async ({ path }: { path: { id: string } }) => {
          sessions.delete(path.id);
          return { data: true };
        },
      },
      tui: { showToast: async () => ({ data: true }) },
      app: { log: async () => ({ data: true }) },
    };
    const input = {
      client,
      directory: project,
      project: { id: "fixture", worktree: project },
      worktree: project,
    } as unknown as PluginInput;
    const store = await ReviewStore.open(project, join(root, "reviews"));
    const runtime = new ReviewRuntime(input, store);
    registerReviewBridge(project, runtime);
    const context = (sessionID: string, agent: string): ToolContext => ({
      sessionID,
      agent,
      messageID: `message-${sessionID}`,
      directory: project,
      worktree: project,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    });
    const origin = context("origin", "build");
    const started = JSON.parse(await runtime.start("recent", origin));
    expect(JSON.parse(await runtime.start("recent", origin))).toEqual(started);
    const coordinator = context(started.session, "review");
    await expect(runtime.start("recent", coordinator)).rejects.toThrow();
    await runtime.state(
      {
        action: "prepare",
        context: {
          specification: "Fixture",
          instructions: "None",
          testEvidence: "Not run",
          risk: "behavior",
        },
      },
      coordinator,
    );
    await expect(
      runtime.state(
        { action: "plan", lenses: ["a", "b", "c", "d", "e"] },
        coordinator,
      ),
    ).rejects.toThrow();
    const slots = JSON.parse(
      await runtime.state(
        { action: "plan", lenses: ["behavior", "security"] },
        coordinator,
      ),
    );
    const background = await BackgroundAgentsPlugin(input);
    const tools = background.tool!;
    const worker = context(slots[0].session, "reviewer");
    await expect(
      tools.delegation_read.execute({ id: slots[1].id }, worker),
    ).rejects.toThrow();
    expect(
      await tools.delegate.execute(
        { agent: "coder", prompt: "write", review_slot: slots[0].id },
        coordinator,
      ),
    ).toContain("Use a planned reviewer slot");
    const result = await tools.delegate.execute(
      {
        agent: "reviewer",
        prompt: "Inspect the contract",
        review_slot: slots[0].id,
      },
      coordinator,
    );
    expect(String(result)).toContain(slots[0].id);
    for (let i = 0; i < 100; i++) {
      if (
        (await store.load(started.review)).rounds[0].slots[0].outcome ===
        "failed"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await store.load(started.review)).rounds[0].slots[0].outcome).toBe(
      "failed",
    );
    expect(
      String(
        await tools.delegation_read.execute({ id: slots[0].id }, coordinator),
      ),
    ).toContain("worker ended");
    expect(prompts.filter((id) => id === slots[0].session)).toHaveLength(1);
    expect(
      String(
        await tools.delegate.execute(
          { agent: "reviewer", prompt: "again", review_slot: slots[0].id },
          coordinator,
        ),
      ),
    ).toContain("not dispatchable");
    // Ordinary manager may create its directory/debug log, but never a review finding artifact.
    async function assertNoReviewArtifacts(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory())
          await assertNoReviewArtifacts(join(path, entry.name));
        else expect(entry.name.endsWith(".md")).toBe(false);
      }
    }
    await assertNoReviewArtifacts(
      join(root, ".local/share/opencode/delegations"),
    );
    await runtime.close(started.review, runtime.actor(origin));
    expect(sessions.size).toBe(0);
    // A numeric filename must remain local even with no GitHub origin configured.
    await writeFile(join(project, "123"), "numeric file scope\n");
    const numeric = JSON.parse(
      await runtime.start("123", { ...origin, messageID: "numeric-file" }),
    );
    expect((await store.load(numeric.review)).scope).toEqual({
      kind: "paths",
      paths: ["123"],
    });
    await runtime.close(numeric.review, runtime.actor(origin));
    const second = JSON.parse(
      await runtime.start("recent", { ...origin, messageID: "second-request" }),
    );
    const secondCoordinator = context(second.session, "review");
    await runtime.state(
      {
        action: "prepare",
        context: {
          specification: "Fixture",
          instructions: "None",
          testEvidence: "Not run",
          risk: "behavior",
        },
      },
      secondCoordinator,
    );
    const [slot] = JSON.parse(
      await runtime.state(
        { action: "plan", lenses: ["comprehensive"] },
        secondCoordinator,
      ),
    );
    onPrompt = async (id) => {
      if (id !== slot.session) return;
      await runtime.state(
        {
          action: "submit",
          round: 1,
          outcome: "succeeded",
          coverage: ["Fixture and consumers"],
          limitations: ["Tests not run"],
          candidates: [],
        },
        context(slot.session, "reviewer"),
      );
    };
    await tools.delegate.execute(
      {
        agent: "reviewer",
        review_slot: slot.id,
        prompt: "Review the complete fixture",
      },
      secondCoordinator,
    );
    await runtime.state(
      {
        action: "complete",
        report: "APPROVE. Complete, current coverage; tests not run.",
      },
      secondCoordinator,
    );
    expect(prompts).not.toContain(origin.sessionID);
    await expect(
      runtime.close(second.review, runtime.actor(origin)),
    ).rejects.toThrow("Retrieve review_start");
    archivedOutput = await runtime.start(`status ${second.review}`, origin);
    expect(JSON.parse(archivedOutput).report).toContain("APPROVE");
    await runtime.close(second.review, runtime.actor(origin));
    expect(sessions.size).toBe(0);
  } finally {
    home.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("authenticated fetch uses only the fixed host gh helper without tokens in argv", async () => {
  let captured: Command | undefined;
  const transport = createAuthenticatedGit(async (command) => {
    captured = command;
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  });
  await transport({
    argv: [
      "git",
      ...gitOptions,
      "fetch",
      "--no-tags",
      "https://github.com/example/repo.git",
      "+refs/pull/1/head:refs/review/head",
    ],
    cwd: import.meta.dir,
    env: gitEnvironment(),
  });
  expect(
    captured!.argv.some((arg) =>
      arg.includes("credential.https://github.com/example/repo.git.helper="),
    ),
  ).toBe(true);
  expect(captured!.argv.join(" ")).toContain("gh auth git-credential get");
  expect(captured!.argv.join(" ")).not.toContain("auth token");
  expect(captured!.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(captured!.argv).not.toContain("credential.helper=");
});
