import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import {
  fingerprint,
  idSchema,
  manifestSchema,
  scopeSchema,
  handoffSchema,
  emptyHandoff,
  type Actor,
  type Manifest,
  type Scope,
  type Handoff,
} from "./contracts";

export const newId = () => randomBytes(16).toString("hex");
const lockSchema = z
  .object({
    pid: z.number().int().positive(),
    host: z.string(),
    token: idSchema,
  })
  .strict();
const tombstoneSchema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    project: z.string(),
    initiator: z.string(),
    coordinator: z.string().optional(),
    owner: idSchema,
    device: z.number(),
    inode: z.number(),
  })
  .strict();

/** Reject symlink ancestors, including host-selected scratch/project roots. */
export async function canonicalDirectory(
  path: string,
  create = false,
): Promise<string> {
  const absolute = resolve(path);
  if (absolute !== "/") await canonicalDirectory(dirname(absolute), create);
  if (create)
    await mkdir(absolute, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Directory ownership check failed");
  return realpath(absolute);
}
async function readOwned(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 16_777_216)
      throw new Error("Invalid review state file");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
async function atomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${newId()}.tmp`;
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > 16_777_216)
    throw new Error("Review state limit exceeded");
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}

/** Durable project-partitioned state. Paths and mutation callbacks are infrastructure-only APIs. */
export class ReviewStore {
  private constructor(
    readonly project: string,
    private readonly root: string,
  ) {}
  static async open(
    project: string,
    scratchRoot: string,
  ): Promise<ReviewStore> {
    const canonical = await canonicalDirectory(project);
    const scratch = resolve(scratchRoot);
    if (scratch === canonical || scratch.startsWith(`${canonical}/`))
      throw new Error("Review storage must be outside the source project");
    const root = await canonicalDirectory(
      join(scratch, fingerprint(canonical)),
      true,
    );
    const info = await lstat(root);
    if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw new Error("Scratch root must be private and owned by this user");
    return new ReviewStore(canonical, root);
  }
  directory(id: string): string {
    return join(this.root, idSchema.parse(id));
  }
  // Acquisition/recovery share a short gate so recovery cannot move a successor's live lock.
  // An interrupted gate is fail-closed and requires host inspection, not TTL deletion.
  private async gate<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const path = join(this.root, `${key}.gate`);
    let handle;
    for (let attempt = 0; ; attempt++) {
      try {
        handle = await open(path, "wx", 0o600);
        break;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          attempt === 100
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, host: hostname(), token: newId() }),
      );
      await handle.sync();
      return await operation();
    } finally {
      await handle.close();
      await rm(path);
    }
  }
  private async lock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    await canonicalDirectory(this.root);
    const path = join(this.root, `${key}.lock`);
    const token = newId();
    let handle;
    try {
      handle = await this.gate(key, () => open(path, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // No TTL stealing: a slow live owner remains exclusive. Dead lock recovery is explicit.
      throw new Error(
        "Review operation is locked; recover a stopped owner before retrying",
      );
    }
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, host: hostname(), token }),
      );
      await handle.sync();
      return await operation();
    } finally {
      await handle.close();
      const current = lockSchema.parse(JSON.parse(await readOwned(path)));
      await this.gate(key, async () => {
        if (current.token !== token)
          throw new Error("Review lock ownership changed");
        await rm(path);
      });
    }
  }
  /** Host recovery only. Never steal from a live/unknown owner; PID reuse conservatively blocks. */
  async recoverLock(id: string): Promise<void> {
    if (id !== "create") idSchema.parse(id);
    const gatePath = join(this.root, `${id}.gate`);
    try {
      const gate = lockSchema.parse(JSON.parse(await readOwned(gatePath)));
      if (gate.host !== hostname())
        throw new Error("Recovery requires the original host");
      try {
        process.kill(gate.pid, 0);
        throw new Error(
          `Review gate owner PID ${gate.pid} is still running; stop that review process before recovery`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        // Serialize dead-gate recovery separately; re-read under this guard before moving it.
        const recoveryPath = join(this.root, `${id}.recovery`);
        const recovery = await open(recoveryPath, "wx", 0o600);
        try {
          const current = lockSchema.parse(
            JSON.parse(await readOwned(gatePath)),
          );
          if (current.token !== gate.token)
            throw new Error("Gate changed; retry recovery");
          const retired = `${gatePath}.${gate.token}.retired`;
          await rename(gatePath, retired);
          await rm(retired);
        } finally {
          await recovery.close();
          await rm(recoveryPath);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          `Gate recovery stopped: ${error instanceof Error ? error.message : "invalid gate"}. Preserve ${id}; do not delete owned review storage or steal a live lock.`,
        );
    }
    return this.gate(id, async () => {
      const path = join(this.root, `${id}.lock`);
      let lock;
      try {
        lock = lockSchema.parse(JSON.parse(await readOwned(path)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (lock.host !== hostname())
        throw new Error("Lock owner is on another host");
      try {
        process.kill(lock.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        // Link-free atomic rename prevents two recoverers from unlinking a successor's lock.
        const retired = `${path}.${lock.token}.retired`;
        await rename(path, retired);
        const moved = lockSchema.parse(JSON.parse(await readOwned(retired)));
        if (moved.token !== lock.token)
          throw new Error(
            "Lock changed during recovery; retain the recovery record",
          );
        await rm(retired);
        return;
      }
      throw new Error("Review lock owner is still running");
    });
  }
  async load(id: string): Promise<Manifest> {
    const directory = await canonicalDirectory(this.directory(id));
    const m = manifestSchema.parse(
      JSON.parse(await readOwned(join(directory, "manifest.json"))),
    );
    const marker = await readOwned(join(directory, "owner"));
    if (m.id !== id || m.project !== this.project || marker !== m.owner)
      throw new Error("Review ownership mismatch");
    return m;
  }
  async save(m: Manifest): Promise<void> {
    const prior = await this.load(m.id);
    if (
      m.owner !== prior.owner ||
      m.project !== prior.project ||
      m.request !== prior.request
    )
      throw new Error("Review identity cannot change");
    m.updated = new Date().toISOString();
    await atomic(
      join(this.directory(m.id), "manifest.json"),
      manifestSchema.parse(m),
    );
  }
  async transaction<T>(
    id: string,
    operation: (manifest: Manifest) => Promise<T>,
  ): Promise<T> {
    idSchema.parse(id);
    return this.lock(id, async () => operation(await this.load(id)));
  }
  async create(
    actor: Actor,
    request: string,
    scope: Scope,
    handoff: Handoff = emptyHandoff(),
  ): Promise<Manifest> {
    if (
      actor.project !== this.project ||
      !request ||
      actor.agent === "reviewer"
    )
      throw new Error("Invalid review initiator");
    scopeSchema.parse(scope);
    handoff = handoffSchema.parse(handoff);
    return this.lock("create", async () => {
      for (const m of await this.discover()) {
        if (m.managedSessions.includes(actor.session))
          throw new Error(
            "Bound review sessions cannot start another coordinator",
          );
        if (m.initiator === actor.session && m.request === request) {
          if (fingerprint(m.scope) !== fingerprint(scope))
            throw new Error("Request already owns a different scope");
          if (fingerprint(m.handoff) !== fingerprint(handoff))
            throw new Error(
              "Request already owns a different handoff; resume with the revised requirements",
            );
          return m;
        }
      }
      const id = newId(),
        owner = newId(),
        now = new Date().toISOString();
      const m = manifestSchema.parse({
        version: 1,
        id,
        owner,
        project: this.project,
        request,
        initiator: actor.session,
        managedSessions: [],
        scope,
        handoff,
        lifecycle: "opening",
        created: now,
        updated: now,
        rounds: [],
        findings: [],
      });
      await mkdir(this.directory(id), { mode: 0o700 });
      const marker = await open(join(this.directory(id), "owner"), "wx", 0o600);
      try {
        await marker.writeFile(owner);
        await marker.sync();
      } finally {
        await marker.close();
      }
      await atomic(join(this.directory(id), "manifest.json"), m);
      return m;
    });
  }
  async discover(): Promise<Manifest[]> {
    return (await this.inventory()).reviews;
  }
  /** Corrupt/incomplete entries are visible inventory, not authority to stop unrelated sessions. */
  async inventory(): Promise<{
    reviews: Manifest[];
    issues: { id: string; state: "unavailable" | "cleanup_pending" }[];
  }> {
    const reviews: Manifest[] = [];
    const issues: { id: string; state: "unavailable" | "cleanup_pending" }[] =
      [];
    for (const entry of await readdir(this.root)) {
      if (!idSchema.safeParse(entry).success) continue;
      try {
        reviews.push(await this.load(entry));
      } catch {
        let state: "unavailable" | "cleanup_pending" = "unavailable";
        try {
          const t = tombstoneSchema.parse(
            JSON.parse(await readOwned(join(this.root, `${entry}.removed`))),
          );
          if (t.id === entry && t.project === this.project)
            state = "cleanup_pending";
        } catch {
          /* Ownership must still be verified by finishRemoval; no deletion during discovery. */
        }
        issues.push({ id: entry, state });
      }
    }
    return { reviews, issues };
  }
  /** Resume is an explicit host-authorized ownership transfer, not an authorization shortcut for tools. */
  async resume(
    id: string,
    actor: Actor,
    coordinator: string,
    drain?: (sessions: readonly string[]) => Promise<void>,
    handoff?: Handoff,
  ): Promise<Manifest> {
    if (
      actor.project !== this.project ||
      actor.agent === "reviewer" ||
      !coordinator
    )
      throw new Error("Invalid resume context");
    return this.transaction(id, async (m) => {
      if (
        (m.lifecycle === "running" && !drain) ||
        m.lifecycle === "closing" ||
        m.lifecycle === "cleanup_failed"
      )
        throw new Error("Reconcile active work before resuming");
      if (drain) {
        m.lifecycle = "interrupted";
        m.needsDrain = true;
        await this.save(m);
        await drain(m.managedSessions);
        for (const round of m.rounds) {
          if (round.status !== "running") continue;
          round.status = "interrupted";
          for (const slot of round.slots)
            if (["running", "pending"].includes(slot.outcome))
              slot.outcome = "interrupted";
        }
        m.needsDrain = false;
      }
      m.initiator = actor.session;
      if (handoff !== undefined) m.handoff = handoffSchema.parse(handoff);
      m.coordinator = coordinator;
      if (!m.managedSessions.includes(coordinator))
        m.managedSessions.push(coordinator);
      await this.save(m);
      return m;
    });
  }
  /** Reconcile recorded results through a trusted adapter; unknown work is interrupted, never successful. */
  async recover(
    id: string,
    reconcile: (session: string) => Promise<"stopped" | "active" | "unknown">,
  ): Promise<Manifest> {
    return this.transaction(id, async (m) => {
      m.needsDrain = false;
      for (const round of m.rounds.filter(
        (r) => r.status === "running" || r.status === "interrupted",
      )) {
        for (const slot of round.slots.filter(
          (s) =>
            s.outcome === "running" ||
            s.outcome === "pending" ||
            s.outcome === "interrupted",
        )) {
          const outcome = await reconcile(slot.session);
          if (outcome === "active")
            throw new Error("Review workers are still active");
          if (outcome === "unknown") m.needsDrain = true;
          slot.outcome = "interrupted";
        }
        round.status = "interrupted";
      }
      if (!["closing", "cleanup_failed"].includes(m.lifecycle))
        m.lifecycle = "interrupted";
      await this.save(m);
      return m;
    });
  }
  /** Retry an interrupted recursive removal from its external, identity-only cleanup record. */
  async finishRemoval(id: string, actor: Actor): Promise<boolean> {
    idSchema.parse(id);
    // Avoid acquiring a lock for the usual, not-yet-closing path.
    try {
      await lstat(join(this.root, `${id}.removed`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    return this.lock(id, async () => {
      try {
        const t = tombstoneSchema.parse(
          JSON.parse(await readOwned(join(this.root, `${id}.removed`))),
        );
        if (
          t.id !== id ||
          t.project !== actor.project ||
          ![t.initiator, t.coordinator].includes(actor.session)
        )
          throw new Error("Unauthorized removed review");
        // The record is written only after drain/delivery/retirement succeeded. Directory identity
        // survives partial rm even if its manifest/marker did not; a recreated path must not qualify.
        try {
          const info = await lstat(this.directory(id));
          if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            info.dev !== t.device ||
            info.ino !== t.inode
          )
            throw new Error("Cleanup directory ownership changed");
          try {
            if (
              (await readOwned(join(this.directory(id), "owner"))) !== t.owner
            )
              throw new Error("Cleanup marker changed");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await rm(this.directory(id), { recursive: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
  }
  /** Caller holds the lock and has drained sessions. Removes only the marker-verified owned directory. */
  async remove(m: Manifest): Promise<void> {
    await this.load(m.id);
    const info = await lstat(this.directory(m.id));
    await atomic(join(this.root, `${m.id}.removed`), {
      version: 1,
      id: m.id,
      project: m.project,
      initiator: m.initiator,
      coordinator: m.coordinator,
      owner: m.owner,
      device: info.dev,
      inode: info.ino,
    });
    await rm(this.directory(m.id), { recursive: true });
  }
}
