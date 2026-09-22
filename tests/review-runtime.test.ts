import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { parse } from "jsonc-parser";

import { getProjectId } from "../files/plugins/kdco-primitives/get-project-id";
import { profileAgents } from "./profile-agents";

const exec = promisify(execFile);
type Message = { role: string; content: string | { text?: string }[] };
type ProviderRequest = {
  input: (Message & { type?: string; output?: string })[];
  tools?: { name: string }[];
  model: string;
  temperature?: number;
  reasoning?: { effort: string };
  text?: { verbosity: string };
};
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
  const requests = new Map<string, ProviderRequest[]>();
  const dcpBoundaries = new Map<string, string>();
  const dcpRaw =
    "DCP_RAW_EVIDENCE " + "Discarded investigation detail. ".repeat(100);
  const dcpSummary =
    "DCP_VERIFIED_SUMMARY: investigation resolved; retain the decision.";
  let calls = 0,
    delegates = 0;
  let heldWorkerStarted = false;
  let releaseHeldWorker!: () => void;
  const heldWorker = new Promise<void>((resolve) => {
    releaseHeldWorker = resolve;
  });
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as ProviderRequest;
      const sessionID = request.headers.get("x-session-id") ?? "auxiliary";
      requests.set(sessionID, [...(requests.get(sessionID) ?? []), body]);
      const messages = body.input.map((item) =>
          item.type === "function_call_output"
            ? { role: "tool", content: item.output ?? "" }
            : item,
        ),
        users = messages
          .map((m, i) => ({ m, i }))
          .filter(({ m }) => m.role === "user");
      const last = users.at(-1),
        prompt = last ? text(last.m) : "";
      if (prompt.includes("Fixture held worker")) {
        heldWorkerStarted = true;
        await heldWorker;
      }
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
        tools: body.tools?.map((t) => t.name) ?? [],
        results: outputs,
      });
      let operation: { name: string; args: unknown } | undefined;
      if (prompt === "Fork read fixture")
        operation = [
          { name: "plan_read", args: { reason: "Verify transferred plan" } },
          { name: "delegation_read", args: { id: "calm-blue-otter" } },
        ][outputs.length];
      const dcpSource = messages.find(
        (message) =>
          message.role === "assistant" &&
          text(message).includes("DCP_RAW_EVIDENCE"),
      );
      const boundary = dcpSource && text(dcpSource).match(/@\d+@/)?.[0];
      if (boundary) dcpBoundaries.set(sessionID, boundary);
      try {
        if (
          (prompt.includes("DCP compress fixture") ||
            prompt.includes("DCP_COMMAND_FOCUS")) &&
          !outputs.length
        ) {
          const ref = dcpBoundaries.get(sessionID);
          if (!ref)
            throw new Error(
              "DCP did not inject a compressible boundary into seeded context",
            );
          operation = {
            name: "compress",
            args: {
              topic: "Fixture investigation resolved",
              content: [{ startId: ref, endId: ref, summary: dcpSummary }],
            },
          };
        }
        if (prompt.includes("Route fixture ") && !outputs.length) {
          const route = prompt
            .slice(prompt.indexOf("Route fixture ") + "Route fixture ".length)
            .trim();
          operation =
            route === "async writer"
              ? {
                  name: "delegate",
                  args: { agent: "coder", prompt: "must not run" },
                }
              : route === "session deny"
                ? {
                    name: "delegate",
                    args: { agent: "explore", prompt: "must not run" },
                  }
                : {
                    name: "subagent",
                    args: {
                      agent: route === "direct reader" ? "explore" : "tester",
                      description: route,
                      prompt:
                        route === "foreground"
                          ? "Route fixture nested"
                          : "must not run",
                    },
                  };
        }
        if (prompt === "Discover external review fixture" && !outputs.length)
          operation = { name: "skill", args: { id: "code-review" } };
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
            { name: "read", args: { path: join(target, "file.txt") } },
            { name: "glob", args: { pattern: "*.txt", path: target } },
            { name: "grep", args: { pattern: "pinned content", path: target } },
            {
              name: "shell",
              args: {
                command: `git -C ${JSON.stringify(target)} rev-parse HEAD`,
                description: "Read pinned revision",
              },
            },
            {
              name: "write",
              args: {
                path: join(target, "reviewer-denied.txt"),
                content: "must be denied",
              },
            },
          ][outputs.length];
        }
        if (role === "review") {
          const resumed = requestText.includes("Resume fixture");
          const notified =
            prompt.includes("subagent") && prompt.includes("completed");
          const report = resumed
            ? "APPROVE. Native ledger baseline reused."
            : "APPROVE. Native pinned review complete.";
          const content = `# Review ledger\nTarget: fixture\nHead: ${pin}\nLast completed baseline: ${pin}\nFindings: none\nDispositions: none\n${resumed ? "Unchanged code reused; mutable evidence rechecked." : "Independent reviewer evidence adjudicated."}\n${report}\n`;
          if (resumed) {
            operation = [
              { name: "read", args: { path: ledger } },
              {
                name: "shell",
                args: {
                  command: `git -C ${JSON.stringify(checkout)} rev-parse HEAD`,
                  description: "Compare pinned baseline",
                },
              },
              { name: "write", args: { path: ledger, content } },
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
              { name: "write", args: { path: ledger, content } },
              {
                name: "review_start",
                args: { action: "return", id, request: report },
              },
            ][outputs.length];
          } else {
            operation = [
              { name: "skill", args: { id: "workcell-code-review" } },
              { name: "skill", args: { id: "frontend-philosophy" } },
              { name: "worktree_review", args: { id, head: pin } },
              {
                name: "write",
                args: {
                  path: join(project, "forbidden.txt"),
                  content: "must be denied",
                },
              },
              {
                name: "write",
                args: {
                  path: join(checkout, "notes/forbidden.txt"),
                  content:
                    "target edits must be denied even under a notes directory",
                },
              },
              {
                name: "write",
                args: {
                  path: ledger,
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
      if (prompt === "Cancel fixture")
        operation = outputs.length
          ? undefined
          : {
              name: "delegate",
              args: { agent: "reviewer", prompt: "Fixture held worker" },
            };
      if (prompt === "List fixture")
        operation = outputs.length
          ? undefined
          : { name: "delegation_list", args: {} };
      if (prompt === "Metadata fixture" && !outputs.length)
        operation = {
          name: "delegate",
          args: { agent: "explore", prompt: "Metadata worker result" },
        };
      if (
        prompt.includes("<subagent ") &&
        !prompt.includes('state="completed"')
      )
        operation = undefined;
      // GPT models expose the native patch leaf instead of write/edit.
      if (operation?.name === "write") {
        const { path, content } = operation.args as {
          path: string;
          content: string;
        };
        operation = {
          name: "patch",
          args: {
            patchText: `*** Begin Patch\n*** Add File: ${path}\n${content
              .trimEnd()
              .split("\n")
              .map((line) => `+${line}`)
              .join("\n")}\n*** End Patch`,
          },
        };
      }
      const serial = ++calls;
      const answer = prompt.includes("<delegation-result>")
        ? JSON.stringify({
            title: "Metadata proof",
            description: "Configured metadata model used.",
          })
        : prompt.includes("DCP seed fixture")
          ? dcpRaw
          : role === "worker"
            ? `INDEPENDENT_RESULT ${pin}: pinned fixture inspected with native tools; no findings.`
            : "done";
      const item = operation
        ? {
            type: "function_call",
            id: `fc_${serial}`,
            call_id: `call_${serial}`,
            name: operation.name,
            arguments: JSON.stringify(operation.args),
          }
        : {
            type: "message",
            id: `msg_${serial}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: answer, annotations: [] }],
          };
      const events: unknown[] = [
        {
          type: "response.created",
          response: { id: `resp_${serial}`, model: "gpt-6-astra" },
        },
        { type: "response.output_item.added", output_index: 0, item },
        ...(!operation
          ? [
              {
                type: "response.output_text.delta",
                item_id: item.id,
                delta: answer,
              },
            ]
          : []),
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `resp_${serial}`,
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const profile = parse(
    await readFile(resolve("files/profiles/workcell/opencode.jsonc"), "utf8"),
  );
  const configDirectory = join(root, "config/opencode");
  // Optional external installation; never vendor DCP or resolve the host's global profile.
  const dcpPackage = process.env.WORKCELL_DCP_PACKAGE;
  if (dcpPackage) {
    const manifest = JSON.parse(
      await readFile(join(resolve(dcpPackage), "package.json"), "utf8"),
    );
    expect([manifest.name, manifest.version]).toEqual([
      "@tarquinen/opencode-dcp",
      "3.2.0",
    ]);
  }
  await mkdir(configDirectory, { recursive: true });
  await mkdir(join(root, "tmp"));
  for (const directory of ["plugins", "agents", "commands", "skills", "tools"])
    await cp(resolve("files", directory), join(configDirectory, directory), {
      recursive: true,
    });
  await symlink(
    resolve("node_modules"),
    join(configDirectory, "node_modules"),
    "dir",
  );
  // Invoke the production pre-launch helper inside the managed host: its public
  // lifecycle client must authenticate the same PID, and its HOME must be isolated.
  // Only the external terminal launch is omitted; fork/move/copy remain real.
  await writeFile(
    join(configDirectory, "plugins/fork-fixture.ts"),
    `
import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import WorktreePlugin from "./worktree";
import { currentHost } from "./kdco-primitives/current-host";
import { getProjectId } from "./kdco-primitives/get-project-id";
export default Plugin.define({ id: "workcell-fork-fixture", async setup(ctx) {
  const registration = await ctx.rpc.register({
    id: "workcell-fork-fixture",
    methods: { fork: {
      input: z.object({ sessionID: z.string(), directory: z.string() }),
      output: z.object({ forkedSession: z.object({ id: z.string() }), rootSessionId: z.string(), planCopied: z.boolean(), delegationsCopied: z.boolean() }),
    } }, events: {},
  }, { fork: async ({ sessionID, directory }) => {
    const client = await currentHost(ctx);
    const projectID = await getProjectId(directory, client);
    return WorktreePlugin.testInternals.forkWithContext(client, sessionID, projectID, async (id) => {
      const parent = await client.session.get({ sessionID: id });
      if (parent.parentID) throw new Error("Fixture requires an actual root session");
      return parent.id;
    }, directory);
  } });
  return () => registration.dispose();
} });
`,
  );
  await writeFile(
    join(configDirectory, "opencode.json"),
    JSON.stringify({
      $schema: profile.$schema,
      agents: profile.agents,
      permissions: profile.permissions,
      experimental: profile.experimental,
      plugins: dcpPackage ? [resolve(dcpPackage)] : [],
      skills: {
        paths: [
          resolve("files/skills/workcell-code-review"),
          resolve("files/skills/frontend-philosophy"),
        ],
      },
      providers: {
        openai: {
          settings: {
            baseURL: `http://127.0.0.1:${model.port}/v1`,
            transport: "http",
          },
        },
      },
      model: profile.model,
    }),
  );
  async function server() {
    const child = Bun.spawn(
      [
        resolve("node_modules/.bin/opencode2"),
        "serve",
        "--service",
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
          TMPDIR: join(root, "tmp"),
          OPENCODE_CONFIG_DIR: configDirectory,
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENAI_API_KEY: "fixture-only",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "0",
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
          KDCO_BACKGROUND_METADATA: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let logs = "";
    void (async () => {
      for await (const chunk of child.stderr)
        logs += new TextDecoder().decode(chunk);
    })();
    void new Response(child.stdout).text();
    for (let i = 0; i < 100; i++) {
      const endpoint = await Service.discover({
        file: join(root, "state/opencode/service.json"),
        version: "2.0.12",
      });
      if (endpoint)
        return {
          child,
          client: OpenCode.make({
            baseUrl: endpoint.url,
            headers: {
              ...Service.headers(endpoint),
              "x-opencode-directory": project,
            },
          }),
        };
      if (child.exitCode !== null) break;
      await Bun.sleep(100);
    }
    child.kill();
    await child.exited;
    throw new Error(`Managed fixture failed to start: ${logs}`);
  }
  let running = await server();
  const timeout = setTimeout(() => running.child.kill(), 60000);
  try {
    let client = running.client;
    expect(Object.keys(profile.agents)).toEqual(Object.keys(profileAgents));
    for (const [
      name,
      [mode, modelID, temperature, reasoning, verbosity],
    ] of Object.entries(profileAgents)) {
      // Direct HTTP creation selects its model explicitly (unlike native subagent).
      const [providerID, id] = profile.agents[name].model.split("/");
      const session = await client.session.create({
        agent: name,
        model: { providerID, id },
        title: `Options ${name}`,
        location: { directory: project },
      });
      await client.session.prompt({
        sessionID: session.id,
        text: `Options fixture ${name}`,
      });
      await client.session.wait({ sessionID: session.id });
      const loadedAgents = await client.agent.list({
        location: { directory: project },
      });
      const agent = loadedAgents.data.find((entry) => entry.id === name);
      expect(agent, `${name}: ${JSON.stringify(loadedAgents)}`).toBeDefined();
      expect(agent?.mode, name).toBe(mode);
      expect(agent?.model, name).toEqual({ providerID: "openai", id: modelID });
      if (["plan", "build", "debug"].includes(name))
        expect(agent?.system, name).toBe(profile.agents[name].system);
      if (!["plan", "build", "debug"].includes(name)) {
        try {
          const markdown = await readFile(
            resolve(`files/agents/${name}.md`),
            "utf8",
          );
          expect(agent?.system, name).toBe(
            markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim(),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const outbound = requests
        .get(session.id)
        ?.find((body) =>
          JSON.stringify(body.input).includes(`Options fixture ${name}`),
        );
      expect(outbound, name).toBeDefined();
      expect(outbound?.model, name).toBe(modelID);
      expect(outbound?.temperature, name).toBe(temperature);
      expect(outbound?.reasoning?.effort, name).toBe(reasoning);
      expect(outbound?.text?.verbosity, name).toBe(verbosity);
      expect(
        (outbound?.tools ?? []).some((tool) => tool.name === "lsp"),
        name,
      ).toBe(false);
      if (name === "debug") {
        const context = JSON.stringify(outbound);
        expect(context).toContain("<date-awareness>");
        for (const marker of [
          "<delegation-system>",
          "<workspace-routing",
          "<delegation-mandate",
          "## Plan Mode Active",
          "## You Are an ORCHESTRATOR",
        ])
          expect(context).not.toContain(marker);
      }
    }
    // Normalize only transcript presentation; lifecycle and permissions remain real.
    async function transcriptFor(sessionID: string) {
      const messages = await client.message.list({ sessionID });
      return [...messages.data].reverse().map((message) => ({
        parts:
          message.type === "assistant"
            ? message.content.map((part) =>
                part.type === "tool"
                  ? {
                      ...part,
                      tool: part.name,
                      state: {
                        ...part.state,
                        output:
                          part.state.status === "completed"
                            ? part.state.content
                                .filter((item) => item.type === "text")
                                .map((item) => item.text)
                                .join("\n")
                            : "",
                      },
                    }
                  : part,
              )
            : message.type === "synthetic" || message.type === "user"
              ? [{ type: "text" as const, text: message.text }]
              : [],
      }));
    }
    // One persisted snapshot transfer through the real fork/location lifecycle.
    const forkParent = await client.session.create({
      agent: "build",
      location: { directory: project },
      title: "Fork context source",
    });
    await client.session.prompt({
      sessionID: forkParent.id,
      text: "FORK_HISTORY_SENTINEL",
    });
    await client.session.wait({ sessionID: forkParent.id });
    const parentBefore = await client.session.get({ sessionID: forkParent.id });
    const historyBefore = await client.message.list({
      sessionID: forkParent.id,
    });
    const projectID = await getProjectId(project);
    const stateRoot = join(root, ".local/share/opencode");
    const workspace = (id: string) =>
      join(stateRoot, "workspace-v2", projectID, id);
    const artifacts = (id: string) =>
      join(stateRoot, "delegations-v2", projectID, id);
    const plan =
      "---\nstatus: in-progress\nphase: 1\nupdated: 2026-09-21\n---\n\n## Goal\nPreserve fork context.\n\n## Phase 1: Transfer [IN PROGRESS]\n- [ ] 1.1 Keep source intact ← CURRENT\n";
    const completed =
      "# Completed evidence\n\n**ID:** calm-blue-otter\n**Agent:** explore\n**Status:** complete\n\nFORK_COMPLETED_EVIDENCE\n";
    const active =
      "# Active evidence\n\n**ID:** busy-green-fox\n**Agent:** explore\n**Status:** running\n\nRunning work belongs to the original session.\n";
    await mkdir(workspace(forkParent.id), { recursive: true });
    await mkdir(artifacts(forkParent.id), { recursive: true });
    await writeFile(join(workspace(forkParent.id), "plan.md"), plan);
    await writeFile(
      join(artifacts(forkParent.id), "calm-blue-otter.md"),
      completed,
    );
    await writeFile(
      join(artifacts(forkParent.id), "busy-green-fox.md"),
      active,
    );
    const checkout = join(root, "fork-checkout");
    await git("worktree", "add", "--detach", checkout, head);
    let forkID: string | undefined;
    try {
      const response = await client.rpc.call({
        rpcID: "workcell-fork-fixture",
        method: "fork",
        location: { directory: project },
        input: { sessionID: forkParent.id, directory: checkout },
      });
      const result = response.output as {
        forkedSession: { id: string };
        rootSessionId: string;
        planCopied: boolean;
        delegationsCopied: boolean;
      };
      forkID = result.forkedSession.id;
      expect(forkID).not.toBe(forkParent.id);
      expect(result).toMatchObject({
        rootSessionId: forkParent.id,
        planCopied: true,
        delegationsCopied: true,
      });
      const fork = await client.session.get({ sessionID: forkID });
      expect(fork.location.directory).toBe(checkout);
      expect(fork.parentID).toBeUndefined();
      const forkHistory = await transcriptFor(forkID);
      expect(
        forkHistory
          .flatMap((message) => message.parts)
          .some(
            (part) =>
              part.type === "text" && part.text === "FORK_HISTORY_SENTINEL",
          ),
      ).toBe(true);
      expect(
        forkHistory
          .flatMap((message) => message.parts)
          .some((part) => part.type === "text" && part.text === "done"),
      ).toBe(true);
      expect(await readFile(join(workspace(forkID), "plan.md"), "utf8")).toBe(
        plan,
      );
      expect(await readdir(artifacts(forkID))).toEqual(["calm-blue-otter.md"]);
      expect(
        await readFile(join(artifacts(forkID), "calm-blue-otter.md"), "utf8"),
      ).toBe(completed);
      await client.session.prompt({
        sessionID: forkID,
        text: "Fork read fixture",
      });
      await client.session.wait({ sessionID: forkID });
      const reads = (await transcriptFor(forkID))
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool");
      expect(
        reads.find((part) => part.type === "tool" && part.tool === "plan_read")
          ?.state,
      ).toMatchObject({ status: "completed", output: plan });
      expect(
        reads.find(
          (part) => part.type === "tool" && part.tool === "delegation_read",
        )?.state,
      ).toMatchObject({ status: "completed", output: completed });
      expect(await client.session.get({ sessionID: forkParent.id })).toEqual(
        parentBefore,
      );
      expect(await client.message.list({ sessionID: forkParent.id })).toEqual(
        historyBefore,
      );
      expect(
        await readFile(join(workspace(forkParent.id), "plan.md"), "utf8"),
      ).toBe(plan);
      expect(await readdir(artifacts(forkParent.id))).toHaveLength(2);
      expect(
        await readFile(
          join(artifacts(forkParent.id), "calm-blue-otter.md"),
          "utf8",
        ),
      ).toBe(completed);
      expect(
        await readFile(
          join(artifacts(forkParent.id), "busy-green-fox.md"),
          "utf8",
        ),
      ).toBe(active);
    } finally {
      for (const id of [forkID, forkParent.id])
        if (id) {
          await client.session.remove({ sessionID: id });
          await rm(workspace(id), { recursive: true, force: true });
          await rm(artifacts(id), { recursive: true, force: true });
        }
      await git("worktree", "remove", checkout);
    }
    const commands = await client.command.list({
      location: { directory: project },
    });
    expect(commands.data.some((command) => command.name === "review")).toBe(
      true,
    );
    if (dcpPackage) {
      expect(
        commands.data.filter((command) => command.name === "dcp-compress"),
      ).toHaveLength(1);
      const session = await client.session.create({
        agent: "build",
        location: { directory: project },
        permissions: [{ action: "compress", resource: "*", effect: "allow" }],
      });
      await client.session.prompt({
        sessionID: session.id,
        text: "DCP fixture registration",
      });
      await client.session.wait({ sessionID: session.id });
      const tools = requests.get(session.id)?.at(-1)?.tools ?? [];
      expect(
        tools.filter((tool: { name: string }) => tool.name === "compress"),
      ).toHaveLength(1);
      const prompt = async (value: string) => {
        await client.session.prompt({ sessionID: session.id, text: value });
        await client.session.wait({ sessionID: session.id });
      };
      const context = () =>
        JSON.stringify(requests.get(session.id)?.at(-1)?.input);
      const compression = async () =>
        (await transcriptFor(session.id))
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool" && part.tool === "compress")
          .at(-1);
      await prompt("DCP seed fixture");
      await prompt("DCP compress fixture");
      let result = await compression();
      expect(
        result?.type === "tool" && result.state.status,
        JSON.stringify(result),
      ).toBe("completed");
      expect(context()).toContain(dcpSummary);
      expect(context()).not.toContain("DCP_RAW_EVIDENCE");

      // /dcp-compress dispatches a model prompt; it is not itself the compression tool.
      await prompt("DCP seed fixture command");
      await client.session.command({
        sessionID: session.id,
        name: "dcp-compress",
        text: "DCP_COMMAND_FOCUS",
      });
      await client.session.wait({ sessionID: session.id });
      result = await compression();
      expect(
        result?.type === "tool" && result.state.status,
        JSON.stringify(result),
      ).toBe("completed");
      expect(
        (await transcriptFor(session.id))
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool" && part.tool === "compress"),
      ).toHaveLength(2);
      expect(context()).toContain(dcpSummary);
      expect(context()).not.toContain("DCP_RAW_EVIDENCE");

      await prompt("DCP seed fixture protected");
      await prompt("DCP inspect fixture");
      // Revert the fixture-only opt-in to the shipped default-deny policy.
      await client.session.update({ sessionID: session.id, permissions: [] });
      await prompt("DCP compress fixture denied");
      result = await compression();
      expect(result?.type === "tool" && result.state.status).toBe("error");
      expect(context()).toContain("DCP_RAW_EVIDENCE");
      await expect(
        client.session.command({
          sessionID: session.id,
          name: "dcp-compress",
          text: "DCP_COMMAND_FOCUS",
        }),
      ).rejects.toThrow(/denied/);

      // An explicit ask must fail closed, not be converted to allow on V2.
      await client.session.update({
        sessionID: session.id,
        permissions: [{ action: "compress", resource: "*", effect: "ask" }],
      });
      await prompt("DCP compress fixture ask");
      result = await compression();
      expect(
        result?.type === "tool" &&
          result.state.status === "error" &&
          result.state.error.message,
      ).toContain("'ask' is not supported");
      await expect(
        client.session.command({
          sessionID: session.id,
          name: "dcp-compress",
          text: "DCP_COMMAND_FOCUS",
        }),
      ).rejects.toThrow(/'ask' is not supported/);
      await prompt("DCP inspect fixture unchanged");
      expect(context()).toContain("DCP_RAW_EVIDENCE");
    }
    for (const route of [
      "async writer",
      "direct reader",
      "session deny",
      "foreground",
    ]) {
      const parent = await client.session.create({
        agent: "build",
        title: route,
        location: { directory: project },
      });
      if (route === "session deny")
        await client.session.update({
          sessionID: parent.id,
          permissions: [
            { action: "subagent", resource: "explore", effect: "deny" },
          ],
        });
      await client.session.prompt({
        sessionID: parent.id,
        text: `Route fixture ${route}`,
      });
      await client.session.wait({ sessionID: parent.id });
      const parts = (await transcriptFor(parent.id)).flatMap(
        (message) => message.parts,
      );
      const tool = parts.find((part) => part.type === "tool");
      expect(tool?.type).toBe("tool");
      const children = (await client.session.list()).data.filter(
        (session) => session.parentID === parent.id,
      );
      if (route === "foreground") {
        expect(children).toHaveLength(1);
        const nested = (await transcriptFor(children[0].id))
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool");
        expect(nested?.type === "tool" && nested.state.status).toBe("error");
        expect(
          (await client.session.list()).data.filter(
            (session) => session.parentID === children[0].id,
          ),
        ).toEqual([]);
        expect(requests.get(children[0].id)?.[0].model).toBe("gpt-5.6-luna");
        // Exercise native ancestry independently of the shipped child's deny rule.
        await client.session.update({
          sessionID: children[0].id,
          permissions: [
            { action: "subagent", resource: "tester", effect: "allow" },
          ],
        });
        await client.session.prompt({
          sessionID: children[0].id,
          text: "Route fixture depth",
        });
        await client.session.wait({ sessionID: children[0].id });
        const depth = (await transcriptFor(children[0].id))
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool")
          .at(-1);
        expect(
          depth?.type === "tool" &&
            depth.state.status === "error" &&
            depth.state.error.message,
        ).toContain("depth limit");
        expect(
          (await client.session.list()).data.filter(
            (session) => session.parentID === children[0].id,
          ),
        ).toEqual([]);
      } else {
        if (route === "direct reader")
          expect(tool?.type === "tool" && tool.state.status).toBe("error");
        else
          expect(tool?.type === "tool" && tool.state.output).toContain(
            route === "async writer" ? "task-routed" : "Subagent denied",
          );
        expect(children).toEqual([]);
      }
    }
    // Exercise the production enrichment path: do not create or set the model
    // of its temporary metadata session from the test.
    const metadataOrigin = await client.session.create({
      agent: "build",
      title: "Metadata enrichment",
      location: { directory: project },
    });
    await client.session.prompt({
      sessionID: metadataOrigin.id,
      text: "Metadata fixture",
    });
    await client.session.wait({ sessionID: metadataOrigin.id });
    const metadataLaunch = (await transcriptFor(metadataOrigin.id))
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.tool === "delegate");
    expect(metadataLaunch?.type === "tool" && metadataLaunch.state.status).toBe(
      "completed",
    );
    const metadataDelegation =
      metadataLaunch?.type === "tool"
        ? /Delegation started: ([a-z]+-[a-z]+-[a-z]+)/.exec(
            metadataLaunch.state.output,
          )?.[1]
        : undefined;
    expect(metadataDelegation).toBeDefined();
    const ordinaryDirectory = join(
      root,
      ".local/share/opencode/delegations-v2",
    );
    let metadataArtifact: string | undefined;
    let enriched = "";
    for (let i = 0; i < 100; i++) {
      metadataArtifact = (
        await readdir(ordinaryDirectory, { recursive: true })
      ).find((path) =>
        path.endsWith(`${metadataOrigin.id}/${metadataDelegation}.md`),
      );
      if (metadataArtifact)
        enriched = await readFile(
          join(ordinaryDirectory, metadataArtifact),
          "utf8",
        );
      if (enriched.startsWith("# Metadata proof\n")) break;
      await Bun.sleep(25);
    }
    expect(enriched).toContain("# Metadata proof\n");
    const metadataRequests = [...requests.entries()].flatMap(
      ([sessionID, bodies]) =>
        bodies
          .filter((body) =>
            body.input.some(
              (item) =>
                item.role === "user" &&
                text(item).includes("<delegation-result>"),
            ),
          )
          .map((body) => ({ sessionID, body })),
    );
    expect(metadataRequests).toHaveLength(1);
    expect(metadataRequests[0].body.model).toBe("gpt-5.6-luna");
    await expect(
      client.session.get({ sessionID: metadataRequests[0].sessionID }),
    ).rejects.toBeDefined();

    const discovery = await client.session.create({
      agent: "build",
      location: { directory: project },
    });
    await client.session.prompt({
      sessionID: discovery.id,
      text: "Discover external review fixture",
    });
    await client.session.wait({ sessionID: discovery.id });
    const discoveryTranscript = await transcriptFor(discovery.id);
    expect(
      discoveryTranscript
        .flatMap((m) => m.parts)
        .some(
          (part) =>
            part.type === "tool" &&
            part.tool === "skill" &&
            part.state.status === "completed" &&
            part.state.input.id === "code-review" &&
            part.state.output.includes("EXTERNAL_GENERIC_REVIEW_FIXTURE"),
        ),
      JSON.stringify({ discoveryTranscript, observations, errors }),
    ).toBe(true);
    const origin = await client.session.create({
      title: "Origin",
      agent: "build",
      location: { directory: project },
    });
    async function invoke(args: unknown) {
      await client.session.prompt({
        sessionID: origin.id,
        text: `Native origin: ${JSON.stringify(args)}`,
      });
      await client.session.wait({ sessionID: origin.id });
      const messages = await transcriptFor(origin.id);
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
        const messages = await transcriptFor(origin.id);
        const status = await client.session.active();
        const inbox = await client.session.inbox.list({ sessionID: origin.id });
        if (
          (messages.some((m) =>
            m.parts.some((p) => p.type === "text" && p.text.includes(fragment)),
          ) ||
            inbox.some(
              (item) =>
                item.type === "synthetic" &&
                item.payload.text.includes(fragment),
            )) &&
          !status[started.session]
        )
          return;
        await Bun.sleep(50);
      }
      const messages = await transcriptFor(started.session);
      throw new Error(
        `Missing ${fragment}: ${errors}\n${JSON.stringify(
          messages
            .flatMap((m) => m.parts)
            .map((part) =>
              part.type === "tool"
                ? {
                    tool: part.tool,
                    state: part.state.status,
                    output: part.state.output.slice(0, 400),
                    error: "error" in part.state ? part.state.error : undefined,
                  }
                : part.type === "text"
                  ? { text: part.text.slice(0, 800) }
                  : part,
            ),
          null,
          2,
        )}`,
      );
    }
    await waitReport("Native pinned review complete");
    await client.session.prompt({
      sessionID: started.session,
      text: "List fixture",
    });
    await client.session.wait({ sessionID: started.session });
    const transcript = await transcriptFor(started.session);
    const listed = transcript
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.tool === "delegation_list");
    expect(listed?.type === "tool" && listed.state.output).toContain(
      "[complete]",
    );
    const notices = (
      await client.message.list({
        sessionID: started.session,
        type: "synthetic",
      })
    ).data;
    expect(
      notices.filter(
        (message) =>
          message.type === "synthetic" && message.text.startsWith("<subagent "),
      ),
    ).toHaveLength(1);
    expect(
      notices.some(
        (message) =>
          message.type === "synthetic" &&
          /task-notification|all.*delegations.*complete/i.test(message.text),
      ),
    ).toBe(false);
    expect(
      transcript
        .flatMap((message) => message.parts)
        .some(
          (part) =>
            part.type === "tool" &&
            part.tool === "skill" &&
            part.state.status === "completed" &&
            part.state.input.id === "workcell-code-review" &&
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
            part.state.input.id === "frontend-philosophy",
        ),
    ).toBe(true);
    expect(await readFile(started.ledger, "utf8")).toContain(
      `Last completed baseline: ${pin}`,
    );
    expect(await readFile(join(started.checkout, "file.txt"), "utf8")).toBe(
      "pinned content\n",
    );
    const children = (await client.session.list()).data.filter(
      (session) => session.parentID === started.session,
    );
    expect(children).toHaveLength(1);
    expect(children[0].location.directory).toBe(project);
    expect(
      (
        await client.session.get({
          sessionID: started.session,
        })
      ).parentID,
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
    const workerDenied = observations.find(
      (observation) =>
        observation.role === "worker" && observation.results.length === 5,
    );
    expect(workerDenied?.results[4]).toMatch(
      /No tool named|not available|Permission denied/,
    );
    await expect(
      access(join(started.checkout, "reviewer-denied.txt")),
    ).rejects.toThrow();
    for (const tool of ["read", "grep", "glob", "shell"])
      expect(
        observations.some((o) => o.role === "worker" && o.tools.includes(tool)),
      ).toBe(true);
    for (const observation of observations.filter((o) => o.role === "worker")) {
      for (const tool of ["patch", "write", "edit", "subagent", "delegate"])
        expect(observation.tools).not.toContain(tool);
    }
    // The native executor must be present for delegate reuse; direct async routes
    // are denied by Workcell's execution hook rather than tool visibility.
    await expect(access(join(project, "forbidden.txt"))).rejects.toThrow();
    await expect(
      access(join(started.checkout, "notes/forbidden.txt")),
    ).rejects.toThrow();
    running.child.kill();
    await running.child.exited;
    running = await server();
    client = running.client;
    // A retained coordinator may have been switched by the user. Resume must
    // restore review before its request can execute; returning must leave the
    // origin's independently selected mode alone.
    await client.session.switchAgent({
      sessionID: started.session,
      agent: "build",
    });
    await client.session.switchAgent({ sessionID: origin.id, agent: "debug" });
    const resumed = JSON.parse(
      await invoke({
        action: "resume",
        id: started.id,
        request:
          "Resume fixture: compare native ledger and pin before deciding reuse.",
      }),
    );
    expect(resumed.session).toBe(started.session);
    expect(
      (await client.session.get({ sessionID: started.session })).agent,
    ).toBe("review");
    await waitReport("Native ledger baseline reused");
    expect((await client.session.get({ sessionID: origin.id })).agent).toBe(
      "debug",
    );
    expect(delegates).toBe(1);
    expect(await readFile(started.ledger, "utf8")).toContain(
      "Unchanged code reused",
    );
    await client.session.prompt({
      sessionID: started.session,
      text: "Cancel fixture",
    });
    for (let i = 0; i < 100 && !heldWorkerStarted; i++) await Bun.sleep(25);
    expect(heldWorkerStarted).toBe(true);
    const cancelling = (await client.session.list()).data.find(
      (session) =>
        session.parentID === started.session && session.id !== children[0].id,
    );
    expect(cancelling).toBeDefined();
    await invoke({ action: "close", id: started.id });
    expect(
      (await client.session.get({ sessionID: cancelling!.id })).outcome,
    ).toBe("interrupted");
    const terminalNotices = (
      await client.message.list({
        sessionID: started.session,
        type: "synthetic",
      })
    ).data.filter(
      (message) =>
        message.type === "synthetic" &&
        message.metadata?.childID === cancelling!.id,
    );
    expect(terminalNotices).toHaveLength(1);
    await expect(access(started.root)).rejects.toThrow();
    const ordinaryArtifacts = await readdir(
      join(root, ".local/share/opencode/delegations-v2"),
      { recursive: true },
    );
    expect(ordinaryArtifacts.filter((name) => name.endsWith(".md"))).toEqual([
      metadataArtifact!,
    ]);
    expect(
      (
        await client.session.get({
          sessionID: started.session,
        })
      ).id,
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
    releaseHeldWorker();
    await rm(root, { recursive: true, force: true });
  }
}, 70000);
