import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { OpenCodeClient } from "@opencode/client";
import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext } from "@opencode/plugin/promise/tool";

import BackgroundAgentsPlugin from "../files/plugins/background-agents";
import { ReviewWorkspaces } from "../files/plugins/worktree/review";

const exec = promisify(execFile);

function toolContext(
  sessionID: string,
  agent = "review",
  messageID = "message",
): ToolContext {
  return {
    sessionID,
    agent,
    messageID,
    id: "fixture-call",
    signal: new AbortController().signal,
    progress: async () => {},
  } as unknown as ToolContext;
}

test.each(["timeout", "cancel"] as const)(
  "%s interruption does not settle a delayed native wait or release its workspace",
  async (finalization) => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closing: Promise<string> | undefined;
    try {
      const resources = await ReviewWorkspaces.open(
        f.project,
        join(f.root, "storage"),
      );
      const owner = await resources.create("origin");
      owner.sessions.push("coordinator");
      await resources.save(owner);
      let requested = false,
        aborted = false,
        closed = false,
        inspected = "";
      const client = {
        agent: {
          list: async () => ({
            data: [{ id: "reviewer", mode: "subagent" }],
          }),
        },
        session: {
          get: async ({ sessionID }: { sessionID: string }) => ({
            id: sessionID,
            location: { directory: f.project },
            outcome: "interrupted",
            ...(sessionID === "worker" ? { parentID: "coordinator" } : {}),
          }),
          wait: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID !== "worker") return;
            requested = true;
            await gate; // Native wait remains in flight despite an interrupt acknowledgment.
            inspected = await readFile(
              join(resources.paths(owner.id).checkout, "file.txt"),
              "utf8",
            );
          },
          interrupt: async () => {
            aborted = true;
          },
          remove: async () => {},
          active: async () => ({}),
        },
        message: {
          list: async ({ type }: { type?: string }) => ({
            data:
              type === "synthetic"
                ? [
                    {
                      type: "synthetic",
                      metadata: { source: "subagent", childID: "worker" },
                    },
                  ]
                : [
                    {
                      type: "assistant",
                      content: [{ type: "text", text: inspected }],
                    },
                  ],
          }),
        },
      };
      const base = join(f.root, "ordinary");
      await mkdir(base);
      const Manager = BackgroundAgentsPlugin.testInternals.DelegationManager;
      const manager = new Manager(
        client as unknown as OpenCodeClient,
        base,
        {
          async debug() {},
          async info() {},
          async warn() {},
          async error() {},
        },
        {
          reviewWorkspaces: resources,
          storage: {
            get: async () => ({ id: owner.id }),
            set: async () => {},
          } as unknown as Plugin.Context["storage"],
          idGenerator: () => "delayed-blue-otter",
          nativeSubagent: {
            input: { make: (value: unknown) => value },
            execute: async () => ({
              content: "running",
              output: { sessionID: "worker", status: "running" },
            }),
          } as unknown as Info,
          maxRunTimeMs: finalization === "timeout" ? 1 : 60000,
          readPollIntervalMs: 1,
          terminalWaitGraceMs: 1,
        },
      );
      await manager.pinReview({ id: owner.id, head: f.pinned, discard: false });
      const delegation = await manager.delegate({
        parentSessionID: "coordinator",
        parentMessageID: "message",
        parentAgent: "review",
        prompt: "inspect",
        agent: "reviewer",
        context: toolContext("coordinator"),
      });
      for (let i = 0; i < 100 && !requested; i++) await Bun.sleep(10);
      expect(requested).toBe(true);
      if (finalization === "timeout") {
        for (let i = 0; i < 650 && !aborted; i++) await Bun.sleep(10);
        expect(aborted).toBe(true);
      }
      expect(delegation.promptPending).toBe(true);
      await expect(
        manager.pinReview({ id: owner.id, head: f.head, discard: false }),
      ).rejects.toThrow("Wait for review workers");
      closing = manager
        .review(
          {
            action: "close",
            id: owner.id,
            request: "",
            separate: false,
            discard: false,
          },
          toolContext("origin", "build", "close"),
        )
        .then((result) => {
          closed = true;
          return result;
        });
      for (
        let i = 0;
        i < 300 && (!aborted || delegation.status !== "cancelled");
        i++
      )
        await Bun.sleep(10);
      expect(aborted).toBe(true);
      expect(delegation.status).toBe("cancelled");
      expect(delegation.promptPending).toBe(true);
      await Bun.sleep(150);
      expect(closed).toBe(false);
      expect(
        await readFile(
          join(resources.paths(owner.id).checkout, "file.txt"),
          "utf8",
        ),
      ).toBe("pinned content\n");
      release();
      await closing;
      expect(inspected).toBe("pinned content\n");
      expect(delegation.promptPending).toBe(false);
      await expect(
        readFile(join(resources.paths(owner.id).root, "owner.json")),
      ).rejects.toThrow();
    } finally {
      release();
      await closing?.catch(() => undefined);
      await rm(f.root, { recursive: true, force: true });
    }
  },
  15000,
);
async function fixture(pinnedContent = "pinned content\n") {
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await realpath(await mkdtemp(resolve(".tmp/native-review-")));
  const project = join(root, "source");
  await mkdir(project);
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
  await writeFile(join(project, "file.txt"), pinnedContent);
  await writeFile(join(project, ".gitattributes"), "file.txt filter=fixture\n");
  await git("add", "file.txt", ".gitattributes");
  await git("commit", "-m", "pinned");
  const pinned = await git("rev-parse", "HEAD");
  await writeFile(join(project, "file.txt"), "source branch content\n");
  await git("add", "file.txt");
  await git("commit", "-m", "source");
  const head = await git("rev-parse", "HEAD");
  await writeFile(join(project, "file.txt"), "staged caller content\n");
  await git("add", "file.txt");
  const index = await readFile(join(project, ".git/index"));
  await writeFile(join(project, "file.txt"), "dirty caller content\n");
  await writeFile(join(project, "untracked.txt"), "untracked caller\n");
  return { root, project, git, pinned, head, index };
}

test.each(["process", "clean-smudge"] as const)(
  "raw review refresh and close consistently disable configured host %s filters",
  async (driver) => {
    const raw = "pointer:pinned content\n";
    const f = await fixture(raw);
    const previousLocks = process.env.GIT_OPTIONAL_LOCKS;
    // Force real content comparisons, not a timing-dependent cached-stat fast path. Status must
    // not refresh the zeroed index stat data before worktree remove runs its internal status.
    process.env.GIT_OPTIONAL_LOCKS = "0";
    try {
      const workspaces = await ReviewWorkspaces.open(
        f.project,
        join(f.root, "storage"),
      );
      const owner = await workspaces.create("origin");
      const paths = workspaces.paths(owner.id);
      const marker = join(f.root, "filter-invocations");
      const script = join(f.root, "host-filter.sh");
      await writeFile(
        script,
        `#!/bin/sh\nprintf '%s\\n' "$1" >> '${marker}'\ncase "$1" in\n  clean) sed 's/^/pointer:/' ;;\n  smudge) sed 's/^pointer://' ;;\n  process) exit 42 ;;\nesac\n`,
      );
      // The executable is trusted host configuration, not a command from the reviewed tree.
      const command = `sh '${script}'`;
      await f.git("config", "filter.fixture.required", "true");
      if (driver === "process")
        await f.git("config", "filter.fixture.process", `${command} process`);
      else {
        await f.git("config", "filter.fixture.clean", `${command} clean`);
        await f.git("config", "filter.fixture.smudge", `${command} smudge`);
        const control = join(f.root, "normal-checkout");
        await f.git("worktree", "add", "--detach", control, f.pinned);
        expect(await readFile(join(control, "file.txt"), "utf8")).toBe(
          "pinned content\n",
        );
        expect(await f.git("-C", control, "status", "--porcelain=v1")).toBe("");
        await f.git("worktree", "remove", control);
        await rm(marker, { force: true });
      }
      await workspaces.use(owner.id, (o) => workspaces.pin(o, f.pinned));
      expect(await readFile(join(paths.checkout, "file.txt"), "utf8")).toBe(
        raw,
      );
      await expect(readFile(marker)).rejects.toThrow();
      const blob = await f.git("rev-parse", `${f.pinned}:file.txt`);
      const invalidateStat = () =>
        f.git(
          "-C",
          paths.checkout,
          "update-index",
          "--cacheinfo",
          `100644,${blob},file.txt`,
        );
      await invalidateStat();
      const argv = [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "submodule.recurse=false",
        "worktree",
        "remove",
        paths.checkout,
      ];
      const diagnostic = await exec("git", argv, { cwd: f.project }).then(
        () => ({ code: 0, stderr: "" }),
        (error: { code: number; stderr: string }) => ({
          code: error.code,
          stderr: error.stderr,
        }),
      );
      expect(diagnostic.code).toBe(128);
      expect(diagnostic.stderr).toContain(
        driver === "process"
          ? "failed to run 'git status'"
          : "contains modified or untracked files",
      );
      expect(await readFile(marker, "utf8")).toContain(
        driver === "process" ? "process" : "clean",
      );
      await rm(marker);
      await invalidateStat();
      // Same raw checkout, same host configuration: the helper must not re-enable transforms
      // on refresh or close, and must not hide the mismatch by unconditionally forcing removal.
      await workspaces.use(owner.id, (o) => workspaces.pin(o, f.pinned));
      await expect(readFile(marker)).rejects.toThrow();
      await writeFile(
        join(paths.checkout, "file.txt"),
        "real unexpected edit\n",
      );
      await expect(
        workspaces.use(owner.id, (o) => workspaces.pin(o, f.pinned)),
      ).rejects.toThrow("explicit discard");
      await expect(
        workspaces.use(owner.id, (o) => workspaces.remove(o, false)),
      ).rejects.toThrow("explicit discard");
      expect(await readFile(join(paths.checkout, "file.txt"), "utf8")).toBe(
        "real unexpected edit\n",
      );
      await writeFile(join(paths.checkout, "file.txt"), raw);
      await invalidateStat();
      await workspaces.use(owner.id, (o) => workspaces.remove(o, false));
      await expect(readFile(join(paths.root, "owner.json"))).rejects.toThrow();
      await expect(readFile(marker)).rejects.toThrow();
      expect(await f.git("config", "--get", "filter.fixture.required")).toBe(
        "true",
      );
      expect(await f.git("rev-parse", "HEAD")).toBe(f.head);
      expect(await f.git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
      expect(await readFile(join(f.project, ".git/index"))).toEqual(f.index);
      expect(await readFile(join(f.project, "file.txt"), "utf8")).toBe(
        "dirty caller content\n",
      );
    } finally {
      if (previousLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
      else process.env.GIT_OPTIONAL_LOCKS = previousLocks;
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test("a rejected PR refresh preserves retained A; verified B retains both pins through checkout and GC until close", async () => {
  const f = await fixture();
  try {
    const workspaces = await ReviewWorkspaces.open(
      f.project,
      join(f.root, "storage"),
    );
    const owner = await workspaces.create("origin");
    await f.git("remote", "add", "origin", f.project);
    await f.git("update-ref", "refs/pull/7/head", f.pinned);
    await workspaces.use(owner.id, (o) => workspaces.pin(o, f.pinned, 7));
    const retainedA = `refs/workcell-review/${owner.id}/${f.pinned}`;
    const moved = await f.git(
      "commit-tree",
      await f.git("rev-parse", `${f.head}^{tree}`),
      "-m",
      "force-pushed PR",
    );
    await f.git("update-ref", "refs/pull/7/head", moved);
    await expect(
      workspaces.use(owner.id, (o) => workspaces.pin(o, f.pinned, 7)),
    ).rejects.toThrow("PR head moved");
    expect(await f.git("rev-parse", retainedA)).toBe(f.pinned);
    expect(
      await f.git(
        "for-each-ref",
        "--format=%(refname)",
        `refs/workcell-review/${owner.id}`,
      ),
    ).toBe(retainedA);
    expect((await workspaces.load(owner.id)).refs).toEqual([retainedA]);
    expect(
      await readFile(
        join(workspaces.paths(owner.id).checkout, "file.txt"),
        "utf8",
      ),
    ).toBe("pinned content\n");
    await workspaces.use(owner.id, (o) => workspaces.pin(o, moved, 7));
    await f.git("gc", "--prune=now");
    const retainedB = `refs/workcell-review/${owner.id}/${moved}`;
    expect(await f.git("rev-parse", retainedA)).toBe(f.pinned);
    expect(await f.git("rev-parse", retainedB)).toBe(moved);
    expect(
      (
        await f.git(
          "for-each-ref",
          "--format=%(refname)",
          `refs/workcell-review/${owner.id}`,
        )
      )
        .split("\n")
        .sort(),
    ).toEqual([retainedA, retainedB].sort());
    expect((await workspaces.load(owner.id)).refs.sort()).toEqual(
      [retainedA, retainedB].sort(),
    );
    await workspaces.use(owner.id, (o) => workspaces.remove(o, false));
    expect(
      await f.git(
        "for-each-ref",
        "--format=%(refname)",
        `refs/workcell-review/${owner.id}`,
      ),
    ).toBe("");
    expect(await f.git("rev-parse", "HEAD")).toBe(f.head);
    expect(await readFile(join(f.project, ".git/index"))).toEqual(f.index);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("review worktree pins without source edits/hooks/filters; dirty and ownership checks protect cleanup", async () => {
  const f = await fixture();
  try {
    const workspaces = await ReviewWorkspaces.open(
      f.project,
      join(f.root, "storage"),
    );
    const owner = await workspaces.create("origin");
    const otherProcess = Bun.spawn(["sleep", "10"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      owner.pid = otherProcess.pid;
      await workspaces.save(owner);
      await expect(workspaces.use(owner.id, async () => {})).rejects.toThrow(
        "Another OpenCode process",
      );
    } finally {
      otherProcess.kill();
      await otherProcess.exited;
    }
    await mkdir(join(f.project, ".git/hooks"));
    await writeFile(
      join(f.project, ".git/hooks/post-checkout"),
      `#!/bin/sh\ntouch '${join(f.root, "hook-executed")}'`,
      { mode: 0o755 },
    );
    await f.git(
      "config",
      "filter.fixture.process",
      `touch '${join(f.root, "filter-executed")}'`,
    );
    await f.git("remote", "add", "origin", f.project);
    await f.git("update-ref", "refs/pull/7/head", f.pinned);
    await workspaces.use(owner.id, (o) => workspaces.pin(o, f.pinned, 7));
    await expect(
      workspaces.use(owner.id, (o) => workspaces.pin(o, f.head, 7)),
    ).rejects.toThrow("PR head moved");
    expect(
      await readFile(
        join(workspaces.paths(owner.id).checkout, "file.txt"),
        "utf8",
      ),
    ).toBe("pinned content\n");
    expect(await f.git("rev-parse", "HEAD")).toBe(f.head);
    expect(await f.git("rev-parse", "refs/pull/7/head")).toBe(f.pinned);
    expect(await f.git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(await readFile(join(f.project, ".git/index"))).toEqual(f.index);
    expect(await readFile(join(f.project, "file.txt"), "utf8")).toBe(
      "dirty caller content\n",
    );
    expect(await readdir(f.root)).not.toContain("hook-executed");
    expect(await readdir(f.root)).not.toContain("filter-executed");
    await expect(workspaces.load("../source")).rejects.toThrow();
    const marker = join(workspaces.paths(owner.id).checkout, ".git"),
      original = await readFile(marker, "utf8");
    await writeFile(marker, `gitdir: ${join(f.project, ".git")}\n`);
    await expect(
      workspaces.use(owner.id, (o) => workspaces.remove(o, true)),
    ).rejects.toThrow("owned");
    await writeFile(marker, original);
    await writeFile(
      join(workspaces.paths(owner.id).checkout, "file.txt"),
      "unexpected edit",
    );
    await expect(
      workspaces.use(owner.id, (o) => workspaces.remove(o, false)),
    ).rejects.toThrow("discard");
    await workspaces.use(owner.id, (o) => workspaces.remove(o, true));
    expect(
      await f.git(
        "for-each-ref",
        "--format=%(refname)",
        `refs/workcell-review/${owner.id}`,
      ),
    ).toBe("");
    expect(await f.git("rev-parse", "HEAD")).toBe(f.head);
    expect(await readFile(join(f.project, ".git/index"))).toEqual(f.index);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("resume refuses delivery when the retained coordinator cannot be restored to review", async () => {
  const f = await fixture();
  try {
    const resources = await ReviewWorkspaces.open(
      f.project,
      join(f.root, "storage"),
    );
    const owner = await resources.create("origin");
    owner.sessions.push("coordinator");
    await resources.save(owner);
    let switches = 0,
      deliveries = 0;
    const client = {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          id: sessionID,
          agent: sessionID === "coordinator" ? "build" : "debug",
          location: { directory: f.project },
        }),
        active: async () => ({}),
        switchAgent: async (input: { sessionID: string; agent: string }) => {
          expect(input).toEqual({ sessionID: "coordinator", agent: "review" });
          switches++;
          throw new Error("fixture restore failure");
        },
        update: async () => {},
        synthetic: async () => {
          deliveries++;
        },
      },
    };
    const manager = new BackgroundAgentsPlugin.testInternals.DelegationManager(
      client as unknown as OpenCodeClient,
      join(f.root, "ordinary"),
      { debug() {}, info() {}, warn() {}, error() {} },
      {
        reviewWorkspaces: resources,
        storage: {
          get: async (key: string) =>
            key === "review-session/coordinator" ? { id: owner.id } : undefined,
          set: async () => {},
        } as unknown as Plugin.Context["storage"],
      },
    );
    await expect(
      manager.review(
        {
          action: "resume",
          id: owner.id,
          request: "Resume safely",
          separate: false,
          discard: false,
        },
        toolContext("origin", "debug"),
      ),
    ).rejects.toThrow(
      "Could not restore the review coordinator's review agent; no request was delivered",
    );
    expect(switches).toBe(1);
    expect(deliveries).toBe(0);
    expect((await resources.load(owner.id)).originAgent).toBe("build");
    manager.dispose();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("ordinary delegation uses disposable review artifacts across restart and cannot recreate them after active close", async () => {
  const f = await fixture();
  try {
    const resources = await ReviewWorkspaces.open(
      f.project,
      join(f.root, "storage"),
    );
    const owner = await resources.create("origin");
    owner.sessions.push("coordinator");
    await resources.save(owner);
    const sessions = new Map<
      string,
      { id: string; parentID?: string; metadata?: Record<string, unknown> }
    >([
      ["coordinator", { id: "coordinator" }],
      ["origin", { id: "origin" }],
    ]);
    let count = 0,
      busy = false,
      release: (() => void) | undefined;
    let parentPending = false,
      notePath = "";
    let releaseParent: (() => void) | undefined;
    let workerGate = Promise.resolve();
    const bindings = new Map<string, unknown>([
      ["review-session/coordinator", { id: owner.id }],
    ]);
    const storage = {
      get: async (key: string) => bindings.get(key),
      set: async (key: string, value: unknown) => {
        bindings.set(key, value);
      },
    };
    const client = {
      agent: {
        list: async () => ({
          data: [{ id: "reviewer", mode: "subagent" }],
        }),
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({
          ...sessions.get(sessionID),
          location: { directory: f.project },
          outcome: "succeeded",
        }),
        update: async ({
          sessionID,
          ...body
        }: {
          sessionID: string;
          title?: string;
          metadata?: Record<string, unknown>;
        }) => {
          const prior = sessions.get(sessionID);
          if (!prior) throw new Error("Missing fixture session");
          const data = { ...prior, ...body };
          sessions.set(sessionID, data);
          return data;
        },
        wait: async ({ sessionID }: { sessionID: string }) => {
          if (sessionID === "worker-2") await workerGate;
          if (sessionID === "worker-3") {
            parentPending = true;
            void new Promise<void>((resolve) => {
              releaseParent = resolve;
            }).then(async () => {
              // Native wakeup effects must settle before workspace removal.
              await mkdir(dirname(notePath), { recursive: true });
              await writeFile(notePath, "coordinator update");
              parentPending = false;
            });
          }
        },
        interrupt: async () => {
          release?.();
        },
        active: async () => ({
          ...(busy ? { "worker-2": { type: "running" } } : {}),
          ...(parentPending ? { direct: { type: "running" } } : {}),
        }),
      },
      message: {
        list: async ({ type }: { type?: string }) => ({
          data:
            type === "synthetic"
              ? Array.from(sessions.keys())
                  .filter((id) => id.startsWith("worker-"))
                  .map((childID) => ({
                    type: "synthetic",
                    metadata: { source: "subagent", childID },
                  }))
              : [
                  {
                    type: "assistant",
                    content: [
                      { type: "text", text: "private finding sentinel" },
                    ],
                  },
                ],
        }),
      },
    };
    const base = join(f.root, "ordinary");
    await mkdir(base);
    let enrichments = 0;
    const options = {
      reviewWorkspaces: resources,
      storage: storage as unknown as Plugin.Context["storage"],
      nativeSubagent: {
        input: { make: (value: unknown) => value },
        execute: async (args: { prompt: string }, context: ToolContext) => {
          const id = `worker-${++count}`;
          sessions.set(id, { id, parentID: context.sessionID });
          if (args.prompt === "wait") {
            busy = true;
            workerGate = new Promise<void>((resolve) => {
              release = () => {
                busy = false;
                resolve();
              };
            });
          }
          return {
            content: "running",
            output: { sessionID: id, status: "running" },
          };
        },
      } as unknown as Info,
      idGenerator: () => (count ? "second-blue-otter" : "first-blue-otter"),
      metadataGenerator: async () => {
        enrichments++;
        return { title: "private", description: "private" };
      },
    };
    const log = {
      async debug() {},
      async info() {},
      async warn() {},
      async error() {},
    };
    const Manager = BackgroundAgentsPlugin.testInternals.DelegationManager;
    const manager = new Manager(
      client as unknown as OpenCodeClient,
      base,
      log,
      options,
    );
    const input = {
      parentSessionID: "coordinator",
      parentMessageID: "message",
      parentAgent: "review",
      prompt: "inspect",
      agent: "reviewer",
      context: toolContext("coordinator"),
    };
    const first = await manager.delegate(input);
    expect(await manager.readOutput("coordinator", first.id)).toContain(
      "private finding sentinel",
    );
    expect(first.promptPending).toBe(false);
    const restarted = new Manager(
      client as unknown as OpenCodeClient,
      base,
      log,
      options,
    );
    expect(await restarted.readOutput("coordinator", first.id)).toContain(
      "private finding sentinel",
    );
    const second = await restarted.delegate({ ...input, prompt: "wait" });
    for (let i = 0; i < 100 && !busy; i++) await Bun.sleep(10);
    expect(busy).toBe(true);
    await restarted.review(
      {
        action: "close",
        id: owner.id,
        request: "",
        separate: false,
        discard: false,
      },
      toolContext("origin", "build"),
    );
    await expect(
      restarted.readOutput("coordinator", second.id),
    ).rejects.toThrow();
    await expect(restarted.delegate(input)).rejects.toThrow();
    await expect(
      readFile(join(resources.paths(owner.id).artifacts, `${second.id}.md`)),
    ).rejects.toThrow();
    expect(
      (await readdir(base)).filter(
        (name) => name !== "background-agents-debug.log",
      ),
    ).toEqual([]);
    expect(
      await readFile(join(base, "background-agents-debug.log"), "utf8"),
    ).not.toContain("private finding sentinel");
    expect(enrichments).toBe(0);
    sessions.set("direct", { id: "direct" });
    const directContext = toolContext("direct");
    const request = {
      action: "start" as const,
      request: "recent",
      separate: false,
      discard: false,
    };
    const direct = JSON.parse(await restarted.review(request, directContext));
    expect(direct.session).toBe("direct");
    expect(JSON.parse(await restarted.review(request, directContext)).id).toBe(
      direct.id,
    );
    expect(count).toBe(2); // No third SDK session: direct review mode keeps its legitimate root.
    notePath = join(resources.paths(direct.id).notes, "late.md");
    const third = await restarted.delegate({
      ...input,
      parentSessionID: "direct",
      context: directContext,
    });
    await restarted.readOutput("direct", third.id);
    for (let i = 0; i < 100 && !parentPending; i++) await Bun.sleep(10);
    expect(parentPending).toBe(true);
    setTimeout(() => releaseParent?.(), 150);
    await restarted.review(
      { ...request, action: "close", id: direct.id },
      toolContext("origin", "build"),
    );
    await Bun.sleep(200);
    await expect(readFile(notePath)).rejects.toThrow();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
