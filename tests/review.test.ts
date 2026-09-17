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

import type { PluginInput } from "@opencode-ai/plugin";

import BackgroundAgentsPlugin from "../files/plugins/background-agents";
import { ReviewWorkspaces } from "../files/plugins/worktree/review";

const exec = promisify(execFile);

test.each(["idle", "timeout", "cancel"] as const)(
  "%s finalization does not settle a delayed worker transport or release its workspace",
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
        app: {
          agents: async () => ({
            data: [{ name: "reviewer", mode: "subagent" }],
          }),
        },
        session: {
          get: async ({ path }: { path: { id: string } }) => ({
            data: {
              id: path.id,
              ...(path.id === "worker" ? { parentID: "coordinator" } : {}),
              ...(path.id === "coordinator"
                ? {
                    metadata: {
                      workcellReviewWorkspace: {
                        id: owner.id,
                        project: f.project,
                      },
                    },
                  }
                : {}),
            },
          }),
          create: async () => ({ data: { id: "worker" } }),
          prompt: async ({ path }: { path: { id: string } }) => {
            if (path.id !== "worker") return { data: { parts: [] } };
            requested = true;
            await gate; // Request/response remains in flight despite an idle/abort/delete acknowledgment.
            inspected = await readFile(
              join(resources.paths(owner.id).checkout, "file.txt"),
              "utf8",
            );
            return { data: { parts: [{ type: "text", text: inspected }] } };
          },
          abort: async () => {
            aborted = true;
            return { data: true };
          },
          delete: async () => ({ data: true }),
          status: async () => ({ data: {} }),
          messages: async () => ({ data: [] }),
        },
      };
      const base = join(f.root, "ordinary");
      await mkdir(base);
      const Manager = BackgroundAgentsPlugin.testInternals.DelegationManager;
      const manager = new Manager(
        client as unknown as PluginInput["client"],
        base,
        {
          async debug() {},
          async info() {},
          async warn() {},
          async error() {},
        },
        {
          reviewWorkspaces: resources,
          idGenerator: () => "delayed-blue-otter",
          idleFinalizationGraceMs: 1,
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
      });
      for (let i = 0; i < 100 && !requested; i++) await Bun.sleep(10);
      expect(requested).toBe(true);
      if (finalization !== "cancel") {
        if (finalization === "idle") await manager.handleSessionIdle("worker");
        await manager.readOutput("coordinator", delegation.id);
        expect(delegation.status).toBe(
          finalization === "idle" ? "complete" : "timeout",
        );
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
          {
            sessionID: "origin",
            messageID: "close",
            directory: f.project,
            worktree: f.project,
            agent: "build",
            abort: new AbortController().signal,
            metadata() {},
            async ask() {},
          },
        )
        .then((result) => {
          closed = true;
          return result;
        });
      for (
        let i = 0;
        i < 300 &&
        (!aborted ||
          delegation.status !==
            (finalization === "cancel"
              ? "cancelled"
              : finalization === "idle"
                ? "complete"
                : "timeout"));
        i++
      )
        await Bun.sleep(10);
      expect(aborted).toBe(true);
      expect(delegation.status).toBe(
        finalization === "cancel"
          ? "cancelled"
          : finalization === "idle"
            ? "complete"
            : "timeout",
      );
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
      [
        "coordinator",
        {
          id: "coordinator",
          metadata: {
            workcellReviewWorkspace: { id: owner.id, project: f.project },
          },
        },
      ],
      ["origin", { id: "origin" }],
    ]);
    let count = 0,
      busy = false,
      release: (() => void) | undefined;
    let parentPending = false,
      notePath = "";
    let releaseParent: (() => void) | undefined;
    const client = {
      app: {
        agents: async () => ({
          data: [{ name: "reviewer", mode: "subagent" }],
        }),
      },
      session: {
        get: async ({ path }: { path: { id: string } }) => ({
          data: sessions.get(path.id),
        }),
        update: async ({
          path,
          body,
        }: {
          path: { id: string };
          body: { title?: string; metadata?: Record<string, unknown> };
        }) => {
          const prior = sessions.get(path.id);
          if (!prior) throw new Error("Missing fixture session");
          const data = { ...prior, ...body };
          sessions.set(path.id, data);
          return { data };
        },
        create: async ({ body }: { body: { parentID?: string } }) => {
          const id = `worker-${++count}`;
          sessions.set(id, { id, parentID: body.parentID });
          return { data: { id } };
        },
        prompt: async ({
          path,
          body,
        }: {
          path: { id: string };
          body: { parts: { text: string }[]; noReply?: boolean };
        }) => {
          if (path.id === "direct" && body.noReply === false) {
            parentPending = true;
            await new Promise<void>((resolve) => {
              releaseParent = resolve;
            });
            // Model/file-tool effects can occur after a delayed prompt reaches the server.
            await mkdir(dirname(notePath), { recursive: true });
            await writeFile(notePath, "coordinator update");
            parentPending = false;
          }
          if (!path.id.startsWith("worker-")) return { data: { parts: [] } };
          if (body.parts[0].text === "wait") {
            busy = true;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            busy = false;
          }
          return {
            data: {
              parts: [{ type: "text", text: "private finding sentinel" }],
            },
          };
        },
        abort: async () => {
          release?.();
          return { data: true };
        },
        status: async () => ({
          data: busy ? { "worker-2": { type: "busy" } } : {},
        }),
        messages: async () => ({ data: [] }),
      },
    };
    const base = join(f.root, "ordinary");
    await mkdir(base);
    let enrichments = 0;
    const options = {
      reviewWorkspaces: resources,
      allCompleteQuietPeriodMs: 10,
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
      client as unknown as PluginInput["client"],
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
    };
    const first = await manager.delegate(input);
    expect(await manager.readOutput("coordinator", first.id)).toContain(
      "private finding sentinel",
    );
    expect(first.promptPending).toBe(false);
    const restarted = new Manager(
      client as unknown as PluginInput["client"],
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
      {
        sessionID: "origin",
        messageID: "message",
        directory: f.project,
        worktree: f.project,
        agent: "build",
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
      },
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
    const directContext = {
      sessionID: "direct",
      messageID: "direct-message",
      directory: f.project,
      worktree: f.project,
      agent: "review",
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    };
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
    });
    await restarted.readOutput("direct", third.id);
    for (let i = 0; i < 100 && !parentPending; i++) await Bun.sleep(10);
    expect(parentPending).toBe(true);
    setTimeout(() => releaseParent?.(), 150);
    await restarted.review(
      { ...request, action: "close", id: direct.id },
      { ...directContext, sessionID: "origin", agent: "build" },
    );
    await Bun.sleep(200);
    await expect(readFile(notePath)).rejects.toThrow();
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
