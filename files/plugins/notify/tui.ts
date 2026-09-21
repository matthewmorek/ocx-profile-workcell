/**
 * Client-local cmux status for Workcell.
 * Copied and modified from KDCO OCX/Workspace under MIT.
 * See THIRD_PARTY_NOTICES.md for immutable source mappings and notices.
 * Native OpenCode exclusively owns terminal titles, desktop alerts and sounds.
 */
// This public leaf export avoids loading the optional Solid/UI renderer runtime:
// this integration registers no widget, panel, ownership override or UI setting.
import * as Plugin from "@opencode/plugin/tui/plugin";

import { cmuxTarget, writeCmuxStatus } from "./cmux";
import { selectedRootStatus, statusText } from "./status";

export default Plugin.define({
  id: "workcell-notify",
  setup(ctx) {
    const target = cmuxTarget();
    if (!target) return;
    let disposed = false;
    let queued = false;
    let epoch = 0;
    let candidate: string | undefined;
    let hydrated: string | undefined;
    let hydration: Promise<void> | undefined;
    let retrySyncAt = 0;
    let desired: { key: string; text?: string } | undefined;
    let committed: { key: string; text?: string } | undefined;
    let draining: Promise<void> | undefined;
    let retryWriteAt = 0;
    const owned = new Set<string>();
    const same = (a: typeof desired, b: typeof desired) =>
      a?.key === b?.key && a?.text === b?.text;

    // One writer, coalesced to the latest snapshot. A delayed busy write cannot
    // land after its terminal clear or after this client changes root tabs.
    const drain = () => {
      if (draining || Date.now() < retryWriteAt) return;
      draining = (async () => {
        for (;;) {
          const stale = [...owned].find((key) => key !== desired?.key);
          if (stale) {
            if (!(await writeCmuxStatus(target, stale))) {
              retryWriteAt = Date.now() + 1000;
              return;
            }
            owned.delete(stale);
            continue;
          }
          const next = desired;
          if (!next || same(next, committed)) return;
          owned.add(next.key);
          if (!(await writeCmuxStatus(target, next.key, next.text))) {
            retryWriteAt = Date.now() + 1000;
            return;
          }
          committed = next;
          if (next.text === undefined) owned.delete(next.key);
        }
      })().finally(() => {
        draining = undefined;
      });
    };
    const schedule = () => {
      if (disposed || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!disposed) reconcile();
      });
    };
    const reconcile = () => {
      const route = ctx.ui.router.current();
      const selected =
        route.type === "session"
          ? (ctx.ui.tabs.list().find((tab) => tab.active)?.sessionID ??
            route.sessionID)
          : undefined;
      const rootID = selected ? ctx.data.session.root(selected) : undefined;
      if (rootID !== candidate) {
        candidate = rootID;
        hydrated = undefined;
        retrySyncAt = 0;
      }
      if (
        rootID &&
        hydrated !== rootID &&
        !hydration &&
        Date.now() >= retrySyncAt
      ) {
        const version = epoch;
        hydration = Promise.all([
          ctx.data.session.sync(rootID),
          ctx.data.session.permission.sync(rootID),
          ctx.data.session.form.sync(rootID),
        ])
          .then(() => {
            if (version === epoch && candidate === rootID) hydrated = rootID;
          })
          .catch(() => {
            retrySyncAt = Date.now() + 5000;
          })
          .finally(() => {
            hydration = undefined;
            schedule();
          });
      }
      const status =
        rootID && hydrated === rootID ? selectedRootStatus(ctx) : undefined;
      const next = status
        ? {
            key: `opencode.session.${status.sessionID}.${target.surfaceID}`,
            text: statusText(status.state),
          }
        : undefined;
      if (!same(next, desired)) {
        desired = next;
        committed = undefined;
      }
      drain();
    };
    const releases = [
      ctx.data.on("server.connected", () => {
        epoch++;
        hydrated = undefined;
        retrySyncAt = 0;
        committed = undefined;
        if (candidate) {
          ctx.data.session.invalidate(candidate);
          ctx.data.session.permission.invalidate(candidate);
          ctx.data.session.form.invalidate(candidate);
        }
        schedule();
      }),
      ...(
        [
          "session.created",
          "session.deleted",
          "session.agent.selected",
          "session.execution.started",
          "session.execution.succeeded",
          "session.execution.failed",
          "session.execution.interrupted",
          "permission.asked",
          "permission.replied",
          "form.created",
          "form.replied",
          "form.cancelled",
        ] as const
      ).map((type) => ctx.data.on(type, schedule)),
    ];
    // Router/tab getters have no imperative change subscription. This cheap
    // client-local reconciliation also covers cache hydration and transport retry
    // without importing a renderer/reactive toolkit or duplicating native state.
    const timer = setInterval(schedule, 500);
    timer.unref?.();
    schedule();
    return async () => {
      disposed = true;
      epoch++;
      for (const release of releases) release();
      clearInterval(timer);
      desired = undefined;
      await draining;
      // Include any key whose write was attempted, even after transport failure.
      for (const key of owned) {
        if (!(await writeCmuxStatus(target, key)))
          console.warn(
            "[workcell-notify] Could not clear this client's cmux status",
          );
      }
      owned.clear();
    };
  },
});
