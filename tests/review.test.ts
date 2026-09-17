import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import {
  GitHub,
  ReviewCore,
  ReviewStore,
  fingerprint,
  newId,
  parseScope,
  repositoryFromRemote,
  safePath,
  type Actor,
  type Candidate,
} from "../files/plugins/review/index";
import { execute, git, type Transport } from "../files/plugins/review/process";

const roots: string[] = [];
const context = {
  specification: "Fixture contract",
  instructions: "Review evidence only",
  testEvidence: "Not run",
  risk: "state",
};
const repository = { host: "github.com", owner: "example", name: "repo" };
const drained = {
  drain: async () => {},
  deliver: async () => {},
  retire: async () => {},
};
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const parent = join(import.meta.dir, "../.tmp");
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(join(parent, "review-")));
  roots.push(root);
  const project = join(root, "source");
  await mkdir(project);
  await git(project, ["init", "--template=", "-b", "main"]);
  await writeFile(join(project, "file.txt"), "base\n");
  await git(project, ["add", "file.txt"]);
  await commit(project, "base");
  const base = (await git(project, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(project, "file.txt"), "head\n");
  await git(project, ["add", "file.txt"]);
  await commit(project, "head");
  const head = (await git(project, ["rev-parse", "HEAD"])).trim();
  const store = await ReviewStore.open(project, join(root, "reviews"));
  const actor: Actor = { project, session: "initiator", agent: "build" };
  const coordinator: Actor = {
    project,
    session: "coordinator",
    agent: "review",
  };
  const core = new ReviewCore(store);
  return { root, project, base, head, store, actor, coordinator, core };
}
async function commit(project: string, message: string) {
  await git(project, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    message,
  ]);
}
async function treeFingerprint(root: string): Promise<string> {
  const entries: unknown[] = [];
  async function visit(path: string) {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name),
        info = await lstat(full);
      if (info.isDirectory()) await visit(full);
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
async function begin(
  f: Awaited<ReturnType<typeof fixture>>,
  scope: Parameters<ReviewCore["start"]>[2] = { kind: "recent" },
) {
  const m = await f.core.start(f.actor, "request", scope);
  await f.core.bind(m.id, f.actor, f.coordinator.session);
  const prepared = await f.core.prepare(m.id, f.coordinator, context);
  return { id: m.id, ...prepared };
}
async function finish(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  round: number,
  session: string,
) {
  await f.core.dispatch(id, f.coordinator, [
    { session, lens: "Comprehensive" },
  ]);
  await f.core.submit(id, { ...f.actor, agent: "reviewer", session }, round, {
    outcome: "succeeded",
    coverage: ["Changed behavior and dependencies"],
    limitations: [],
    candidates: [],
  });
  await f.core.adjudicate(id, f.coordinator, []);
  return f.core.complete(
    id,
    f.coordinator,
    "No supported findings; tests not run.",
  );
}

test("scope parsing rejects transport/path injection and resolves repository identity", () => {
  expect(parseScope("", repository)).toEqual({ kind: "staged" });
  expect(parseScope("#12", repository)).toEqual({
    kind: "pr",
    repository,
    number: 12,
  });
  expect(parseScope("pr 12", repository)).toEqual({
    kind: "pr",
    repository,
    number: 12,
  });
  expect(parseScope("pr:12", repository)).toEqual({
    kind: "pr",
    repository,
    number: 12,
  });
  expect(
    parseScope("https://github.com/example/repo/pull/12", repository),
  ).toEqual({ kind: "pr", repository, number: 12 });
  expect(parseScope("12", repository)).toEqual({
    kind: "revision",
    expression: "12",
  });
  expect(parseScope("12")).toEqual({ kind: "revision", expression: "12" });
  expect(() => parseScope("pr 12")).toThrow();
  expect(parseScope("recent")).toEqual({ kind: "recent" });
  expect(repositoryFromRemote("git@github.com:example/repo.git")).toEqual(
    repository,
  );
  expect(parseScope("HEAD~2...HEAD")).toEqual({
    kind: "revision",
    expression: "HEAD~2...HEAD",
  });
  for (const input of [
    "--upload-pack=evil",
    "https://github.com/else/repo/pull/1",
    "HEAD;touch bad",
    "https://github.com/example/repo/pull/1?x=y",
    "pr 0",
    "pr 12 --repo other/repo",
    "pr 12;touch bad",
  ])
    expect(() => parseScope(input, repository)).toThrow();
  for (const path of [
    "../secret",
    "a/../../secret",
    "/etc/passwd",
    ".git/config",
    "a\\b",
    "a\0b",
  ])
    expect(() => safePath(path)).toThrow();
});

test("GitHub transport is GET-only, endpoint-bound, validated and truthfully paginated", async () => {
  const calls: string[][] = [];
  const transport: Transport = async ({ argv }) => {
    calls.push(argv);
    return {
      code: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from(
        JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id }))),
      ),
    };
  };
  const github = new GitHub(import.meta.dir, transport);
  const result = await github.evidence(
    repository,
    12,
    "a".repeat(40),
    "comments",
    2,
  );
  expect(result.availability).toBe("available");
  if (result.availability !== "available")
    throw new Error("Expected available paginated evidence");
  expect(result.items).toHaveLength(200);
  expect(result.truncated).toBe(true);
  expect(calls).toEqual(
    [1, 2].map((page) => [
      "gh",
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      `repos/example/repo/issues/12/comments?per_page=100&page=${page}`,
    ]),
  );
  await expect(
    github.evidence(repository, 12, "bad", "comments"),
  ).rejects.toThrow();
  await expect(
    github.evidence(repository, 12, "a".repeat(40), "graphql" as never),
  ).rejects.toThrow();
  expect(calls).toHaveLength(2);
  await expect(github.metadata(repository, 12)).rejects.toThrow();
  const interrupted = new GitHub(import.meta.dir, async ({ argv }) =>
    argv.at(-1)?.endsWith("page=1")
      ? {
          code: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(
            JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id }))),
          ),
        }
      : {
          code: 1,
          stderr: Buffer.from("gh: unavailable (HTTP 503)"),
          stdout: Buffer.alloc(0),
        },
  );
  const missing = await interrupted.evidence(
    repository,
    12,
    "a".repeat(40),
    "comments",
    2,
  );
  expect(missing.availability).toBe("unavailable");
  expect(missing).not.toHaveProperty("items");
  expect(missing).toMatchObject({
    failure: { category: "service-unavailable", httpStatus: 503 },
  });
  expect(Number.isFinite(Date.parse(missing.checkedAt))).toBe(true);
});

test("initial commits, explicit ranges and staged dependency reads preserve scope semantics", async () => {
  const f = await fixture();
  const initial = await begin(f, { kind: "revision", expression: f.base });
  expect(
    await f.core.inspect(initial.id, f.coordinator, 1, { kind: "diff" }),
  ).toContain("+base");
  await f.core.close(initial.id, f.actor, drained);
  const m = await f.core.start(f.actor, "range", {
    kind: "revision",
    expression: `${f.base}..${f.head}`,
  });
  await f.core.bind(m.id, f.actor, f.coordinator.session);
  await f.core.prepare(m.id, f.coordinator, context);
  expect(
    await f.core.inspect(m.id, f.coordinator, 1, { kind: "diff" }),
  ).toContain("+head");
  const staged = await f.core.start(f.actor, "staged", { kind: "staged" });
  await f.core.bind(staged.id, f.actor, f.coordinator.session);
  await f.core.prepare(staged.id, f.coordinator, context);
  await writeFile(join(f.project, "file.txt"), "unstaged dependency edit");
  expect(
    await f.core.inspect(staged.id, f.coordinator, 1, {
      kind: "file",
      path: "file.txt",
    }),
  ).toEqual({
    kind: "file",
    content: Buffer.from("head\n").toString("base64"),
  });
});

test("durable authorization, idempotency, independent slots, adjudication and completed baseline", async () => {
  const f = await fixture(),
    { id, round } = await begin(f);
  expect((await f.core.start(f.actor, "request", { kind: "recent" })).id).toBe(
    id,
  );
  await expect(
    f.core.status(id, { ...f.actor, project: f.root }),
  ).rejects.toThrow();
  await expect(
    f.core.dispatch(
      id,
      f.coordinator,
      Array.from({ length: 5 }, (_, i) => ({
        lens: `risk${i}`,
        session: `worker${i}`,
      })),
    ),
  ).rejects.toThrow();
  await f.core.dispatch(id, f.coordinator, [
    { lens: "behavior", session: "worker1" },
    { lens: "security", session: "worker2" },
  ]);
  const worker = { ...f.actor, agent: "reviewer", session: "worker1" };
  await expect(f.core.status(id, worker)).rejects.toThrow();
  await expect(
    f.core.submit(id, worker, 1, {
      outcome: "succeeded",
      coverage: ["all"],
      limitations: [],
      candidates: [],
      session: "worker2",
    } as never),
  ).rejects.toThrow();
  expect(await f.core.assignment(id, worker, round.number)).not.toHaveProperty(
    "slots",
  );
  await expect(f.core.prepare(id, f.coordinator, context)).rejects.toThrow();
  const candidate: Candidate = {
    id: newId(),
    rootCause: "Missing guard",
    revision: f.head,
    path: "file.txt",
    line: 1,
    scenario: "Bad input fails",
    evidence: "Pinned file",
    severity: "Major",
    confidence: 1,
    contract: "Reject bad input",
    remedy: "Add guard",
  };
  await f.core.submit(id, worker, 1, {
    outcome: "succeeded",
    coverage: ["behavior"],
    limitations: [],
    candidates: [candidate],
  });
  await expect(f.core.complete(id, f.coordinator, "report")).rejects.toThrow();
  await f.core.submit(id, { ...worker, session: "worker2" }, 1, {
    outcome: "succeeded",
    coverage: ["security"],
    limitations: [],
    candidates: [],
  });
  await expect(f.core.complete(id, f.coordinator, "report")).rejects.toThrow();
  await f.core.adjudicate(id, f.coordinator, [
    {
      candidate: candidate.id,
      disposition: "accepted",
      reason: "Reproduced from pinned evidence",
    },
  ]);
  await f.core.complete(id, f.coordinator, "Supported finding");
  const reopened = await ReviewStore.open(f.project, join(f.root, "reviews"));
  expect((await reopened.discover())[0].lastCompleted).toBe(1);
  expect((await f.core.prepare(id, f.coordinator, context)).reused).toBe(true);
  expect((await reopened.load(id)).findings[0].status).toBe("open");
});

test("private Git keeps source index, refs, objects and dirty files unchanged; symlinks are metadata", async () => {
  const f = await fixture();
  await writeFile(join(f.project, "file.txt"), "staged\n");
  await git(f.project, ["add", "file.txt"]);
  await writeFile(join(f.project, "file.txt"), "unstaged\n");
  await writeFile(join(f.project, "untracked"), "keep");
  await symlink("/etc/passwd", join(f.project, "escape"));
  await git(f.project, ["add", "escape"]);
  const beforeGit = await treeFingerprint(join(f.project, ".git"));
  const { id } = await begin(f, { kind: "staged" });
  expect(
    await f.core.inspect(id, f.coordinator, 1, {
      kind: "file",
      path: "file.txt",
    }),
  ).toEqual({
    kind: "file",
    content: Buffer.from("staged\n").toString("base64"),
  });
  expect(
    await f.core.inspect(id, f.coordinator, 1, {
      kind: "file",
      path: "escape",
    }),
  ).toEqual({ kind: "symlink", content: "/etc/passwd" });
  await expect(
    f.core.inspect(id, f.coordinator, 1, { kind: "file", path: "../escape" }),
  ).rejects.toThrow();
  await finish(f, id, 1, "worker");
  await f.core.close(id, f.actor, drained);
  expect(await treeFingerprint(join(f.project, ".git"))).toBe(beforeGit);
  expect(await readFile(join(f.project, "file.txt"), "utf8")).toBe(
    "unstaged\n",
  );
  expect(await readFile(join(f.project, "untracked"), "utf8")).toBe("keep");
  await f.core.close(id, f.actor, drained);
});

test("mutable paths invalidate completion; scoped files never follow symlink ancestors", async () => {
  const f = await fixture();
  const { id } = await begin(f, { kind: "paths", paths: ["file.txt"] });
  await f.core.dispatch(id, f.coordinator, [
    { lens: "all", session: "worker" },
  ]);
  await f.core.submit(
    id,
    { ...f.actor, agent: "reviewer", session: "worker" },
    1,
    {
      outcome: "succeeded",
      coverage: ["file"],
      limitations: [],
      candidates: [],
    },
  );
  await writeFile(join(f.project, "file.txt"), "changed\n");
  await expect(f.core.complete(id, f.coordinator, "report")).rejects.toThrow();
  expect((await f.store.load(id)).lastCompleted).toBeUndefined();
  expect((await f.store.load(id)).rounds[0].freshness).toBe("stale");
  await f.core.interrupt(id, f.coordinator, drained.drain);
  const next = await f.core.prepare(id, f.coordinator, context);
  expect(next.round.basis).toBe("full");
  await symlink(f.root, join(f.project, "outside"));
  const second = await f.core.start(f.actor, "second", {
    kind: "paths",
    paths: ["outside/source/file.txt"],
  });
  await f.core.bind(second.id, f.actor, "other-coordinator");
  await expect(
    f.core.prepare(
      second.id,
      { ...f.coordinator, session: "other-coordinator" },
      context,
    ),
  ).rejects.toThrow();
});

test("restart interrupts unknown work, retains successful slots, and serializes operations", async () => {
  const f = await fixture(),
    { id } = await begin(f);
  await f.core.dispatch(id, f.coordinator, [
    { lens: "a", session: "one" },
    { lens: "b", session: "two" },
  ]);
  await f.core.submit(
    id,
    { ...f.actor, agent: "reviewer", session: "one" },
    1,
    { outcome: "succeeded", coverage: ["a"], limitations: [], candidates: [] },
  );
  await f.store.recover(id, async () => "unknown");
  await expect(f.core.prepare(id, f.coordinator, context)).rejects.toThrow();
  await f.core.interrupt(id, f.coordinator, drained.drain);
  const m = await f.store.load(id);
  expect(m.lifecycle).toBe("interrupted");
  expect(m.lastCompleted).toBeUndefined();
  expect(m.rounds[0].slots.map((s) => s.outcome)).toEqual([
    "succeeded",
    "interrupted",
  ]);
  await f.core.retry(id, f.coordinator, [
    { slot: m.rounds[0].slots[1].id, session: "replacement" },
  ]);
  await f.core.submit(
    id,
    { ...f.actor, agent: "reviewer", session: "replacement" },
    1,
    { outcome: "succeeded", coverage: ["b"], limitations: [], candidates: [] },
  );
  await f.core.complete(id, f.coordinator, "Recovered coverage");
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const active = f.store.transaction(id, async () => {
    entered();
    await barrier;
  });
  await ready;
  await expect(f.core.close(id, f.actor, drained)).rejects.toThrow();
  await expect(f.store.recoverLock(id)).rejects.toThrow();
  release();
  await active;
  await f.core.prepare(id, f.coordinator, context);
});

test("hostile hooks, filters and symlinks never execute during private checkout or inspection", async () => {
  const f = await fixture();
  const sentinel = join(f.root, "executed");
  await mkdir(join(f.project, ".git/hooks"));
  await writeFile(
    join(f.project, ".git/hooks/post-checkout"),
    `#!/bin/sh\ntouch '${sentinel}'\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(f.project, ".gitattributes"),
    "file.txt filter=hostile diff=hostile\n",
  );
  await symlink("/etc/passwd", join(f.project, "escape"));
  await git(f.project, ["add", ".gitattributes", "escape"]);
  await commit(f.project, "hostile attributes");
  await git(f.project, [
    "config",
    "filter.hostile.smudge",
    `touch '${sentinel}'`,
  ]);
  await git(f.project, [
    "config",
    "filter.hostile.process",
    `touch '${sentinel}'`,
  ]);
  await git(f.project, [
    "config",
    "diff.hostile.textconv",
    `touch '${sentinel}'`,
  ]);
  await git(f.project, ["config", "core.fsmonitor", `touch '${sentinel}'`]);
  const before = await treeFingerprint(join(f.project, ".git"));
  const { id } = await begin(f);
  expect(
    await f.core.inspect(id, f.coordinator, 1, {
      kind: "file",
      path: "escape",
    }),
  ).toEqual({ kind: "symlink", content: "/etc/passwd" });
  await f.core.inspect(id, f.coordinator, 1, { kind: "diff" });
  await expect(lstat(sentinel)).rejects.toThrow();
  await f.core.close(id, f.actor, drained);
  expect(await treeFingerprint(join(f.project, ".git"))).toBe(before);
});

test("accessed dependency fingerprints and ownership tampering fail closed", async () => {
  const f = await fixture();
  await writeFile(join(f.project, "dependency.txt"), "contract\n");
  const { id } = await begin(f, { kind: "paths", paths: ["file.txt"] });
  expect(
    await f.core.inspect(id, f.coordinator, 1, {
      kind: "file",
      path: "dependency.txt",
    }),
  ).toEqual({
    kind: "file",
    content: Buffer.from("contract\n").toString("base64"),
  });
  await f.core.dispatch(id, f.coordinator, [
    { session: "worker", lens: "all" },
  ]);
  await f.core.submit(
    id,
    { ...f.actor, session: "worker", agent: "reviewer" },
    1,
    {
      outcome: "succeeded",
      coverage: ["file and dependency"],
      limitations: [],
      candidates: [],
    },
  );
  await writeFile(join(f.project, "dependency.txt"), "changed\n");
  await expect(f.core.complete(id, f.coordinator, "report")).rejects.toThrow();
  const owner = join(f.store.directory(id), "owner");
  await writeFile(owner, newId());
  await expect(f.core.close(id, f.actor, drained, true)).rejects.toThrow();
  expect((await lstat(f.store.directory(id))).isDirectory()).toBe(true);
});

test("stopped-owner acquisition gates and operation locks recover without losing state", async () => {
  const f = await fixture(),
    { id } = await begin(f);
  const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  const pid = child.pid;
  await child.exited;
  const partition = dirname(f.store.directory(id));
  for (const suffix of ["gate", "lock"])
    await writeFile(
      join(partition, `${id}.${suffix}`),
      JSON.stringify({ pid, host: hostname(), token: newId() }),
      { mode: 0o600 },
    );
  await f.store.recoverLock(id);
  expect((await f.core.prepare(id, f.coordinator, context)).round.number).toBe(
    2,
  );
  expect((await f.store.load(id)).lifecycle).toBe("ready");
});

test("close fails closed on dirty checkout, blocks late writes, retries drain and removes only owned resources", async () => {
  const f = await fixture(),
    { id } = await begin(f);
  await f.core.dispatch(id, f.coordinator, [
    { lens: "all", session: "worker" },
  ]);
  await writeFile(
    join(f.store.directory(id), "checkout/file.txt"),
    "unexpected",
  );
  let drains = 0;
  const adapter = {
    ...drained,
    drain: async () => {
      drains++;
      if (drains === 1) throw new Error("Worker has not stopped");
    },
  };
  await expect(f.core.close(id, f.actor, adapter)).rejects.toThrow();
  expect((await f.store.load(id)).lifecycle).toBe("cleanup_failed");
  await expect(
    f.core.submit(id, { ...f.actor, agent: "reviewer", session: "worker" }, 1, {
      outcome: "succeeded",
      coverage: ["all"],
      limitations: [],
      candidates: [],
    }),
  ).rejects.toThrow();
  await expect(f.core.close(id, f.actor, adapter)).rejects.toThrow();
  await f.core.close(id, f.actor, adapter, true);
  await expect(lstat(f.store.directory(id))).rejects.toThrow();
  expect(drains).toBe(3);
  await f.core.close(id, f.actor, adapter);
  expect(drains).toBe(3);
});

test("fork PR pins, delta reuse, force-push fallback and moved head rejection use private storage", async () => {
  const f = await fixture();
  await git(f.project, [
    "remote",
    "add",
    "origin",
    "https://github.com/example/repo.git",
  ]);
  await git(f.project, ["update-ref", "refs/pull/12/head", f.head]);
  let head = f.head;
  const github = new GitHub(f.project, async ({ argv }) => ({
    code: 0,
    stderr: Buffer.alloc(0),
    stdout: Buffer.from(
      JSON.stringify(
        argv.at(-1)?.endsWith("/pulls/12")
          ? {
              number: 12,
              title: "Fork change",
              body: null,
              state: "open",
              base: {
                sha: f.base,
                ref: "main",
                repo: {
                  full_name: "example/repo",
                  html_url: "https://github.com/example/repo",
                },
              },
              head: { sha: head },
            }
          : argv.at(-1)?.includes("check-runs")
            ? { check_runs: [] }
            : [],
      ),
    ),
  }));
  const transport: Transport = (command) =>
    execute({
      ...command,
      argv: command.argv.map((arg) =>
        arg === "https://github.com/example/repo.git"
          ? `file://${f.project}`
          : arg,
      ),
    });
  f.core = new ReviewCore(f.store, github, transport);
  const before = await treeFingerprint(join(f.project, ".git"));
  const { id } = await begin(f, { kind: "pr", repository, number: 12 });
  expect(await treeFingerprint(join(f.project, ".git"))).toBe(before);
  await finish(f, id, 1, "first");
  expect((await f.core.prepare(id, f.coordinator, context)).reused).toBe(true);
  await f.core.complete(
    id,
    f.coordinator,
    "Stored coverage, refreshed evidence.",
  );
  await writeFile(join(f.project, "file.txt"), "next\n");
  await git(f.project, ["add", "file.txt"]);
  await commit(f.project, "next");
  head = (await git(f.project, ["rev-parse", "HEAD"])).trim();
  await git(f.project, ["update-ref", "refs/pull/12/head", head]);
  const delta = await f.core.prepare(id, f.coordinator, {
    ...context,
    affectedScope: {
      reliable: true,
      rationale: "Only the fixture text and its consumers are affected",
      paths: ["file.txt"],
    },
  });
  expect(delta.round.basis).toBe("delta");
  expect(delta.round.deltaBase).toBe(f.head);
  expect(
    await f.core.inspect(id, f.coordinator, 3, { kind: "diff" }),
  ).toContain("+next");
  await finish(f, id, 3, "second");
  head = f.head;
  await git(f.project, ["update-ref", "refs/pull/12/head", head]);
  expect((await f.core.prepare(id, f.coordinator, context)).round.basis).toBe(
    "full",
  );
  head = f.base; // Metadata says a different SHA than the fetched PR head.
  await expect(f.core.prepare(id, f.coordinator, context)).rejects.toThrow();
  expect((await f.store.load(id)).lastCompleted).toBe(3);
});
