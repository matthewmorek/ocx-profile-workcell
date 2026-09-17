import type { ToolContext } from "@opencode-ai/plugin/tool";

/** Shared only inside the trusted plugin process. Review records never enter ordinary delegation storage. */
export interface ReviewBridge {
  bound(session: string): Promise<boolean>;
  delegate(
    context: ToolContext,
    args: { agent: string; prompt: string; review_slot?: string },
  ): Promise<string>;
  read(context: ToolContext, id?: string): Promise<string>;
}
const bridges = new Map<string, ReviewBridge>();
export function registerReviewBridge(directory: string, bridge: ReviewBridge) {
  bridges.set(directory, bridge);
}
export async function reviewRoute(
  context: ToolContext,
): Promise<ReviewBridge | undefined> {
  const bridge = bridges.get(context.directory);
  if (bridge && (await bridge.bound(context.sessionID))) return bridge;
  if (context.agent === "review")
    throw new Error("Start or resume a review with review_start first");
}
