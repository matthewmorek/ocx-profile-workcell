import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const idPattern = /^[a-f0-9]{32}$/;
const oidPattern = /^[a-f0-9]{40}([a-f0-9]{24})?$/;

/** Resource ownership only. Review scope, rounds, findings and completion live in the agent's ledger. */
export interface ReviewOwner {
  format: "workcell-review-workspace-2";
  id: string;
  project: string;
  origin: string;
  originAgent: string;
  sessions: string[];
  workers: string[];
  refs: string[];
  head?: string;
  closing: boolean;
  host: string;
  pid: number;
}

async function directory(path: string): Promise<void> {
  if (dirname(path) !== path) await directory(dirname(path));
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Review directory ownership changed");
}

/** Safe worktree plumbing, separate from development hooks/copies/terminals/snapshot commits.
 * Git uses normal trusted host credentials. Native agent tools remain governed by OpenCode,
 * not this helper; their command/path permissions are not an OS sandbox.
 */
export class ReviewWorkspaces {
  private constructor(
    readonly project: string,
    readonly root: string,
  ) {}
  static async open(
    project: string,
    storage = join(homedir(), ".local/share/workcell/review-workspaces"),
  ) {
    project = await realpath(project);
    const root = join(resolve(storage), createHash("sha256").update(project).digest("hex"));
    await mkdir(root, { recursive: true, mode: 0o700 });
    await directory(root);
    const info = await lstat(root);
    if (info.uid !== process.getuid?.() || info.mode & 0o077)
      throw new Error("Review storage must be private and user-owned");
    return new ReviewWorkspaces(project, root);
  }
  paths(id: string) {
    if (!idPattern.test(id))
      throw new Error(
        "Invalid review workspace ID; close old engine reviews with the previous version",
      );
    const root = join(this.root, id);
    return {
      root,
      notes: join(root, "notes"),
      ledger: join(root, "notes/ledger.md"),
      artifacts: join(root, "artifacts"),
      checkout: join(root, "checkout"),
    };
  }
  async create(origin: string, originAgent = "build"): Promise<ReviewOwner> {
    const id = randomBytes(16).toString("hex"),
      paths = this.paths(id);
    await mkdir(paths.root, { mode: 0o700 });
    await mkdir(paths.notes, { mode: 0o700 });
    await mkdir(paths.artifacts, { mode: 0o700 });
    const owner: ReviewOwner = {
      format: "workcell-review-workspace-2",
      id,
      project: this.project,
      origin,
      originAgent,
      sessions: [],
      workers: [],
      refs: [],
      closing: false,
      host: hostname(),
      pid: process.pid,
    };
    await this.save(owner);
    return owner;
  }
  async load(id: string, allowClosing = false): Promise<ReviewOwner> {
    const paths = this.paths(id);
    await directory(paths.root);
    const file = join(paths.root, "owner.json"),
      stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 262144)
      throw new Error("Review owner file changed");
    const value = JSON.parse(await readFile(file, "utf8")) as ReviewOwner;
    if (typeof value.originAgent !== "string") throw new Error("Invalid review origin agent");
    if (typeof value.host !== "string" || !Number.isInteger(value.pid) || value.pid < 1)
      throw new Error("Invalid review process ownership");
    if (
      value.format !== "workcell-review-workspace-2" ||
      value.id !== id ||
      value.project !== this.project ||
      typeof value.origin !== "string" ||
      typeof value.closing !== "boolean" ||
      ![value.sessions, value.workers, value.refs].every(
        (a) => Array.isArray(a) && a.every((s) => typeof s === "string"),
      ) ||
      value.refs.some(
        (ref) =>
          !ref.startsWith(`refs/workcell-review/${id}/`) ||
          !oidPattern.test(ref.split("/").at(-1)!),
      ) ||
      (value.head !== undefined && !oidPattern.test(value.head))
    )
      throw new Error("Invalid review ownership; no cleanup performed");
    if (value.closing && !allowClosing) throw new Error("Review is closing; retry explicit close");
    return value;
  }
  async save(owner: ReviewOwner): Promise<void> {
    const root = this.paths(owner.id).root;
    await directory(root);
    const temp = join(root, `owner-${randomBytes(8).toString("hex")}.tmp`);
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(owner));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, join(root, "owner.json"));
  }
  async artifacts(id: string): Promise<string> {
    await this.load(id);
    const path = this.paths(id).artifacts;
    await directory(path);
    return path;
  }
  /** Serializes resource effects and artifact writes, not agent reasoning. Stale locks fail
   * closed: stop the named process and inspect/remove only operation.lock before retrying. */
  async use<T>(
    id: string,
    operation: (owner: ReviewOwner) => Promise<T>,
    allowClosing = false,
  ): Promise<T> {
    await directory(this.paths(id).root);
    const lock = join(this.paths(id).root, "operation.lock");
    let handle;
    for (let attempt = 0; ; attempt++) {
      try {
        handle = await open(lock, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt === 100)
          throw new Error(
            "Review resource busy. Retry after its operation finishes; after a crash inspect operation.lock before removing it.",
          );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      await handle.writeFile(`pid=${process.pid}\n`);
      const owner = await this.load(id, allowClosing);
      if (owner.host !== hostname())
        throw new Error("Resume or close on the workspace's owning host");
      if (owner.pid !== process.pid) {
        try {
          process.kill(owner.pid, 0);
          throw new Error(
            "Another OpenCode process owns this workspace; stop it before resuming or closing here",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        owner.pid = process.pid;
        await this.save(owner);
      }
      return await operation(owner);
    } finally {
      await handle.close();
      await rm(lock, { force: true });
    }
  }
  private async git(args: string[], cwd = this.project): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    // Select this repository, not an inherited launcher's Git directory/index. Keep host auth/config.
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_NAMESPACE",
    ])
      delete env[key];
    const result = await exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "submodule.recurse=false",
        ...args,
      ],
      {
        cwd,
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
        env,
      },
    ).catch(() => {
      throw new Error(
        `Review Git ${args[0]} failed; inspect repository access/state with native Git`,
      );
    });
    return result.stdout;
  }
  private async checkoutOptions(): Promise<string[]> {
    // Owned checkouts contain raw blobs. Apply these overrides to add, explicit status, and
    // remove: worktree remove launches its own status subprocess and otherwise re-enables filters.
    const config = await this.git(["config", "--null", "--list", "--name-only"]);
    const filters = [
      ...new Set(
        config
          .split("\0")
          .filter((key) => /^filter\..*\.(clean|smudge|process|required)$/s.test(key))
          .map((key) => key.replace(/\.[^.]+$/, "")),
      ),
    ];
    if (filters.some((key) => !/^filter\.[A-Za-z0-9_.-]+$/.test(key)))
      throw new Error(
        "Unsupported filter name; refusing checkout rather than executing a configured filter",
      );
    return [
      "-c",
      "core.sparseCheckout=false",
      ...filters.flatMap((key) => [
        "-c",
        `${key}.clean=`,
        "-c",
        `${key}.smudge=`,
        "-c",
        `${key}.process=`,
        "-c",
        `${key}.required=false`,
      ]),
    ];
  }
  private async checkCheckout(owner: ReviewOwner, discard: boolean): Promise<void> {
    const checkout = this.paths(owner.id).checkout;
    await directory(checkout);
    const dotgit = join(checkout, ".git"),
      info = await lstat(dotgit);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Checkout ownership changed");
    const common = await realpath(
      resolve(this.project, (await this.git(["rev-parse", "--git-common-dir"])).trim()),
    );
    const target = (await readFile(dotgit, "utf8")).trim().replace(/^gitdir: /, "");
    if (
      dirname(target) !== join(common, "worktrees") ||
      (await realpath(target)) !== target ||
      (await readFile(join(target, "gitdir"), "utf8")).trim() !== dotgit
    )
      throw new Error("Checkout is not owned by this review repository");
    if (!discard) {
      const options = await this.checkoutOptions();
      if (
        (
          await this.git(
            [...options, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
            checkout,
          )
        ).trim() ||
        (await this.git(["rev-parse", "HEAD"], checkout)).trim() !== owner.head
      )
        throw new Error("Checkout changed; explicit discard is required");
    }
  }
  /** Caller holds use(). The agent resolves/validates metadata with native gh first. */
  async pin(owner: ReviewOwner, head: string, pr?: number, discard = false): Promise<void> {
    if (
      !oidPattern.test(head) ||
      (pr !== undefined && (!Number.isSafeInteger(pr) || pr < 1 || pr > 2147483647))
    )
      throw new Error("Provide a full commit SHA and optional positive PR number");
    const ref = `refs/workcell-review/${owner.id}/${head}`;
    if (pr !== undefined) {
      // Fetch may race a force-push. Never fetch into an already-retained baseline ref.
      const staging = `refs/workcell-review/${owner.id}/staging/${head}`;
      if (!owner.refs.includes(staging)) owner.refs.push(staging);
      await this.save(owner);
      try {
        await this.git([
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "origin",
          `+refs/pull/${pr}/head:${staging}`,
        ]);
        if ((await this.git(["rev-parse", "--verify", `${staging}^{commit}`])).trim() !== head)
          throw new Error("PR head moved; resolve metadata again before pinning");
        if (!owner.refs.includes(ref)) owner.refs.push(ref);
        await this.save(owner);
        // Retain the verified object before releasing its staging ref, including across GC.
        await this.git(["update-ref", ref, head]);
      } finally {
        await this.git(["update-ref", "-d", staging]);
        owner.refs = owner.refs.filter((entry) => entry !== staging);
        await this.save(owner);
      }
    }
    await this.git(["cat-file", "-e", `${head}^{commit}`]);
    const checkout = this.paths(owner.id).checkout;
    let exists = true;
    try {
      await lstat(checkout);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    if (exists) {
      await this.checkCheckout(owner, discard);
      await this.git([
        ...(await this.checkoutOptions()),
        "worktree",
        "remove",
        ...(discard ? ["--force"] : []),
        checkout,
      ]);
    }
    if (!owner.refs.includes(ref)) owner.refs.push(ref);
    await this.save(owner);
    if (pr === undefined) await this.git(["update-ref", ref, head]);
    await this.git([
      ...(await this.checkoutOptions()),
      "worktree",
      "add",
      "--detach",
      checkout,
      head,
    ]);
    owner.head = head;
    await this.save(owner);
  }
  /** Caller has stopped ordinary delegations. No commits, hooks, terminal, copies or branch deletion. */
  async remove(owner: ReviewOwner, discard: boolean): Promise<void> {
    const checkout = this.paths(owner.id).checkout;
    let exists = true;
    try {
      await lstat(checkout);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    if (exists) {
      await this.checkCheckout(owner, discard);
      await this.git([
        ...(await this.checkoutOptions()),
        "worktree",
        "remove",
        ...(discard ? ["--force"] : []),
        checkout,
      ]);
    }
    for (const ref of owner.refs) await this.git(["update-ref", "-d", ref]);
    await rm(this.paths(owner.id).root, { recursive: true });
  }
}
