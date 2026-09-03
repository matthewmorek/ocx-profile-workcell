import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const commandTimeoutMilliseconds = 60_000;
const localBinaryDirectory = join(repositoryRoot, "node_modules", ".bin");
export const profileLaunchCommand = "ocx";
export const profileLaunchArguments = ["oc", "-p", "workcell", "--", "--help"];
type SmokeServer = Pick<ReturnType<typeof Bun.serve>, "stop">;

function fail(message: string): never { throw new Error(message); }

async function run(command: string, arguments_: string[], environment: Record<string, string | undefined>, workingDirectory: string): Promise<void> {
  const child = Bun.spawn([command, ...arguments_], {
    cwd: workingDirectory,
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, commandTimeoutMilliseconds);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  if (timedOut) fail(`${command} ${arguments_.join(" ")} timed out after ${commandTimeoutMilliseconds}ms.`);
  if (exitCode !== 0) fail(`${command} ${arguments_.join(" ")} exited with code ${exitCode}.`);
}

function isLaunchOverride(name: string): boolean {
  return name.startsWith("OCX_") || name.startsWith("OPENCODE_");
}

export function smokeEnvironment(parentEnvironment: NodeJS.ProcessEnv, sandbox: string): Record<string, string> {
  const path = parentEnvironment.PATH;
  if (!path) fail("Smoke test requires PATH in its parent environment.");

  const environment = Object.fromEntries(
    Object.entries(parentEnvironment).filter(([name, value]) => value !== undefined && !isLaunchOverride(name)),
  ) as Record<string, string>;
  const home = join(sandbox, "home");
  return {
    ...environment,
    HOME: home,
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_DATA_HOME: join(sandbox, "data"),
    XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_STATE_HOME: join(sandbox, "state"),
    PATH: `${localBinaryDirectory}:${path}`,
  };
}

export async function cleanupSmokeSandbox(sandbox: string, server?: SmokeServer): Promise<void> {
  try {
    server?.stop(true);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

function registryFile(registryDirectory: string, requestUrl: string): string | undefined {
  const pathname = decodeURIComponent(new URL(requestUrl).pathname);
  const requestedPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (!requestedPath || requestedPath.split("/").includes("..")) return undefined;
  const file = resolve(registryDirectory, requestedPath);
  return relative(registryDirectory, file).startsWith("..") ? undefined : file;
}

async function main(): Promise<void> {
  const registryDirectory = resolve(process.env.REGISTRY_DIST ?? join(repositoryRoot, "dist"));
  if (!(await Bun.file(join(registryDirectory, "index.json")).exists())) fail(`Built registry not found at ${registryDirectory}. Run bun run build first.`);

  const sandbox = await mkdtemp(join(tmpdir(), "ocx-registry-smoke-"));
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    const home = join(sandbox, "home");
    await mkdir(home);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const file = registryFile(registryDirectory, request.url);
        if (!file || !(await Bun.file(file).exists())) return new Response("Not found", { status: 404 });
        if (file.endsWith(join("components", "workcell", "profiles", "workcell", "ocx.jsonc"))) {
          if (!server) return new Response("Smoke registry is not ready", { status: 503 });
          const canonicalProfile = await Bun.file(file).text();
          return new Response(canonicalProfile.replace("https://matthewmorek.github.io/ocx-profile-workcell", server.url.toString()));
        }
        return new Response(Bun.file(file));
      },
    });
    const environment = smokeEnvironment(process.env, sandbox);
    await run(profileLaunchCommand, ["init", "--global"], environment, home);
    await run(profileLaunchCommand, ["profile", "add", "workcell", "--source", "matthewmorek/workcell", "--from", server.url.toString(), "--global"], environment, home);
    await run(profileLaunchCommand, ["verify"], environment, join(sandbox, "config", "opencode", "profiles", "workcell"));
    await run(profileLaunchCommand, profileLaunchArguments, environment, home);
  } finally {
    await cleanupSmokeSandbox(sandbox, server);
  }
}

if (import.meta.main) await main();
