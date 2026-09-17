import { expect, spyOn, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";

import type { PluginInput } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";

import ReviewPlugin from "../files/plugins/review";
import { fingerprint, type Handoff } from "../files/plugins/review/contracts";
import { GitHub } from "../files/plugins/review/github";
import { execute, git, type Transport } from "../files/plugins/review/process";
import { ReviewRuntime } from "../files/plugins/review/runtime";
import { newId, ReviewStore } from "../files/plugins/review/store";

test("optional GitHub outages qualify public reports without redispatch; identity, pins and invariant failures remain fatal", () =>
  harness(async (f) => {
    await git(f.project, [
      "remote",
      "add",
      "origin",
      "https://github.com/example/repo.git",
    ]);
    await git(f.project, ["update-ref", "refs/pull/1/head", f.head]);
    let mode = "checks-denied";
    const safetyError = new Error(
      "Review output limit exceeded; narrow the scope",
    );
    const programmingError = new TypeError("fixture transport invariant");
    const response = (value: unknown) => ({
      code: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from(JSON.stringify(value)),
    });
    const unavailable = (status: number) => ({
      code: 1,
      stderr: Buffer.from(
        `gh: private diagnostic secret-marker (HTTP ${status})`,
      ),
      stdout: Buffer.from('{"message":"secret-marker"}'),
    });
    const github = new GitHub(f.project, async ({ argv }) => {
      const endpoint = argv.at(-1)!;
      if (endpoint.endsWith("/pulls/1")) {
        if (mode === "metadata-denied") return unavailable(403);
        return response({
          number: 1,
          title: "Fixture PR",
          body: "Caller contract",
          state: "open",
          base: {
            sha: f.head,
            ref: "main",
            repo: {
              full_name:
                mode === "wrong-repository" ? "other/repo" : "example/repo",
              html_url: "https://github.com/example/repo",
            },
          },
          head: {
            sha:
              mode === "moved-pin"
                ? "b".repeat(40)
                : mode === "bad-oid"
                  ? "not-an-oid"
                  : f.head,
          },
        });
      }
      if (endpoint.includes("check-runs")) {
        if (mode === "checks-denied") return unavailable(403);
        if (mode === "bad-request") return unavailable(400);
        if (mode === "bad-response") return response({ wrongSchema: [] });
        if (mode === "transport-safety") throw safetyError;
        if (mode === "programming-error") throw programmingError;
        return response({
          check_runs: [{ name: "CI", conclusion: "success" }],
        });
      }
      if (endpoint.includes("issues/1/comments") && mode === "comments-down")
        return unavailable(503);
      return response([]);
    });
    const gitTransport: Transport = (command) =>
      execute({
        ...command,
        argv: command.argv.map((arg) =>
          arg === "https://github.com/example/repo.git"
            ? `file://${f.project}`
            : arg,
        ),
      });
    const runtime = new ReviewRuntime(f.input, f.store, {
      github,
      gitTransport,
    });
    const origin = f.actor();
    const started = JSON.parse(
      await runtime.start("pr 1", origin, false, brief),
    );
    const coordinator = f.actor(started.session, "review");
    const first = JSON.parse(
      await runtime.state({ action: "prepare", context }, coordinator),
    );
    expect(first.round.evidence.checks.availability).toBe("unavailable");
    expect(first.round.evidence.checks.failure).toEqual({
      category: "permission-denied",
      httpStatus: 403,
      exitCode: 1,
    });
    expect(first.round.evidence.checks).not.toHaveProperty("items");
    expect(
      Number.isFinite(Date.parse(first.round.evidence.checks.checkedAt)),
    ).toBe(true);
    expect(first.round.evidence.comments.availability).toBe("available");
    expect(first.round.evidenceLimitations).toHaveLength(1);
    await finish(f, runtime, coordinator, 1, "APPROVE. No code findings."); // Coordinator omits every evidence limitation.
    const status = JSON.parse(
      await runtime.start(`status ${started.review}`, origin),
    );
    expect(status.report).toContain("checks unavailable");
    expect(status.report).toContain("permission-denied");
    expect(
      status.limitations.some((value: string) =>
        value.includes("checks unavailable"),
      ),
    ).toBe(true);
    expect(status.report).not.toContain("secret-marker");
    const stored = await f.store.load(started.review);
    expect(stored.rounds[0].report).toBe(status.report);
    expect(JSON.stringify(stored)).not.toContain("secret-marker");
    const workers = f.creates.filter((s) => s.parentID).length;

    mode = "healthy";
    const restored = JSON.parse(
      await runtime.state({ action: "prepare", context }, coordinator),
    );
    expect(restored.reused).toBe(true);
    expect(restored.round.evidence.checks.availability).toBe("available");
    expect(restored.round.evidence.checks.items[0].conclusion).toBe("success");
    expect(restored.round.evidenceLimitations).toEqual([]);
    expect(
      Date.parse(restored.round.evidence.checks.checkedAt),
    ).toBeGreaterThanOrEqual(Date.parse(first.round.evidence.checks.checkedAt));
    await runtime.state(
      { action: "complete", report: "APPROVE. Current checks were retrieved." },
      coordinator,
    );
    expect(
      JSON.parse(await runtime.start(`status ${started.review}`, origin))
        .report,
    ).not.toContain("unavailable");

    // Access is lost only during evidence-only finalization. It must not abort a qualified report,
    // keep the previous passing check items, or demand another reviewer dispatch.
    expect(
      JSON.parse(
        await runtime.state({ action: "prepare", context }, coordinator),
      ).reused,
    ).toBe(true);
    mode = "checks-denied";
    const notices = f.notifications.length;
    const qualified = JSON.parse(
      await runtime.state(
        { action: "complete", report: "APPROVE. No code findings." },
        coordinator,
      ),
    );
    expect(qualified.report).toContain("checks unavailable");
    expect(f.notifications.length).toBe(notices + 1);
    const current = (await f.store.load(started.review)).rounds.at(-1)!;
    expect(current.evidence.checks).toMatchObject({
      availability: "unavailable",
      failure: { category: "permission-denied" },
    });
    expect(current.evidence.checks).not.toHaveProperty("items");
    expect(
      JSON.parse(await runtime.start(`status ${started.review}`, origin))
        .report,
    ).toBe(qualified.report);

    mode = "comments-down";
    const comments = JSON.parse(
      await runtime.state({ action: "prepare", context }, coordinator),
    );
    expect(comments.round.evidence.comments).toMatchObject({
      availability: "unavailable",
      failure: { category: "service-unavailable", httpStatus: 503 },
    });
    expect(comments.round.evidence.checks.availability).toBe("available");
    const commentsReport = JSON.parse(
      await runtime.state(
        { action: "complete", report: "APPROVE. No code findings." },
        coordinator,
      ),
    );
    expect(commentsReport.report).toContain("comments unavailable");
    expect(commentsReport.report).not.toContain("checks unavailable");
    mode = "healthy";
    await runtime.state({ action: "prepare", context }, coordinator);
    await runtime.state(
      { action: "complete", report: "APPROVE. Auxiliary evidence restored." },
      coordinator,
    );
    expect(
      (await f.store.load(started.review)).rounds.at(-1)!.evidenceLimitations,
    ).toEqual([]);
    expect(f.creates.filter((s) => s.parentID).length).toBe(workers);
    const baseline = (await f.store.load(started.review)).lastCompleted;

    for (const failure of [
      "metadata-denied",
      "wrong-repository",
      "moved-pin",
      "bad-oid",
      "bad-request",
      "bad-response",
    ]) {
      mode = failure;
      await expect(
        runtime.state({ action: "prepare", context }, coordinator),
      ).rejects.toThrow();
      expect((await f.store.load(started.review)).lastCompleted).toBe(baseline);
    }
    for (const [failure, error] of [
      ["transport-safety", safetyError],
      ["programming-error", programmingError],
    ] as const) {
      mode = failure;
      await expect(
        runtime.state({ action: "prepare", context }, coordinator),
      ).rejects.toBe(error);
      expect((await f.store.load(started.review)).lastCompleted).toBe(baseline);
    }
  }));

const brief: Handoff = {
  requirements: "Preserve tenant isolation, including cached responses.",
  constraints: ["Do not execute target code"],
  evidence: [
    {
      reference: "shared-plan/task-3",
      summary:
        "Cache keys must include tenant ID; hosted checks cover producer shape only.",
    },
  ],
};
const context = {
  specification: "Caller contract",
  instructions: "No extra repository instructions",
  testEvidence: "Hosted only",
  risk: "behavior",
};
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
async function harness(
  run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const f = await fixture();
  try {
    await run(f);
  } finally {
    f.home.mockRestore();
    await rm(f.root, { recursive: true, force: true });
  }
}
async function fixture() {
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await realpath(
    await mkdtemp(resolve(".tmp/review-corrections-")),
  );
  const project = join(root, "source");
  await mkdir(project);
  await git(project, ["init", "--template=", "-b", "main"]);
  await writeFile(join(project, "file.txt"), "contract\n");
  await git(project, ["add", "file.txt"]);
  await git(project, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "root",
  ]);
  const head = (await git(project, ["rev-parse", "HEAD"])).trim();
  const home = spyOn(os, "homedir").mockReturnValue(root);
  const sessions = new Map<string, Record<string, unknown>>([
    ["origin", { id: "origin", directory: project }],
  ]);
  const prompts: { session: string; body: { parts: { text: string }[] } }[] =
    [];
  const creates: Record<string, unknown>[] = [];
  const notifications: unknown[] = [];
  let onPrompt: (session: string) => Promise<void> = async () => {};
  const client = {
    session: {
      create: async ({ body }: { body: Record<string, unknown> }) => {
        const id = `s${creates.length + 1}`;
        creates.push(body);
        const data = { ...body, id, directory: project };
        sessions.set(id, data);
        return { data };
      },
      get: async ({ path }: { path: { id: string } }) => ({
        data: sessions.get(path.id),
        response: { status: sessions.has(path.id) ? 200 : 404 },
      }),
      list: async () => ({ data: [...sessions.values()] }),
      prompt: async ({
        path,
        body,
      }: {
        path: { id: string };
        body: { parts: { text: string }[] };
      }) => {
        prompts.push({ session: path.id, body });
        await onPrompt(path.id);
        return {
          data: { parts: [{ type: "text", text: "Evidence submitted" }] },
        };
      },
      status: async () => ({ data: {} }),
      abort: async () => ({ data: true }),
      delete: async ({ path }: { path: { id: string } }) => {
        sessions.delete(path.id);
        return { data: true };
      },
    },
    tui: {
      showToast: async (notification: unknown) => {
        notifications.push(notification);
        return { data: true };
      },
    },
  };
  const input = {
    client,
    directory: project,
    worktree: project,
    project: { id: "fixture", worktree: project },
  } as unknown as PluginInput;
  const store = await ReviewStore.open(
    project,
    join(root, ".local/share/workcell/reviews"),
  );
  const runtime = new ReviewRuntime(input, store);
  const plugin = await ReviewPlugin(input);
  const actor = (
    sessionID = "origin",
    agent = "build",
    messageID = newId(),
  ): ToolContext => ({
    sessionID,
    agent,
    messageID,
    directory: project,
    worktree: project,
    abort: new AbortController().signal,
    ask: async () => {},
    metadata: () => {},
  });
  return {
    root,
    project,
    head,
    home,
    sessions,
    prompts,
    creates,
    notifications,
    input,
    store,
    runtime,
    plugin,
    actor,
    onPrompt: (fn: typeof onPrompt) => {
      onPrompt = fn;
    },
  };
}
async function finish(
  f: Awaited<ReturnType<typeof fixture>>,
  runtime: ReviewRuntime,
  coordinator: ToolContext,
  number: number,
  report: string,
) {
  const [slot] = JSON.parse(
    await runtime.state(
      { action: "plan", lenses: ["comprehensive"] },
      coordinator,
    ),
  );
  f.onPrompt(async (session) => {
    if (session !== slot.session) return;
    await runtime.state(
      {
        action: "submit",
        round: number,
        outcome: "succeeded",
        coverage: ["Fixture and caller contract"],
        limitations: ["No local tests"],
        candidates: [],
      },
      f.actor(session, "reviewer"),
    );
  });
  await runtime.delegate(coordinator, {
    agent: "reviewer",
    review_slot: slot.id,
    prompt: "Verify the supplied caller contract",
  });
  await runtime.state({ action: "complete", report }, coordinator);
}
async function sourceFingerprint(root: string): Promise<string> {
  const entries: [string, string][] = [];
  async function visit(path: string) {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name);
      if ((await lstat(full)).isDirectory()) await visit(full);
      else
        entries.push([
          full.slice(root.length),
          (await readFile(full)).toString("base64"),
        ]);
    }
  }
  await visit(root);
  return fingerprint(entries);
}

test("S1/S2: public recovery survives incomplete inventory, preserves bound restrictions, and never steals live creation locks", () =>
  harness(async (f) => {
    const origin = f.actor();
    const tools = f.plugin.tool!;
    const incomplete = newId();
    await mkdir(f.store.directory(incomplete), { mode: 0o700 });
    await writeFile(join(f.store.directory(incomplete), "owner"), newId());
    await f.plugin["chat.message"]!(
      { sessionID: "origin" } as never,
      {} as never,
    );
    await f.plugin["tool.execute.before"]!(
      { sessionID: "origin", tool: "review_start", callID: "recovery" },
      { args: {} },
    );
    const inventory = JSON.parse(
      String(await tools.review_start.execute({ scope: "list" }, origin)),
    );
    expect(inventory.issues).toEqual([
      { id: incomplete, state: "unavailable" },
    ]);
    expect(
      String(
        await tools.review_start.execute(
          { scope: `recover ${incomplete}` },
          origin,
        ),
      ),
    ).toContain("unavailable");
    const partition = dirname(f.store.directory(incomplete));
    const lock = join(partition, "create.lock");
    await writeFile(
      lock,
      JSON.stringify({ pid: process.pid, host: os.hostname(), token: newId() }),
    );
    await expect(
      tools.review_start.execute({ scope: "recover create" }, origin),
    ).rejects.toThrow("still running");
    const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    await writeFile(
      lock,
      JSON.stringify({ pid: child.pid, host: os.hostname(), token: newId() }),
    );
    await tools.review_start.execute({ scope: "recover create" }, origin);
    const started = JSON.parse(
      String(
        await tools.review_start.execute(
          { scope: "recent", handoff: brief },
          origin,
        ),
      ),
    );
    const m = await f.store.load(started.review);
    await rm(join(f.store.directory(m.id), "manifest.json"));
    const restarted = await ReviewPlugin(f.input); // No in-memory binding cache can mask this regression.
    await expect(
      restarted["chat.message"]!(
        { sessionID: m.coordinator! } as never,
        {} as never,
      ),
    ).rejects.toThrow("Bound review state");
    await expect(
      restarted["tool.execute.before"]!(
        { sessionID: m.coordinator!, tool: "bash", callID: "bad" },
        { args: {} },
      ),
    ).rejects.toThrow();
    await restarted["chat.message"]!(
      { sessionID: "origin" } as never,
      {} as never,
    );
    const info = await lstat(f.store.directory(m.id));
    // Simulate a crash after successful session retirement + tombstone publication, during rm.
    for (const session of m.managedSessions) f.sessions.delete(session);
    await writeFile(
      join(partition, `${m.id}.removed`),
      JSON.stringify({
        version: 1,
        id: m.id,
        project: f.project,
        initiator: "origin",
        coordinator: m.coordinator,
        owner: m.owner,
        device: info.dev,
        inode: info.ino,
      }),
    );
    await restarted.tool!.review_start.execute(
      { scope: `close ${m.id}` },
      origin,
    );
    await expect(lstat(f.store.directory(m.id))).rejects.toThrow();
    expect((await f.store.inventory()).issues).toEqual([
      { id: incomplete, state: "unavailable" },
    ]);
  }));

test("S3/F3: interrupted initialization retries and closes safely; identical ranges stay empty even at a root commit", () =>
  harness(async (f) => {
    let fail = true;
    const transport: Transport = async (command) => {
      const result = await execute(command);
      if (fail && command.argv.includes("init")) {
        fail = false;
        throw new Error("interrupted before config marker");
      }
      return result;
    };
    const runtime = new ReviewRuntime(f.input, f.store, {
      gitTransport: transport,
    });
    const origin = f.actor();
    const started = JSON.parse(await runtime.start("HEAD..HEAD", origin));
    const coordinator = f.actor(started.session, "review");
    const before = await sourceFingerprint(f.project);
    await expect(
      runtime.state({ action: "prepare", context }, coordinator),
    ).rejects.toThrow("interrupted");
    await expect(
      lstat(join(f.store.directory(started.review), "git")),
    ).rejects.toThrow();
    // Abrupt-process leftovers are unpublished and cannot become the next repository.
    await mkdir(join(f.store.directory(started.review), "git-opening-crashed"));
    await writeFile(
      join(f.store.directory(started.review), "git-opening-crashed/config"),
      "untrusted partial bytes",
    );
    await runtime.state({ action: "prepare", context }, coordinator);
    expect(
      JSON.parse(await runtime.inspect({ kind: "diff" }, 1, coordinator)),
    ).toBe("");
    await runtime.close(started.review, runtime.actor(origin));
    await expect(lstat(f.store.directory(started.review))).rejects.toThrow();
    const legacy = JSON.parse(await runtime.start("recent", f.actor()));
    await mkdir(join(f.store.directory(legacy.review), "git"));
    await expect(
      runtime.close(legacy.review, runtime.actor(origin)),
    ).rejects.toThrow();
    await runtime.close(legacy.review, runtime.actor(origin), true);
    await expect(lstat(f.store.directory(legacy.review))).rejects.toThrow();
    for (const scope of ["HEAD...HEAD", "recent"]) {
      const next = JSON.parse(await runtime.start(scope, f.actor()));
      const actor = f.actor(next.session, "review");
      await runtime.state({ action: "prepare", context }, actor);
      const diff = JSON.parse(
        await runtime.inspect({ kind: "diff" }, 1, actor),
      );
      if (scope === "recent") expect(diff).toContain("+contract");
      else expect(diff).toBe("");
    }
    expect(await sourceFingerprint(f.project)).toBe(before);
  }));

test("F1/F2: handoff survives new roots; mutable PR evidence gets a new summary without redispatch, while changed requirements/body force coverage", () =>
  harness(async (f) => {
    await git(f.project, [
      "remote",
      "add",
      "origin",
      "https://github.com/example/repo.git",
    ]);
    await git(f.project, ["update-ref", "refs/pull/1/head", f.head]);
    let body = "Tenant isolation contract",
      check = "success",
      comment = "initial";
    const github = new GitHub(f.project, async ({ argv }) => {
      const endpoint = argv.at(-1)!;
      const value = endpoint.endsWith("/pulls/1")
        ? {
            number: 1,
            title: "Change",
            body,
            state: "open",
            base: {
              sha: f.head,
              ref: "main",
              repo: {
                full_name: "example/repo",
                html_url: "https://github.com/example/repo",
              },
            },
            head: { sha: f.head },
          }
        : endpoint.includes("check-runs")
          ? { check_runs: [{ conclusion: check }] }
          : endpoint.includes("issues/1/comments")
            ? [{ body: comment }]
            : [];
      return {
        code: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(JSON.stringify(value)),
      };
    });
    const gitTransport: Transport = (command) =>
      execute({
        ...command,
        argv: command.argv.map((arg) =>
          arg === "https://github.com/example/repo.git"
            ? `file://${f.project}`
            : arg,
        ),
      });
    const runtime = new ReviewRuntime(f.input, f.store, {
      github,
      gitTransport,
    });
    const origin = f.actor();
    const before = await sourceFingerprint(f.project);
    const started = JSON.parse(await runtime.start("#1", origin, false, brief));
    const coordinator = f.actor(started.session, "review");
    await waitFor(() => f.prompts.some((p) => p.session === started.session));
    expect(
      f.prompts.find((p) => p.session === started.session)!.body.parts[0].text,
    ).toContain(brief.requirements);
    expect(
      JSON.parse(await runtime.state({ action: "status" }, coordinator))
        .handoff,
    ).toEqual(brief);
    await runtime.state({ action: "prepare", context }, coordinator);
    await finish(f, runtime, coordinator, 1, "Code approved; CI green.");
    await expect(
      runtime.inspect({ kind: "evidence", evidence: "checks" }, 1, coordinator),
    ).rejects.toThrow("Completed evidence is frozen");
    const workerCount = f.creates.filter((s) => s.parentID).length;
    check = "failure";
    comment = "CI now fails";
    const resumed = JSON.parse(
      await runtime.start(`resume ${started.review}`, origin, false, {
        ...brief,
        evidence: [
          { reference: "CI/run-2", summary: "Hosted checks now fail" },
        ],
      }),
    );
    const next = f.actor(resumed.session, "review");
    const prepared = JSON.parse(
      await runtime.state(
        {
          action: "prepare",
          context: { ...context, testEvidence: "CI refreshed separately" },
        },
        next,
      ),
    );
    expect(prepared.reused).toBe(true);
    expect(prepared.round.status).toBe("evidence");
    expect(prepared.round.report).toBeUndefined();
    expect(prepared.round.evidence.checks.items[0].conclusion).toBe("failure");
    expect(prepared.round.evidence.comments.items[0].body).toBe("CI now fails");
    await expect(
      runtime.state({ action: "plan", lenses: ["unnecessary"] }, next),
    ).rejects.toThrow();
    comment = "A second comment arrived during finalization";
    await expect(
      runtime.state({ action: "complete", report: "Would be stale" }, next),
    ).rejects.toThrow("Mutable evidence changed");
    expect((await f.store.load(started.review)).lastCompleted).toBe(1);
    await runtime.state(
      {
        action: "complete",
        report:
          "Code coverage reused; CI red, integration evidence incomplete.",
      },
      next,
    );
    expect(f.creates.filter((s) => s.parentID).length).toBe(workerCount);
    expect(
      JSON.parse(await runtime.start(`status ${started.review}`, origin))
        .report,
    ).toContain("CI red");
    body = "New specification: disable cross-tenant caching entirely";
    expect(
      JSON.parse(await runtime.state({ action: "prepare", context }, next))
        .reused,
    ).toBe(false);
    await finish(f, runtime, next, 3, "Changed specification reviewed.");
    const changed = {
      ...brief,
      requirements:
        "Review authorization and token expiry as mandatory acceptance criteria.",
    };
    const again = JSON.parse(
      await runtime.start(`resume ${started.review}`, origin, false, changed),
    );
    const last = f.actor(again.session, "review");
    await waitFor(() => f.prompts.some((p) => p.session === again.session));
    expect(
      f.prompts.find((p) => p.session === again.session)!.body.parts[0].text,
    ).toContain(changed.requirements);
    expect(
      JSON.parse(await runtime.state({ action: "prepare", context }, last))
        .reused,
    ).toBe(false);
    const local = JSON.parse(
      await runtime.start("recent", f.actor(), false, brief),
    );
    const localActor = f.actor(local.session, "review");
    await runtime.state({ action: "prepare", context }, localActor);
    await finish(f, runtime, localActor, 1, "Initial local contract reviewed.");
    await runtime.state({ action: "prepare", context }, localActor);
    const localResume = JSON.parse(
      await runtime.start(`resume ${local.review}`, origin, false, changed),
    );
    await expect(
      runtime.state(
        { action: "complete", report: "Cannot reuse old requirements" },
        f.actor(localResume.session, "review"),
      ),
    ).rejects.toThrow("Review target changed");
    expect(await sourceFingerprint(f.project)).toBe(before);
  }));
