import { withTimeout } from "../kdco-primitives/with-timeout";

export interface CmuxTarget {
  readonly executable: string;
  readonly surfaceID: string;
  readonly env: Record<string, string | undefined>;
}

/** A socket alone does not identify the client's terminal. Never target an
 * arbitrary focused workspace when the client-local cmux identity is missing.
 */
export function cmuxTarget(
  env: Record<string, string | undefined> = process.env,
  resolveExecutable: (command: string) => string | null | undefined = (
    command,
  ) => Bun.which(command),
): CmuxTarget | undefined {
  const workspaceID = env.CMUX_WORKSPACE_ID?.trim();
  const surfaceID = env.CMUX_SURFACE_ID?.trim();
  if (!workspaceID || !surfaceID) return;
  const executable = resolveExecutable("cmux");
  if (!executable) return;
  return {
    executable,
    surfaceID,
    env: { ...env, CMUX_WORKSPACE_ID: workspaceID, CMUX_SURFACE_ID: surfaceID },
  };
}

export const CMUX_STATUS_TIMEOUT_MS = 1500;

/** Only status commands are permitted here. Native OpenCode owns all alerts. */
export async function writeCmuxStatus(
  target: CmuxTarget,
  key: string,
  text?: string,
): Promise<boolean> {
  let process: ReturnType<typeof Bun.spawn> | undefined;
  try {
    process = Bun.spawn(
      [
        target.executable,
        ...(text === undefined
          ? ["clear-status", key]
          : ["set-status", key, text]),
      ],
      {
        env: target.env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    return (
      (await withTimeout(
        process.exited,
        CMUX_STATUS_TIMEOUT_MS,
        "cmux status command timed out",
      )) === 0
    );
  } catch {
    try {
      process?.kill();
    } catch {
      /* The process may already have exited. */
    }
    return false;
  }
}
