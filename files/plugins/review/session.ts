import type { PluginInput } from "@opencode-ai/plugin";
import { z } from "zod";

import type { Manifest } from "./contracts";

export type Client = PluginInput["client"];
export const permissionSchema = z
  .object({
    permission: z.string(),
    pattern: z.string(),
    action: z.enum(["allow", "deny", "ask"]),
  })
  .strict();
export type Rule = z.infer<typeof permissionSchema>;
export const coordinatorTools = [
  "review_state",
  "review_inspect",
  "worktree_review",
  "delegate",
  "delegation_read",
  "delegation_list",
];
export const workerTools = ["review_state", "review_inspect"];
export function sessionRules(worker: boolean): Rule[] {
  return [
    { permission: "*", pattern: "*", action: "deny" },
    ...(worker ? workerTools : coordinatorTools).map((permission): Rule => ({
      permission,
      pattern: "*",
      action: "allow",
    })),
    { permission: "skill", pattern: "code-review", action: "allow" },
  ];
}
const sessionSchema = z.object({
  id: z.string(),
  directory: z.string(),
  parentID: z.string().optional(),
  permission: z.array(permissionSchema),
});

/** V1 /session supports permission at runtime despite legacy SDK types omitting it.
 * Verified against 1.18.25, upstream cb7d8b2f5e44876ef98b661dc10590c915af3a9f,
 * server/routes/instance/httpapi/handlers/session.ts createRaw and installed runtime.
 * A structural body extension preserves the SDK's authenticated transport. GET verifies
 * the server retained the exact rules before any model receives a prompt.
 */
export class ReviewSessions {
  constructor(
    readonly client: Client,
    readonly directory: string,
  ) {}
  /** Session metadata/rules remain authoritative when its scratch manifest is unavailable. */
  async mayBeBound(id: string): Promise<boolean> {
    const result = await this.client.session.get({
      path: { id },
      query: { directory: this.directory },
    });
    if (result.error || !result.data)
      throw new Error(
        "Cannot verify session ownership while review inventory is damaged",
      );
    const session = z
      .object({
        id: z.string(),
        directory: z.string(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        permission: z.unknown().optional(),
      })
      .parse(result.data);
    if (session.id !== id || session.directory !== this.directory)
      throw new Error("Session project identity mismatch");
    const permissions = z
      .array(permissionSchema)
      .parse(session.permission ?? []);
    return (
      session.metadata?.workcellReview !== undefined ||
      [true, false].some(
        (worker) =>
          JSON.stringify(permissions) === JSON.stringify(sessionRules(worker)),
      )
    );
  }
  async create(
    worker: boolean,
    parentID?: string,
    owner?: Pick<Manifest, "id" | "owner">,
  ): Promise<string> {
    const body = {
      title: worker ? "Review worker" : "Review",
      permission: sessionRules(worker),
      ...(owner
        ? {
            metadata: {
              workcellReview: { id: owner.id, owner: owner.owner, worker },
            },
          }
        : {}),
      ...(parentID ? { parentID } : {}),
    };
    const result = await this.client.session.create({
      body,
      query: { directory: this.directory },
    });
    if (result.error || !result.data)
      throw new Error("Could not create restricted review session");
    const id = result.data.id;
    try {
      await this.verify(id, worker, parentID);
    } catch (error) {
      await this.client.session.delete({
        path: { id },
        query: { directory: this.directory },
      });
      throw error;
    }
    return id;
  }
  async verify(id: string, worker: boolean, parentID?: string): Promise<void> {
    const result = await this.client.session.get({
      path: { id },
      query: { directory: this.directory },
    });
    if (result.error) throw new Error("Review session unavailable");
    const actual = sessionSchema.parse(result.data);
    if (
      actual.id !== id ||
      actual.directory !== this.directory ||
      actual.parentID !== parentID ||
      JSON.stringify(actual.permission) !== JSON.stringify(sessionRules(worker))
    )
      throw new Error(
        "Review session restrictions were not retained; no prompt sent",
      );
  }
  /** Creation metadata closes the crash window between the server effect and manifest binding. */
  async owned(
    manifest: Pick<Manifest, "id" | "owner" | "managedSessions">,
  ): Promise<string[]> {
    // The pinned V1 handler accepts limit even though legacy SDK query types omit it.
    // Refuse a saturated page rather than claiming all orphaned sessions were found.
    const query = { directory: this.directory, limit: 1000 };
    const result = await this.client.session.list({
      query,
    });
    if (result.error || !result.data)
      throw new Error("Could not reconcile owned review sessions");
    if (result.data.length >= query.limit)
      throw new Error(
        "Session discovery reached its limit; narrow the project session inventory before cleanup",
      );
    const ids = new Set(manifest.managedSessions);
    for (const raw of result.data) {
      const session = z
        .object({
          id: z.string(),
          directory: z.string(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(raw);
      const marker = z
        .object({ id: z.string(), owner: z.string(), worker: z.boolean() })
        .safeParse(session.metadata?.workcellReview);
      if (
        session.directory === this.directory &&
        marker.success &&
        marker.data.id === manifest.id &&
        marker.data.owner === manifest.owner
      )
        ids.add(session.id);
    }
    return [...ids];
  }
  async prompt(id: string, worker: boolean, text: string, parentID?: string) {
    await this.verify(id, worker, parentID);
    const result = await this.client.session.prompt({
      path: { id },
      query: { directory: this.directory },
      body: {
        agent: worker ? "reviewer" : "review",
        parts: [{ type: "text", text }],
      },
    });
    if (result.error)
      throw new Error("Review session failed; inspect retained state");
    return result.data;
  }
  async drain(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const result = await this.client.session.abort({
        path: { id },
        query: { directory: this.directory },
      });
      if (result.error) {
        const check = await this.client.session.get({
          path: { id },
          query: { directory: this.directory },
        });
        if (check.response.status !== 404)
          throw new Error("Could not abort a managed review session");
      }
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await this.client.session.status({
        query: { directory: this.directory },
      });
      if (result.error || !result.data)
        throw new Error("Could not confirm review worker termination");
      if (
        ids.every((id) => !result.data![id] || result.data![id].type === "idle")
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Review sessions are still active; retry close");
  }
  async retire(ids: readonly string[]) {
    for (const id of ids) {
      const result = await this.client.session.delete({
        path: { id },
        query: { directory: this.directory },
      });
      if (result.error && result.response.status !== 404)
        throw new Error("Could not retire managed review session");
    }
  }
}
