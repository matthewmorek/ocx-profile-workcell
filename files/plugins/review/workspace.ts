import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  fingerprint,
  oidSchema,
  sameRepository,
  type Pins,
  type Scope,
  type Snapshot,
} from "./contracts";
import {
  repositoryFromRemote,
  safePath,
  safeRevision,
  type PullRequest,
} from "./github";
import {
  execute,
  git,
  gitEnvironment,
  gitOptions,
  type Transport,
} from "./process";
import { canonicalDirectory } from "./store";

const limitations = [
  "No code, tests, hooks, filters, LFS downloads, or submodule updates are executed.",
];
const excluded = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
]);
const lockfile =
  /(?:^|\/)(?:bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)$/;

async function resolveCommit(
  project: string,
  expression: string,
): Promise<string> {
  safeRevision(expression);
  return oidSchema.parse(
    (
      await git(project, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${expression}^{commit}`,
      ])
    ).trim(),
  );
}
async function readLocal(
  project: string,
  path: string,
): Promise<{ kind: "file" | "symlink"; content: string }> {
  safePath(path);
  const parts = path.split("/");
  if (parts.length > 1)
    await canonicalDirectory(join(project, ...parts.slice(0, -1)));
  const full = join(project, path),
    info = await lstat(full);
  if (info.isSymbolicLink())
    return { kind: "symlink", content: await readlink(full) };
  if (!info.isFile() || info.size > 1_048_576)
    throw new Error("Unsupported or oversized local file; narrow the scope");
  const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return {
      kind: "file",
      content: (await file.readFile()).toString("base64"),
    };
  } finally {
    await file.close();
  }
}
async function selectedPaths(
  project: string,
  paths: string[],
): Promise<string[]> {
  const selected = new Set<string>();
  async function visit(path: string, explicit: boolean) {
    safePath(path);
    const info = await lstat(join(project, path));
    if (info.isDirectory()) {
      await canonicalDirectory(join(project, path));
      for (const child of (await readdir(join(project, path))).sort()) {
        const next = `${path}/${child}`;
        if (!excluded.has(child) && !lockfile.test(next))
          await visit(next, false);
      }
    } else if (explicit || !lockfile.test(path)) selected.add(path);
    if (selected.size > 1000)
      throw new Error("Local scope exceeds 1000 files; narrow the scope");
  }
  for (const path of paths) await visit(path, true);
  return [...selected].sort();
}

/** Source operations are read-only. Content is base64; symlink targets/submodule OIDs are metadata. */
export async function localSnapshot(
  project: string,
  scope: Scope,
  contextPaths: string[] = [],
): Promise<{
  snapshot?: Snapshot;
  base: string;
  head: string;
  diffBase?: string;
  initialCommit?: boolean;
}> {
  let head: string;
  try {
    head = await resolveCommit(project, "HEAD");
  } catch {
    throw new Error(
      "Local review requires an existing HEAD commit; unborn repositories are not supported yet",
    );
  }
  if (scope.kind === "pr") throw new Error("PR scope requires remote pins");
  if (scope.kind === "paths") {
    const files: Snapshot["files"] = Object.create(null);
    let bytes = 0;
    for (const path of await selectedPaths(project, [
      ...scope.paths,
      ...contextPaths,
    ])) {
      files[path] = await readLocal(project, path);
      bytes += Buffer.byteLength(files[path].content);
      if (bytes > 8_388_608)
        throw new Error("Snapshot limit exceeded; narrow the scope");
    }
    return {
      base: head,
      head,
      snapshot: {
        files,
        patch: "",
        mutable: true,
        contextPaths,
        fingerprint: fingerprint({ head, files }),
        limitations: [
          ...limitations,
          "Directory selection excludes dependencies, generated directories, and lockfiles unless explicitly selected.",
        ],
      },
    };
  }
  if (scope.kind === "staged") {
    const index = await git(project, ["ls-files", "--stage", "-z"]);
    const selected = new Set([
      ...(
        await git(project, [
          "diff",
          "--cached",
          "--no-ext-diff",
          "--no-textconv",
          "--name-only",
          "-z",
          "--",
        ])
      )
        .split("\0")
        .filter(Boolean),
      ...contextPaths.map(safePath),
    ]);
    const files: Snapshot["files"] = Object.create(null);
    let bytes = 0;
    for (const entry of index.split("\0").filter(Boolean)) {
      const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
      if (!match || match[3] !== "0")
        throw new Error("Resolve index conflicts before reviewing");
      const path = safePath(match[4]),
        oid = oidSchema.parse(match[2]);
      if (!selected.has(path)) continue;
      if (match[1] === "160000")
        files[path] = { kind: "submodule", content: oid };
      else {
        const size = Number(
          (await git(project, ["cat-file", "-s", oid])).trim(),
        );
        if (size > 1_048_576)
          throw new Error("Staged file exceeds review limit");
        // git returns UTF-8 here only for patches; blobs must preserve arbitrary bytes.
        const blob = await rawBlob(project, oid);
        files[path] = {
          kind: match[1] === "120000" ? "symlink" : "file",
          content:
            match[1] === "120000"
              ? blob.toString("utf8")
              : blob.toString("base64"),
        };
      }
      bytes += Buffer.byteLength(files[path].content);
      if (bytes > 8_388_608)
        throw new Error("Snapshot limit exceeded; narrow the scope");
    }
    const patch = await git(project, [
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--",
      ".",
    ]);
    const after = await git(project, ["ls-files", "--stage", "-z"]);
    if (index !== after || head !== (await resolveCommit(project, "HEAD")))
      throw new Error("Index changed during capture");
    return {
      base: head,
      head,
      snapshot: {
        files,
        patch,
        mutable: true,
        contextPaths,
        fingerprint: fingerprint({ head, index, patch }),
        limitations,
      },
    };
  }
  let base: string, target: string;
  if (scope.kind === "recent") {
    const parents = (
      await git(project, ["rev-list", "--parents", "-n", "1", head])
    )
      .trim()
      .split(" ");
    target = head;
    base = parents[1] ?? head;
    return {
      base,
      head: target,
      diffBase: parents[1],
      initialCommit: !parents[1],
    };
  }
  safeRevision(scope.expression);
  const range = /^(.*?)\.(\.\.?)(.*?)$/.exec(scope.expression);
  if (range) {
    base = await resolveCommit(project, range[1] || "HEAD");
    target = await resolveCommit(project, range[3] || "HEAD");
    if (range[2] === "..")
      base = oidSchema.parse(
        (await git(project, ["merge-base", base, target])).trim(),
      );
  } else {
    // A single committed revision means that commit's change, not the caller's dirty checkout.
    target = await resolveCommit(project, scope.expression);
    const parents = (
      await git(project, ["rev-list", "--parents", "-n", "1", target])
    )
      .trim()
      .split(" ");
    base = parents[1] ?? target;
    return {
      base,
      head: target,
      diffBase: parents[1],
      initialCommit: !parents[1],
    };
  }
  return { base, head: target, diffBase: base, initialCommit: false };
}

async function rawBlob(cwd: string, oid: string): Promise<Buffer> {
  oidSchema.parse(oid);
  const result = await execute({
    argv: ["git", ...gitOptions, "cat-file", "blob", oid],
    cwd,
    env: gitEnvironment(),
    maxBytes: 1_048_576,
  });
  if (result.code) throw new Error("Pinned blob unavailable");
  return result.stdout;
}

/** All writes, fetches, refs, and checkouts stay in a private repository; no shared object alternates. */
export class ReviewWorkspace {
  readonly bare: string;
  readonly checkout: string;
  constructor(
    private readonly directory: string,
    private readonly transport: Transport = execute,
  ) {
    this.bare = join(directory, "git");
    this.checkout = join(directory, "checkout");
  }
  private async validate(): Promise<void> {
    await canonicalDirectory(this.directory);
    await canonicalDirectory(this.bare);
    await this.checkInfrastructure(this.bare);
    let markerPath = join(this.bare, "review-config");
    try {
      await lstat(markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      markerPath = join(this.directory, "git-config");
    }
    const marker = await lstat(markerPath);
    if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1)
      throw new Error("Private Git configuration marker changed");
    const config = await readFile(join(this.bare, "config"), "utf8");
    const expected = await readFile(markerPath, "utf8");
    if (config !== expected)
      throw new Error("Private Git configuration changed");
    for (const path of ["objects", "refs", "hooks"])
      await canonicalDirectory(join(this.bare, path));
    for (const path of [
      "objects/info/alternates",
      "objects/info/http-alternates",
    ]) {
      try {
        await lstat(join(this.bare, path));
        throw new Error("Private Git alternates are forbidden");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  private async checkInfrastructure(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("Private Git infrastructure contains a symlink");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await this.checkInfrastructure(path);
      else if (!entry.isFile() || (await lstat(path)).nlink !== 1)
        throw new Error("Private Git infrastructure ownership changed");
    }
  }
  async initialize(): Promise<void> {
    await canonicalDirectory(this.directory);
    let exists = true;
    try {
      await lstat(this.bare);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    if (exists) {
      await this.validate();
      return;
    }
    // Publish repository + configuration marker together. A killed initialization leaves only
    // unpublished scratch under the marker-verified review directory; retry never reuses it.
    const staging = await mkdtemp(join(this.directory, "git-opening-"));
    try {
      await git(
        this.directory,
        ["init", "--bare", "--template=", staging],
        this.transport,
      );
      await mkdir(join(staging, "hooks"), { recursive: true, mode: 0o700 });
      await writeFile(
        join(staging, "review-config"),
        await readFile(join(staging, "config")),
        { mode: 0o600, flag: "wx" },
      );
      await rename(staging, this.bare);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  private async run(args: string[]): Promise<string> {
    await this.validate();
    return git(this.bare, args, this.transport);
  }
  async verifyLocalRepository(
    project: string,
    scope: Extract<Scope, { kind: "pr" }>,
  ): Promise<void> {
    const remote = (
      await git(project, ["config", "--get", "remote.origin.url"])
    ).trim();
    if (!sameRepository(scope.repository, repositoryFromRemote(remote)))
      throw new Error("Open this PR's local project instead");
  }
  async pinPR(
    project: string,
    scope: Extract<Scope, { kind: "pr" }>,
    pr: PullRequest,
    round: number,
  ): Promise<Pins> {
    await this.verifyLocalRepository(project, scope);
    if (
      pr.number !== scope.number ||
      !sameRepository(
        scope.repository,
        repositoryFromRemote(pr.base.repo.html_url),
      )
    )
      throw new Error("PR identity mismatch");
    oidSchema.parse(pr.base.sha);
    oidSchema.parse(pr.head.sha);
    const url = `https://${scope.repository.host}/${scope.repository.owner}/${scope.repository.name}.git`;
    await this.run([
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      url,
      `+${pr.base.sha}:refs/review/pending-base`,
      `+refs/pull/${scope.number}/head:refs/review/pending-head`,
    ]);
    const base = await this.resolve("refs/review/pending-base"),
      head = await this.resolve("refs/review/pending-head");
    if (base !== pr.base.sha || head !== pr.head.sha)
      throw new Error("PR moved while fetching; refresh metadata and retry");
    return this.pin(base, head, round);
  }
  async pinLocal(
    project: string,
    base: string,
    head: string,
    round: number,
  ): Promise<Pins> {
    oidSchema.parse(base);
    oidSchema.parse(head);
    // No clone --shared/--local: fetch copies reachable objects into exclusively owned storage.
    await this.run([
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      `file://${project}`,
      base,
      head,
    ]);
    return this.pin(base, head, round);
  }
  private async pin(base: string, head: string, round: number): Promise<Pins> {
    if (!Number.isSafeInteger(round) || round < 1)
      throw new Error("Invalid round");
    const mergeBase = oidSchema.parse(
      (await this.run(["merge-base", base, head])).trim(),
    );
    for (const [name, oid] of Object.entries({ base, head, mergeBase }))
      await this.run(["update-ref", `refs/review/round-${round}/${name}`, oid]);
    return { base, head, mergeBase };
  }
  private async resolve(ref: string): Promise<string> {
    return oidSchema.parse(
      (await this.run(["rev-parse", "--verify", `${ref}^{commit}`])).trim(),
    );
  }
  async hasPins(pins: Pins): Promise<boolean> {
    try {
      for (const oid of Object.values(pins)) {
        oidSchema.parse(oid);
        await this.run(["cat-file", "-e", `${oid}^{commit}`]);
      }
      return true;
    } catch {
      return false;
    }
  }
  async isAncestor(base: string, head: string): Promise<boolean> {
    oidSchema.parse(base);
    oidSchema.parse(head);
    const mergeBase = (await this.run(["merge-base", base, head])).trim();
    return mergeBase === base;
  }
  async checkoutHead(head: string): Promise<void> {
    oidSchema.parse(head);
    if (await this.checkoutExists()) {
      await this.assertClean();
      await this.run(["worktree", "remove", this.checkout]);
    }
    await this.run(["worktree", "add", "--detach", this.checkout, head]);
    await this.assertClean(head);
  }
  async assertClean(head?: string): Promise<void> {
    await this.validate();
    await canonicalDirectory(this.checkout);
    const marker = await lstat(join(this.checkout, ".git"));
    if (!marker.isFile() || marker.isSymbolicLink())
      throw new Error("Checkout ownership changed");
    const gitdir = (await readFile(join(this.checkout, ".git"), "utf8")).trim();
    const expected = join(this.bare, "worktrees", "checkout");
    if (
      gitdir !== `gitdir: ${expected}` ||
      (await realpath(expected)) !== expected
    )
      throw new Error("Checkout Git ownership changed");
    if (
      (
        await git(this.checkout, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignored=matching",
          "--ignore-submodules=all",
        ])
      ).trim()
    )
      throw new Error("Checkout changed; explicit discard is required");
    for (const entry of await this.tree(
      await resolveCommit(this.checkout, "HEAD"),
    )) {
      if (entry.kind !== "submodule") continue;
      const path = join(this.checkout, entry.path);
      await canonicalDirectory(path);
      if ((await readdir(path)).length)
        throw new Error(
          "Submodule content appeared; explicit discard is required",
        );
    }
    if (head && (await resolveCommit(this.checkout, "HEAD")) !== head)
      throw new Error("Checkout head changed");
  }
  async diff(pins: Pins, deltaBase?: string, initial = false): Promise<string> {
    if (initial)
      return this.run([
        "show",
        "--format=",
        "--root",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        pins.head,
        "--",
      ]);
    const base = oidSchema.parse(deltaBase ?? pins.mergeBase);
    return this.run([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      base,
      oidSchema.parse(pins.head),
      "--",
    ]);
  }
  async tree(
    head: string,
  ): Promise<
    { path: string; oid: string; kind: "file" | "symlink" | "submodule" }[]
  > {
    oidSchema.parse(head);
    const output = await this.run(["ls-tree", "-r", "-z", head]);
    return output
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const match = /^(\d+) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(
          entry,
        );
        if (!match) throw new Error("Unsupported Git tree entry");
        return {
          path: safePath(match[3]),
          oid: oidSchema.parse(match[2]),
          kind:
            match[1] === "120000"
              ? "symlink"
              : match[1] === "160000"
                ? "submodule"
                : "file",
        };
      });
  }
  async file(
    head: string,
    path: string,
  ): Promise<{ kind: "file" | "symlink" | "submodule"; content: string }> {
    safePath(path);
    const entry = (await this.tree(head)).find((entry) => entry.path === path);
    if (!entry) throw new Error("File is not in the pinned tree");
    if (entry.kind === "submodule")
      return { kind: entry.kind, content: entry.oid };
    await this.validate();
    const blob = await rawBlob(this.bare, entry.oid);
    return {
      kind: entry.kind,
      content: blob.toString(entry.kind === "file" ? "base64" : "utf8"),
    };
  }
  async history(head: string, path?: string): Promise<string> {
    oidSchema.parse(head);
    if (path) safePath(path);
    return this.run([
      "log",
      "--no-decorate",
      "--format=%H %s",
      "-n",
      "50",
      head,
      "--",
      ...(path ? [path] : []),
    ]);
  }
  async dispose(discard: boolean, expectedHead?: string): Promise<void> {
    await this.validate();
    if (await this.checkoutExists()) {
      // Discard allows content changes, never changed checkout ownership.
      if (!discard) await this.assertClean(expectedHead);
      else {
        await canonicalDirectory(this.checkout);
        const dotgit = join(this.checkout, ".git");
        if (
          (await lstat(dotgit)).isSymbolicLink() ||
          (await readFile(dotgit, "utf8")).trim() !==
            `gitdir: ${join(this.bare, "worktrees", "checkout")}`
        )
          throw new Error("Checkout ownership changed");
      }
      await this.run([
        "worktree",
        "remove",
        ...(discard ? ["--force"] : []),
        this.checkout,
      ]);
    }
    // Storage is removed with the manifest after sessions have drained; partial retries keep config/pins.
  }
  private async checkoutExists(): Promise<boolean> {
    try {
      await lstat(this.checkout);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

export async function resolveLocalScope(
  project: string,
  scope: Scope,
): Promise<Scope> {
  if (scope.kind !== "revision") return scope;
  // Existing files win ambiguity without treating options or traversal as paths.
  try {
    safePath(scope.expression);
    await lstat(join(project, scope.expression));
    return { kind: "paths", paths: [scope.expression] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      safeRevision(scope.expression);
    }
  }
  return scope;
}
