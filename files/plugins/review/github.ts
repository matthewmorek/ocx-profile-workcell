import { z } from "zod";

import {
  oidSchema,
  repositorySchema,
  sameRepository,
  type Repository,
  type Scope,
  type EvidenceFailure,
  type EvidenceResult,
} from "./contracts";
import { execute, type Transport } from "./process";

export function repositoryFromRemote(remote: string): Repository {
  const match =
    /^(?:https:\/\/|ssh:\/\/git@|git@)([a-zA-Z0-9.-]+)(?:\/|:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      remote.trim(),
    );
  if (!match) throw new Error("Use a project with a verified GitHub origin");
  return repositorySchema.parse({
    host: match[1].toLowerCase(),
    owner: match[2],
    name: match[3],
  });
}
const numericPR = /^(?:pr\s+|pr:|#)([1-9][0-9]*)$/;
/** Explicit PR syntax only. Bare numeric filenames/revisions must not trigger GitHub resolution. */
export function isPullRequestScope(input: string): boolean {
  const value = input.trim();
  return numericPR.test(value) || value.startsWith("https://");
}
export function parseScope(
  input: string | string[],
  repository?: Repository,
): Scope | { action: "resume" | "status" | "close" | "recover"; id: string } {
  if (Array.isArray(input))
    return { kind: "paths", paths: input.map(safePath) };
  const value = input.trim();
  if (value === "recover create") return { action: "recover", id: "create" };
  if (!value) return { kind: "staged" };
  if (value === "recent") return { kind: "recent" };
  const action = /^(resume|status|close|recover) ([a-f0-9]{32})$/.exec(value);
  if (action)
    return {
      action: action[1] as "resume" | "status" | "close" | "recover",
      id: action[2],
    };
  const pr =
    /^https:\/\/([a-zA-Z0-9.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(
      value,
    );
  const numberInput = numericPR.exec(value);
  if (pr || numberInput) {
    if (!repository)
      throw new Error("Verify the project's GitHub origin first");
    const target = pr
      ? repositorySchema.parse({
          host: pr[1].toLowerCase(),
          owner: pr[2],
          name: pr[3],
        })
      : repository;
    if (!sameRepository(target, repository))
      throw new Error("Open this PR's local project instead");
    const number = Number(pr ? pr[4] : numberInput![1]);
    if (!Number.isSafeInteger(number) || number > 2_147_483_647)
      throw new Error("Invalid PR number");
    return { kind: "pr", repository: target, number };
  }
  if (value.startsWith("path:"))
    return { kind: "paths", paths: [safePath(value.slice(5))] };
  safeRevision(value);
  return { kind: "revision", expression: value };
}
export function safePath(value: string): string {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((s) => s === ".." || s.toLowerCase() === ".git" || s === "") ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error("Use a relative path without traversal");
  return value;
}
export function safeRevision(value: string): string {
  if (
    !value ||
    value.startsWith("-") ||
    !/^[A-Za-z0-9_./~^@{}+-]+$/.test(value) ||
    value.includes("@{")
  )
    throw new Error("Invalid revision; use path: for a file scope");
  return value;
}
const metadataSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  base: z.object({
    sha: oidSchema,
    ref: z.string(),
    repo: z.object({ full_name: z.string(), html_url: z.string() }),
  }),
  head: z.object({ sha: oidSchema }),
});
export type PullRequest = z.infer<typeof metadataSchema>;
export type EvidenceKind =
  | "comments"
  | "inline"
  | "reviews"
  | "checks"
  | "statuses";
export type EvidencePage = Extract<
  EvidenceResult,
  { availability: "available" }
>;
class AuxiliaryReadUnavailable extends Error {
  constructor(readonly failure: EvidenceFailure) {
    super(`GitHub read unavailable (${failure.category})`);
  }
}

/** Fixed GET endpoints only. Transport injection is host-owned, never a tool argument. */
export class GitHub {
  constructor(
    private readonly cwd: string,
    private readonly transport: Transport = execute,
  ) {}
  private async get(
    repository: Repository,
    endpoint: string,
  ): Promise<unknown> {
    repositorySchema.parse(repository);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "cat",
      NO_COLOR: "1",
    };
    const result = await this.transport({
      argv: [
        "gh",
        "api",
        "--hostname",
        repository.host,
        "--method",
        "GET",
        endpoint,
      ],
      cwd: this.cwd,
      env,
    });
    if (result.code) {
      // Classify only recognized gh operational failures. Never persist authenticated stderr,
      // nor turn transport exceptions, invalid requests, or response/schema errors into gaps.
      const diagnostic = result.stderr.toString("utf8");
      if (result.code !== 1 && result.code !== 4)
        throw new Error(`GitHub request failed (exit ${result.code})`);
      const match = [...diagnostic.matchAll(/\bHTTP\s+(\d{3})\b/g)].at(-1);
      const httpStatus = match ? Number(match[1]) : undefined;
      let category: EvidenceFailure["category"] | undefined;
      if (httpStatus === 401 || (httpStatus === undefined && result.code === 4))
        category = "authentication";
      else if (httpStatus === 403)
        category = /rate limit/i.test(diagnostic)
          ? "rate-limited"
          : "permission-denied";
      else if (httpStatus === 429) category = "rate-limited";
      else if (httpStatus === 404) category = "not-found";
      else if (
        httpStatus === 408 ||
        (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599)
      )
        category = "service-unavailable";
      else if (
        httpStatus === undefined &&
        result.code === 1 &&
        /dial tcp|i\/o timeout|connection refused|connection reset|connection timed out|TLS handshake timeout|temporary failure in name resolution|error connecting to [a-z0-9.-]+|no such host|network is unreachable/i.test(
          diagnostic,
        )
      )
        category = "network-unavailable";
      if (category)
        throw new AuxiliaryReadUnavailable({
          category,
          httpStatus,
          exitCode: result.code,
        });
      throw new Error(`GitHub request failed (exit ${result.code})`);
    }
    try {
      return JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw new Error("Invalid GitHub response");
    }
  }
  async metadata(repository: Repository, number: number): Promise<PullRequest> {
    if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647)
      throw new Error("Invalid PR number");
    const pr = metadataSchema.parse(
      await this.get(
        repository,
        `repos/${repository.owner}/${repository.name}/pulls/${number}`,
      ),
    );
    if (
      pr.number !== number ||
      !sameRepository(
        repository,
        repositoryFromRemote(pr.base.repo.html_url),
      ) ||
      pr.base.repo.full_name.toLowerCase() !==
        `${repository.owner}/${repository.name}`.toLowerCase()
    )
      throw new Error("PR repository identity mismatch");
    return pr;
  }
  async evidence(
    repository: Repository,
    number: number,
    head: string,
    kind: EvidenceKind,
    pages = 5,
  ): Promise<EvidenceResult> {
    oidSchema.parse(head);
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      !Number.isInteger(pages) ||
      pages < 1 ||
      pages > 10
    )
      throw new Error("Invalid evidence bounds");
    const endpoints: Record<EvidenceKind, string> = {
      comments: `issues/${number}/comments`,
      inline: `pulls/${number}/comments`,
      reviews: `pulls/${number}/reviews`,
      checks: `commits/${head}/check-runs`,
      statuses: `commits/${head}/statuses`,
    };
    if (!Object.hasOwn(endpoints, kind))
      throw new Error("Unsupported evidence kind");
    const checkedAt = new Date().toISOString();
    try {
      const items: unknown[] = [];
      for (let page = 1; page <= pages; page++) {
        const body = await this.get(
          repository,
          `repos/${repository.owner}/${repository.name}/${endpoints[kind]}?per_page=100&page=${page}`,
        );
        const batch =
          kind === "checks"
            ? z.object({ check_runs: z.array(z.unknown()) }).parse(body)
                .check_runs
            : z.array(z.unknown()).parse(body);
        items.push(...batch);
        if (batch.length < 100)
          return {
            availability: "available",
            checkedAt,
            items,
            truncated: false,
          };
      }
      return { availability: "available", checkedAt, items, truncated: true };
    } catch (error) {
      if (!(error instanceof AuxiliaryReadUnavailable)) throw error;
      // A failed later page invalidates this source's complete retrieval; do not reuse old CI
      // or expose the partial page as an empty/successful result.
      return { availability: "unavailable", checkedAt, failure: error.failure };
    }
  }
}
