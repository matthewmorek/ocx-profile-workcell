import { execute, type Transport } from "./process";

/** Only the fixed, host-owned gh helper is enabled, for the one verified HTTPS repository.
 * Git requests credentials on stdin; secrets remain in the helper/Git pipes, never argv/state/logs.
 * The fixed shell snippet rejects store/erase and never interprets model-controlled text.
 */
export const createAuthenticatedGit =
  (transport: Transport = execute): Transport =>
  async (command) => {
    if (command.argv[0] !== "git" || !command.argv.includes("fetch"))
      return transport(command);
    const targets = command.argv.filter((arg) =>
      /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
        arg,
      ),
    );
    if (!targets.length) return transport(command); // Local fixture/source fetch, no authentication.
    if (targets.length !== 1)
      throw new Error("Invalid authenticated review fetch");
    const url = targets[0];
    const helper =
      '!f() { if [ "$1" = get ]; then gh auth git-credential get; fi; }; f';
    return transport({
      ...command,
      argv: [
        "git",
        "-c",
        `credential.${url}.helper=${helper}`,
        "-c",
        "credential.useHttpPath=true",
        ...command.argv
          .slice(1)
          .filter(
            (arg, i, args) =>
              !(arg === "-c" && args[i + 1] === "credential.helper=") &&
              arg !== "credential.helper=",
          ),
      ],
      env: {
        ...command.env,
        HOME: process.env.HOME,
        GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
        GH_TOKEN: process.env.GH_TOKEN,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN,
        GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
        GH_PROMPT_DISABLED: "1",
      },
    });
  };
export const authenticatedGit = createAuthenticatedGit();
