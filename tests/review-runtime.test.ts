import { expect, test } from "bun:test";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk";
import { parse } from "jsonc-parser";

import { fingerprint } from "../files/plugins/review/contracts";
import { git } from "../files/plugins/review/process";
import { sessionRules } from "../files/plugins/review/session";
import { newId, ReviewStore } from "../files/plugins/review/store";

type ModelMessage = {
  role: string;
  content: string | { type: string; text?: string }[];
};
function text(message: ModelMessage): string {
  return typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((p) => p.text ?? "").join("\n");
}
async function treeFingerprint(root: string): Promise<string> {
  const files: [string, string][] = [];
  async function visit(path: string) {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name),
        info = await lstat(full);
      if (info.isDirectory()) await visit(full);
      else
        files.push([
          full.slice(root.length),
          (await readFile(full)).toString("base64"),
        ]);
    }
  }
  await visit(root);
  return fingerprint(files);
}

// Real pinned runtime, shipped agent prompts/permissions, real public tools and local Git.
// Only model/provider and external plugin services are replaced by deterministic local fixtures.
test("OpenCode 1.18.25 public review lifecycle preserves caller context, restrictions, recovery, reuse and source state", async () => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await realpath(await mkdtemp(resolve(".tmp/review-runtime-")));
  const project = join(root, "project");
  await mkdir(project);
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
  await writeFile(join(project, "file.txt"), "dirty caller content\n");
  const handoff = {
    requirements: "Fixture must preserve tenant isolation.",
    constraints: ["No target execution"],
    evidence: [
      {
        reference: "caller-only-plan",
        summary: "The caller's plan requires tenant-scoped caching.",
      },
    ],
  };
  const context = {
    specification: "Caller tenant-isolation contract",
    instructions: "No additional instructions",
    testEvidence: "No local tests",
    risk: "behavior",
  };
  const observed: { role: string; tools: string[] }[] = [];
  const seenAssignments: unknown[] = [];
  const failures: string[] = [];
  let call = 0;
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: ModelMessage[];
        tools?: { function: { name: string } }[];
      };
      let index = -1;
      body.messages.forEach((m, i) => {
        if (
          m.role === "user" &&
          /Runtime acceptance:|Standalone permission probe|Coordinate review [a-f0-9]{32}|Review [a-f0-9]{32}, round|All reviewer slots for review/.test(
            text(m),
          )
        )
          index = i;
      });
      const prompt = index >= 0 ? text(body.messages[index]) : "";
      const outputs = body.messages
        .slice(index + 1)
        .filter((m) => m.role === "tool")
        .map((m) => text(m));
      const decoded = outputs.map((value) => {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      });
      const role = prompt.includes("Runtime acceptance:")
        ? "origin"
        : prompt.includes("Standalone permission probe")
          ? "standalone"
          : /Review [a-f0-9]{32}, round/.test(prompt)
            ? "worker"
            : "coordinator";
      observed.push({
        role,
        tools: body.tools?.map((t) => t.function.name) ?? [],
      });
      let operation: { name: string; args: unknown } | undefined;
      try {
        if (role === "origin" && !outputs.length)
          operation = {
            name: "review_start",
            args: JSON.parse(
              prompt
                .slice(
                  prompt.indexOf("Runtime acceptance:") +
                    "Runtime acceptance:".length,
                )
                .trim(),
            ),
          };
        else if (role === "worker") {
          const round = Number(/, round (\d+)/.exec(prompt)![1]);
          const actions = [
            {
              name: "bash",
              args: {
                command: `touch ${join(root, "executed")}`,
                description: "Denied permission sentinel",
              },
            },
            {
              name: "review_state",
              args: { input: { action: "assignment", round } },
            },
            {
              name: "review_inspect",
              args: { round, request: { kind: "diff" } },
            },
            {
              name: "review_state",
              args: {
                input: {
                  action: "submit",
                  round,
                  outcome: "succeeded",
                  coverage: ["Pinned fixture and caller contract"],
                  limitations: ["No target tests run"],
                  candidates: [],
                },
              },
            },
          ];
          operation = actions[outputs.length];
          for (const value of decoded)
            if (value && typeof value === "object" && "handoff" in value)
              seenAssignments.push(value.handoff);
        } else if (index >= 0 && role === "coordinator") {
          const wake = prompt.includes("All reviewer slots for review");
          if (!outputs.length)
            operation = {
              name: "review_state",
              args: { input: { action: "status" } },
            };
          else if (wake) {
            if (outputs.length === 1)
              operation = {
                name: "review_state",
                args: { input: { action: "adjudicate", dispositions: [] } },
              };
            if (outputs.length === 2)
              operation = {
                name: "review_state",
                args: {
                  input: {
                    action: "complete",
                    report:
                      "APPROVE. Complete/current fixture coverage; no target tests run.",
                  },
                },
              };
          } else {
            if (outputs.length === 1)
              operation = {
                name: "review_state",
                args: { input: { action: "prepare", context } },
              };
            const prepared = decoded[1] as { reused?: boolean } | undefined;
            if (outputs.length === 2)
              operation = prepared?.reused
                ? {
                    name: "review_state",
                    args: {
                      input: {
                        action: "complete",
                        report:
                          "APPROVE. Code coverage reused; current evidence rechecked.",
                      },
                    },
                  }
                : {
                    name: "review_state",
                    args: {
                      input: {
                        action: "plan",
                        lenses: ["comprehensive behavior and contract"],
                      },
                    },
                  };
            if (outputs.length === 3 && !prepared?.reused) {
              const slots = decoded[2] as { id: string }[];
              if (!Array.isArray(slots) || !slots[0]?.id)
                throw new Error(`Plan did not return slots: ${outputs[2]}`);
              operation = {
                name: "delegate",
                args: {
                  agent: "reviewer",
                  review_slot: slots[0].id,
                  prompt:
                    "Review the caller's tenant-isolation contract against this pinned fixture.",
                },
              };
            }
          }
        }
      } catch (error) {
        failures.push(String(error));
      }
      const delta = operation
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${++call}`,
                type: "function",
                function: {
                  name: operation.name,
                  arguments: JSON.stringify(operation.args),
                },
              },
            ],
          }
        : { role: "assistant", content: "done" };
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock",
        choices: [{ index: 0, delta, finish_reason: null }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: operation ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const profile = parse(
    await readFile(resolve("files/profiles/workcell/opencode.jsonc"), "utf8"),
  );
  expect(profile.agent.reviewer.permission.bash["gh pr view *"]).toBe("allow");
  expect(profile.agent.reviewer.permission.bash["gh pr checks *"]).toBe(
    "allow",
  );
  for (const [name, agent] of Object.entries(profile.agent) as [
    string,
    { model: string; prompt?: string },
  ][]) {
    agent.model = "review-test/mock";
    if (!agent.prompt) {
      try {
        agent.prompt = await readFile(
          resolve(`files/agents/${name}.md`),
          "utf8",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  await writeFile(
    join(project, "opencode.json"),
    JSON.stringify({
      $schema: profile.$schema,
      agent: profile.agent,
      permission: profile.permission,
      subagent_depth: profile.subagent_depth,
      plugin: [
        new URL("../files/plugins/review.ts", import.meta.url).href,
        new URL("../files/plugins/background-agents.ts", import.meta.url).href,
      ],
      skills: { paths: [resolve("files/skills/code-review")] },
      snapshot: false,
      provider: {
        "review-test": {
          npm: "@ai-sdk/openai-compatible",
          name: "Fixture",
          options: {
            baseURL: `http://127.0.0.1:${model.port}/v1`,
            apiKey: "fixture",
          },
          models: {
            mock: { name: "mock", limit: { context: 100000, output: 2000 } },
          },
        },
      },
      model: "review-test/mock",
      small_model: "review-test/mock",
    }),
  );
  const child = Bun.spawn(
    [
      resolve("node_modules/.bin/opencode"),
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ],
    {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let logs = "";
  void (async () => {
    for await (const bytes of child.stderr)
      logs += new TextDecoder().decode(bytes);
  })();
  const timeout = setTimeout(() => child.kill(), 60000);
  try {
    let stdout = "";
    const reader = child.stdout.getReader();
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(stdout)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`Runtime failed: ${logs}`);
      stdout += new TextDecoder().decode(value);
    }
    const client = createOpencodeClient({
      baseUrl: stdout.match(/http:\/\/127\.0\.0\.1:\d+/)![0],
    });
    const origin = (
      await client.session.create({
        body: { title: "Runtime acceptance origin" },
        query: { directory: project },
      })
    ).data!;
    const before = await treeFingerprint(project);
    async function invoke(args: unknown): Promise<string> {
      const result = await client.session.prompt({
        path: { id: origin.id },
        query: { directory: project },
        body: {
          agent: "build",
          parts: [
            {
              type: "text",
              text: `Runtime acceptance: ${JSON.stringify(args)}`,
            },
          ],
        },
      });
      if (result.error)
        throw new Error(
          `Origin prompt failed: ${JSON.stringify(result.error)}`,
        );
      const messages = await client.session.messages({
        path: { id: origin.id },
        query: { directory: project },
      });
      const part = messages.data
        ?.flatMap((m) => m.parts)
        .filter((p) => p.type === "tool" && p.tool === "review_start")
        .at(-1);
      if (!part || part.type !== "tool" || part.state.status !== "completed")
        throw new Error(
          `Public entry failed: ${JSON.stringify(part)}; model failures: ${failures}`,
        );
      return part.state.output;
    }
    const started = JSON.parse(await invoke({ scope: "recent", handoff }));
    const store = await ReviewStore.open(
      project,
      join(root, ".local/share/workcell/reviews"),
    );
    async function completed(number: number) {
      for (let i = 0; i < 300; i++) {
        const m = await store.load(started.review);
        if (m.lastCompleted === number) return m;
        await Bun.sleep(50);
      }
      const m = await store.load(started.review);
      const transcripts = await Promise.all(
        m.managedSessions.map(
          async (id) =>
            (
              await client.session.messages({
                path: { id },
                query: { directory: project },
              })
            ).data,
        ),
      );
      throw new Error(
        `Round ${number} incomplete: ${JSON.stringify(m)}\n${JSON.stringify(transcripts)}\n${failures}`,
      );
    }
    const first = await completed(1);
    expect(first.handoff).toEqual(handoff);
    expect(seenAssignments).toContainEqual(handoff);
    const coordinator = (
      await client.session.get({
        path: { id: started.session },
        query: { directory: project },
      })
    ).data as unknown as { parentID?: string; permission: unknown };
    expect(coordinator.parentID).toBeUndefined();
    expect(coordinator.permission).toEqual(sessionRules(false));
    const workerID = first.rounds[0].slots[0].session;
    const worker = (
      await client.session.get({
        path: { id: workerID },
        query: { directory: project },
      })
    ).data as unknown as { parentID: string; permission: unknown };
    expect(worker.parentID).toBe(started.session);
    expect(worker.permission).toEqual(sessionRules(true));
    expect(
      JSON.parse(await invoke({ scope: `status ${started.review}` })).report,
    ).toContain("APPROVE");
    // Unrelated damaged inventory and a stranded create.lock must not disable public recovery.
    const incomplete = newId();
    await mkdir(store.directory(incomplete), { mode: 0o700 });
    const partition = join(
      root,
      ".local/share/workcell/reviews",
      fingerprint(project),
    );
    const stopped = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
    await stopped.exited;
    await writeFile(
      join(partition, "create.lock"),
      JSON.stringify({ pid: stopped.pid, host: hostname(), token: newId() }),
    );
    expect(await invoke({ scope: "recover create" })).toContain("recovered");
    expect(JSON.parse(await invoke({ scope: "list" })).issues).toContainEqual({
      id: incomplete,
      state: "unavailable",
    });
    await invoke({ scope: `resume ${started.review}` });
    const second = await completed(2);
    expect(second.rounds[1].basis).toBe("reused");
    expect(second.rounds[1].slots[0].session).toBe(workerID);
    expect(
      JSON.parse(await invoke({ scope: `status ${started.review}` })).report,
    ).toContain("reused");
    expect(await invoke({ scope: `close ${started.review}` })).toContain(
      "closed",
    );
    await expect(lstat(store.directory(started.review))).rejects.toThrow();
    expect(
      (
        await client.session.get({
          path: { id: origin.id },
          query: { directory: project },
        })
      ).data?.id,
    ).toBe(origin.id);
    for (const id of second.managedSessions)
      expect(
        (
          await client.session.get({
            path: { id },
            query: { directory: project },
          })
        ).response.status,
      ).toBe(404);
    // The same shipped reviewer keeps its upstream gh command capability when not review-bound.
    // Inspect actual offered tools, without issuing any shell command or contacting GitHub.
    const standalone = (
      await client.session.create({
        body: {
          title: "Standalone reviewer permission probe",
          parentID: origin.id,
        },
        query: { directory: project },
      })
    ).data!;
    const probe = await client.session.prompt({
      path: { id: standalone.id },
      query: { directory: project },
      body: {
        agent: "reviewer",
        parts: [{ type: "text", text: "Standalone permission probe" }],
      },
    });
    expect(probe.error).toBeUndefined();
    expect(
      observed.some(
        (entry) => entry.role === "standalone" && entry.tools.includes("bash"),
      ),
    ).toBe(true);
    await client.session.delete({
      path: { id: standalone.id },
      query: { directory: project },
    });
    expect(await treeFingerprint(project)).toBe(before);
    for (const { role, tools } of observed.filter(
      (c) => c.role === "worker" || c.role === "coordinator",
    )) {
      for (const forbidden of [
        "bash",
        "read",
        "glob",
        "grep",
        "task",
        "lsp",
        "edit",
        "write",
      ])
        expect(tools).not.toContain(forbidden);
      if (role === "worker") expect(tools).not.toContain("delegate");
    }
    await expect(access(join(root, "executed"))).rejects.toThrow();
    expect(failures).toEqual([]);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    model.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 65000);
