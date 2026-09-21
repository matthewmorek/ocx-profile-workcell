import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { createOpencodeClient } from "@opencode-ai/sdk";
import { parse } from "jsonc-parser";

const exec = promisify(execFile);
type Message = { role: string; content: string | { text?: string }[] };
const text = (m: Message) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? []).map((p) => p.text ?? "").join("\n");

// Deterministic provider scripts only the agent choices. Native tools, permission checks,
// ordinary delegation, Git worktrees, app-file persistence and restart are real.
test("native review handoff, ordinary reviewer inspection, agent ledger, restart/reuse and cleanup", async () => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await realpath(
    await mkdtemp(resolve(".tmp/review-native-runtime-")),
  );
  const project = join(root, "source");
  await mkdir(project);
  // Competing external skill in the isolated HOME, never the real host catalog.
  const externalSkill = join(root, ".agents/skills/code-review");
  await mkdir(externalSkill, { recursive: true });
  await writeFile(
    join(externalSkill, "SKILL.md"),
    "---\nname: code-review\ndescription: External generic review fixture\n---\nEXTERNAL_GENERIC_REVIEW_FIXTURE\n",
  );
  const git = async (...args: string[]) =>
    (
      await exec(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        { cwd: project },
      )
    ).stdout.trim();
  await git("init", "--template=", "-b", "main");
  await writeFile(join(project, "file.txt"), "pinned content\n");
  await git("add", "file.txt");
  await git("commit", "-m", "pinned");
  const pin = await git("rev-parse", "HEAD");
  await writeFile(join(project, "file.txt"), "source branch\n");
  await git("add", "file.txt");
  await git("commit", "-m", "source");
  const head = await git("rev-parse", "HEAD");
  await writeFile(join(project, "file.txt"), "staged caller\n");
  await git("add", "file.txt");
  const index = await readFile(join(project, ".git/index"));
  await writeFile(join(project, "file.txt"), "dirty caller\n");
  const observations: { role: string; tools: string[]; results: string[] }[] =
    [];
  const errors: string[] = [];
  let calls = 0,
    delegates = 0;
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: Message[];
        tools?: { function: { name: string } }[];
      };
      const messages = body.messages,
        users = messages
          .map((m, i) => ({ m, i }))
          .filter(({ m }) => m.role === "user");
      const last = users.at(-1),
        prompt = last ? text(last.m) : "";
      const requestText =
        users
          .map(({ m }) => text(m))
          .filter((s) => s.includes("Review workspace "))
          .at(-1) ?? "";
      const id = /Review workspace ([a-f0-9]{32})/.exec(requestText)?.[1];
      const ledger = /Ledger: (.+?)\. Checkout/.exec(requestText)?.[1] ?? "";
      const checkout =
        /Checkout \(if pinned\): (.+?)\. Use/.exec(requestText)?.[1] ?? "";
      const outputs = messages
        .slice((last?.i ?? -1) + 1)
        .filter((m) => m.role === "tool")
        .map(text);
      const role = prompt.includes("Native origin:")
        ? "origin"
        : prompt.includes("Fixture worker:")
          ? "worker"
          : id
            ? "review"
            : "other";
      observations.push({
        role,
        tools: body.tools?.map((t) => t.function.name) ?? [],
        results: outputs,
      });
      let operation: { name: string; args: unknown } | undefined;
      try {
        if (prompt === "Discover external review fixture" && !outputs.length)
          operation = { name: "skill", args: { name: "code-review" } };
        if (role === "origin" && !outputs.length)
          operation = {
            name: "review_start",
            args: JSON.parse(
              prompt.slice(prompt.indexOf("Native origin:") + 14).trim(),
            ),
          };
        if (role === "worker") {
          const target = /Fixture worker: (.+)/.exec(prompt)![1].trim();
          operation = [
            { name: "read", args: { filePath: join(target, "file.txt") } },
            { name: "glob", args: { pattern: "*.txt", path: target } },
            { name: "grep", args: { pattern: "pinned content", path: target } },
            {
              name: "bash",
              args: {
                command: `git -C ${JSON.stringify(target)} rev-parse HEAD`,
                description: "Read pinned revision",
              },
            },
          ][outputs.length];
        }
        if (role === "review") {
          const resumed = requestText.includes("Resume fixture");
          const notified = prompt.includes("<task-notification>");
          const report = resumed
            ? "APPROVE. Native ledger baseline reused."
            : "APPROVE. Native pinned review complete.";
          const content = `# Review ledger\nTarget: fixture\nHead: ${pin}\nLast completed baseline: ${pin}\nFindings: none\nDispositions: none\n${resumed ? "Unchanged code reused; mutable evidence rechecked." : "Independent reviewer evidence adjudicated."}\n${report}\n`;
          if (resumed) {
            operation = [
              { name: "read", args: { filePath: ledger } },
              {
                name: "bash",
                args: {
                  command: `git -C ${JSON.stringify(checkout)} rev-parse HEAD`,
                  description: "Compare pinned baseline",
                },
              },
              { name: "write", args: { filePath: ledger, content } },
              {
                name: "review_start",
                args: { action: "return", id, request: report },
              },
            ][outputs.length];
            if (
              outputs.length >= 2 &&
              (!outputs[0].includes(pin) || !outputs[1].includes(pin))
            )
              throw new Error(`Baseline comparison failed: ${outputs}`);
          } else if (notified) {
            const all = messages.map(text).join("\n");
            const delegation =
              /Delegation started: ([a-z0-9-]+)/.exec(all)?.[1] ??
              /<task-id>([^<]+)<\/task-id>/.exec(all)?.[1];
            if (!delegation)
              throw new Error("No ordinary delegation ID in notification");
            operation = [
              { name: "delegation_read", args: { id: delegation } },
              { name: "write", args: { filePath: ledger, content } },
              {
                name: "review_start",
                args: { action: "return", id, request: report },
              },
            ][outputs.length];
          } else {
            operation = [
              { name: "skill", args: { name: "workcell-code-review" } },
              { name: "skill", args: { name: "frontend-philosophy" } },
              { name: "worktree_review", args: { id, head: pin } },
              {
                name: "write",
                args: {
                  filePath: join(project, "forbidden.txt"),
                  content: "must be denied",
                },
              },
              {
                name: "write",
                args: {
                  filePath: join(checkout, "notes/forbidden.txt"),
                  content:
                    "target edits must be denied even under a notes directory",
                },
              },
              {
                name: "write",
                args: {
                  filePath: ledger,
                  content: `# Review ledger\nTarget head: ${pin}\nCoverage pending\n`,
                },
              },
              {
                name: "delegate",
                args: {
                  agent: "reviewer",
                  prompt: `Fixture worker: ${checkout}`,
                },
              },
            ][outputs.length];
            if (operation?.name === "delegate") delegates++;
          }
        }
      } catch (error) {
        errors.push(String(error));
      }
      const delta = operation
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${++calls}`,
                type: "function",
                function: {
                  name: operation.name,
                  arguments: JSON.stringify(operation.args),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content:
              role === "worker"
                ? `INDEPENDENT_RESULT ${pin}: pinned fixture inspected with native tools; no findings.`
                : "done",
          };
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
      subagent_depth: 1,
      snapshot: false,
      plugin: [
        new URL("../files/plugins/background-agents.ts", import.meta.url).href,
      ],
      skills: {
        paths: [
          resolve("files/skills/workcell-code-review"),
          resolve("files/skills/frontend-philosophy"),
        ],
      },
      provider: {
        "review-test": {
          npm: "@ai-sdk/openai-compatible",
          name: "Fixture",
          options: {
            baseURL: `http://127.0.0.1:${model.port}/v1`,
            apiKey: "fixture",
          },
          models: {
            mock: { name: "mock", limit: { context: 100000, output: 4000 } },
          },
        },
      },
      model: "review-test/mock",
      small_model: "review-test/mock",
    }),
  );
  async function server() {
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
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "0",
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let logs = "",
      output = "";
    void (async () => {
      for await (const chunk of child.stderr)
        logs += new TextDecoder().decode(chunk);
    })();
    const reader = child.stdout.getReader();
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(logs);
      output += new TextDecoder().decode(value);
    }
    return {
      child,
      client: createOpencodeClient({
        baseUrl: output.match(/http:\/\/127\.0\.0\.1:\d+/)![0],
      }),
    };
  }
  let running = await server();
  const timeout = setTimeout(() => running.child.kill(), 60000);
  try {
    let client = running.client;
    const discovery = (
      await client.session.create({ query: { directory: project } })
    ).data!;
    const discovered = await client.session.prompt({
      path: { id: discovery.id },
      query: { directory: project },
      body: {
        agent: "build",
        parts: [{ type: "text", text: "Discover external review fixture" }],
      },
    });
    expect(discovered.error).toBeUndefined();
    const discoveryTranscript = (
      await client.session.messages({
        path: { id: discovery.id },
        query: { directory: project },
      })
    ).data!;
    expect(
      discoveryTranscript
        .flatMap((m) => m.parts)
        .some(
          (part) =>
            part.type === "tool" &&
            part.tool === "skill" &&
            part.state.status === "completed" &&
            part.state.input.name === "code-review" &&
            part.state.output.includes("EXTERNAL_GENERIC_REVIEW_FIXTURE"),
        ),
    ).toBe(true);
    const origin = (
      await client.session.create({
        body: { title: "Origin" },
        query: { directory: project },
      })
    ).data!;
    async function invoke(args: unknown) {
      const result = await client.session.prompt({
        path: { id: origin.id },
        query: { directory: project },
        body: {
          agent: "build",
          parts: [
            { type: "text", text: `Native origin: ${JSON.stringify(args)}` },
          ],
        },
      });
      if (result.error) throw new Error(JSON.stringify(result.error));
      const messages = (
        await client.session.messages({
          path: { id: origin.id },
          query: { directory: project },
        })
      ).data!;
      const part = messages
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "tool" && p.tool === "review_start")
        .at(-1)!;
      if (part.type !== "tool" || part.state.status !== "completed")
        throw new Error(JSON.stringify(part));
      return part.state.output;
    }
    const started = JSON.parse(
      await invoke({
        action: "start",
        request: `Fixture pin ${pin}; inspect independently and keep a ledger.`,
      }),
    );
    async function waitReport(fragment: string) {
      for (let i = 0; i < 400; i++) {
        const messages =
          (
            await client.session.messages({
              path: { id: origin.id },
              query: { directory: project },
            })
          ).data ?? [];
        const status =
          (await client.session.status({ query: { directory: project } }))
            .data ?? {};
        if (
          messages.some((m) =>
            m.parts.some((p) => p.type === "text" && p.text.includes(fragment)),
          ) &&
          (!status[started.session] || status[started.session].type === "idle")
        )
          return;
        await Bun.sleep(50);
      }
      const messages = (
        await client.session.messages({
          path: { id: started.session },
          query: { directory: project },
        })
      ).data;
      throw new Error(
        `Missing ${fragment}: ${errors}\n${JSON.stringify(messages)}`,
      );
    }
    await waitReport("Native pinned review complete");
    const transcript = (
      await client.session.messages({
        path: { id: started.session },
        query: { directory: project },
      })
    ).data!;
    expect(
      transcript
        .flatMap((message) => message.parts)
        .some(
          (part) =>
            part.type === "tool" &&
            part.tool === "skill" &&
            part.state.status === "completed" &&
            part.state.input.name === "workcell-code-review" &&
            part.state.output.includes("# Code Review Philosophy") &&
            part.state.output.includes("review_start") &&
            !part.state.output.includes("EXTERNAL_GENERIC_REVIEW_FIXTURE"),
        ),
    ).toBe(true);
    expect(
      transcript
        .flatMap((message) => message.parts)
        .some(
          (part) =>
            part.type === "tool" &&
            part.tool === "skill" &&
            part.state.status === "completed" &&
            part.state.input.name === "frontend-philosophy",
        ),
    ).toBe(true);
    expect(await readFile(started.ledger, "utf8")).toContain(
      `Last completed baseline: ${pin}`,
    );
    expect(await readFile(join(started.checkout, "file.txt"), "utf8")).toBe(
      "pinned content\n",
    );
    const children = (
      await client.session.children({
        path: { id: started.session },
        query: { directory: project },
      })
    ).data!;
    expect(children).toHaveLength(1);
    expect(children[0].directory).toBe(project);
    expect(
      (
        await client.session.get({
          path: { id: started.session },
          query: { directory: project },
        })
      ).data?.parentID,
    ).toBeUndefined();
    expect(
      (await readdir(started.artifacts)).filter((p) => p.endsWith(".md")),
    ).toHaveLength(1);
    const inspected = observations.find(
      (o) => o.role === "worker" && o.results.length === 4,
    )!;
    expect(inspected.results[0]).toContain("pinned content");
    expect(inspected.results[1]).toContain("file.txt");
    expect(inspected.results[2]).toContain("pinned content");
    expect(inspected.results[3]).toContain(pin);
    for (const tool of ["read", "grep", "glob", "bash"])
      expect(
        observations.some((o) => o.role === "worker" && o.tools.includes(tool)),
      ).toBe(true);
    for (const observation of observations.filter((o) => o.role === "worker")) {
      for (const tool of ["write", "edit", "task", "delegate"])
        expect(observation.tools).not.toContain(tool);
    }
    for (const observation of observations.filter((o) => o.role === "review"))
      expect(observation.tools).not.toContain("task");
    await expect(access(join(project, "forbidden.txt"))).rejects.toThrow();
    await expect(
      access(join(started.checkout, "notes/forbidden.txt")),
    ).rejects.toThrow();
    running.child.kill();
    await running.child.exited;
    running = await server();
    client = running.client;
    const resumed = JSON.parse(
      await invoke({
        action: "resume",
        id: started.id,
        request:
          "Resume fixture: compare native ledger and pin before deciding reuse.",
      }),
    );
    expect(resumed.session).toBe(started.session);
    await waitReport("Native ledger baseline reused");
    expect(delegates).toBe(1);
    expect(await readFile(started.ledger, "utf8")).toContain(
      "Unchanged code reused",
    );
    await invoke({ action: "close", id: started.id });
    await expect(access(started.root)).rejects.toThrow();
    const ordinaryArtifacts = await readdir(
      join(root, ".local/share/opencode/delegations"),
      { recursive: true },
    );
    expect(ordinaryArtifacts.filter((name) => name.endsWith(".md"))).toEqual(
      [],
    );
    expect(
      (
        await client.session.get({
          path: { id: started.session },
          query: { directory: project },
        })
      ).data?.id,
    ).toBe(started.session); // host history retained
    expect(await git("rev-parse", "HEAD")).toBe(head);
    expect(await git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(await readFile(join(project, ".git/index"))).toEqual(index);
    expect(await readFile(join(project, "file.txt"), "utf8")).toBe(
      "dirty caller\n",
    );
    expect(errors).toEqual([]);
  } finally {
    clearTimeout(timeout);
    running.child.kill();
    await running.child.exited;
    model.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 70000);
