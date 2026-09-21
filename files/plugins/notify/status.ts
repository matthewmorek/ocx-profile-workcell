import type { Plugin } from "@opencode/plugin/tui";

export type CmuxState = "running" | "waiting" | "error" | "idle";

/** Project the selected root's own state, never promote child activity to it. */
export function selectedRootStatus(
  ctx: Pick<Plugin.Context, "data" | "ui">,
): { sessionID: string; state: CmuxState } | undefined {
  const route = ctx.ui.router.current();
  if (route.type !== "session") return;
  const selected =
    ctx.ui.tabs.list().find((tab) => tab.active)?.sessionID ?? route.sessionID;
  const source = ctx.data.session.get(selected);
  if (!source || source.id !== selected) return;
  const rootID = ctx.data.session.root(selected);
  const root = ctx.data.session.get(rootID);
  if (!root || root.id !== rootID || root.parentID !== undefined) return;
  if (root.agent !== "debug" && root.agent !== "plan" && root.agent !== "build")
    return;
  const permissions = ctx.data.session.permission.list(rootID);
  const forms = ctx.data.session.form.list(rootID);
  if (permissions === undefined || forms === undefined) return;
  const state: CmuxState =
    permissions.length || forms.length
      ? "waiting"
      : ctx.data.session.status(rootID) === "running"
        ? "running"
        : root.outcome === "failed"
          ? "error"
          : "idle";
  return { sessionID: rootID, state };
}

export function statusText(state: CmuxState): string | undefined {
  if (state === "running") return "Running";
  if (state === "waiting") return "Needs input";
  if (state === "error") return "Error";
  return undefined;
}
