import { spawn } from "node:child_process";

export interface Command {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBytes?: number;
  timeoutMs?: number;
}
export interface Output {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
}
export type Transport = (command: Command) => Promise<Output>;

/** No shell; kill on timeout or combined output overflow. Never include authenticated stderr in errors. */
export const execute: Transport = ({
  argv,
  cwd,
  env,
  maxBytes = 4_194_304,
  timeoutMs = 30_000,
}) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      if (process.platform === "win32") child.kill("SIGKILL");
      else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(() => stop("Review command timed out"), timeoutMs);
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ] as const) {
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes)
          stop("Review output limit exceeded; narrow the scope");
        else chunks.push(chunk);
      });
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          code: code ?? -1,
        });
    });
  });

/** Git must not inherit caller Git configuration, helpers, credentials, or execution controls. */
export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: "/dev/null",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
  };
}
export const gitOptions = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.file.allow=always",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "credential.helper=",
  "-c",
  "core.askPass=",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];
export async function git(
  cwd: string,
  args: string[],
  transport: Transport = execute,
): Promise<string> {
  const result = await transport({
    argv: ["git", ...gitOptions, ...args],
    cwd,
    env: gitEnvironment(),
  });
  if (result.code !== 0)
    throw new Error(`Review Git ${args[0]} failed (exit ${result.code})`);
  return result.stdout.toString("utf8");
}
