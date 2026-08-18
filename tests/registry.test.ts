import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { repositoryRoot, sha256 } from "../scripts/common";

const registry = parse(await readFile(join(repositoryRoot, "registry.jsonc"), "utf8")) as any;
const hashes = JSON.parse(await readFile(join(repositoryRoot, "tests/fixtures/canonical-hashes.json"), "utf8")) as Record<string, string>;
const expected = JSON.parse(await readFile(join(repositoryRoot, "tests/fixtures/expected-overrides.json"), "utf8")) as any;
const ws = registry.components.find((component: any) => component.name === "ws");
const overrides = registry.components.find((component: any) => component.name === "ws-overrides");
const canonicalize = (value: any): any => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])) : value;

describe("workspace registry source", () => {
  test("contains exactly the ordered profile and tail bundle", () => {
    expect(registry.version).toBe("0.1.0");
    expect(registry.components.map((component: any) => component.name)).toEqual(["ws", "ws-overrides"]);
    expect(ws.dependencies).toEqual(["kdco/workspace", "ws-overrides"]);
    expect(ws.files).toEqual([
      { path: "profiles/ws/ocx.jsonc", target: "ocx.jsonc" },
      { path: "profiles/ws/AGENTS.md", target: "AGENTS.md" },
    ]);
    expect(overrides.files).toBeUndefined();
  });
  test("preserves canonical profile payload snapshots", async () => {
    for (const [path, digest] of Object.entries(hashes).filter(([path]) => path !== "schemaVersion")) expect(sha256(await readFile(join(repositoryRoot, path)))).toBe(digest);
  });
  test("contains exact derivative-owned override metadata", () => {
    expect(sha256(JSON.stringify(canonicalize(overrides.opencode)))).toBe(expected.canonicalOverrideSha256);
    expect(overrides.opencode.model).toBe(expected.models.model);
    expect(overrides.opencode.small_model).toBe(expected.models.small_model);
    expect(Object.keys(overrides.opencode.mcp).sort()).toEqual(expected.mcpKeys);
    expect(overrides.opencode.plugin).toEqual(expected.plugins);
  });
  test("excludes inherited duplication, secrets, and user-local artifacts", async () => {
    const source = await readFile(join(repositoryRoot, "registry.jsonc"), "utf8");
    expect(source).not.toContain("posthog"); expect(source).not.toContain("tuple"); expect(source).not.toContain("@latest"); expect(source).not.toContain("/Users/");
    expect(source).not.toContain("@tarquinen/opencode-dcp"); expect(source).not.toContain("opencode-md-table-formatter"); expect(overrides.opencode.instructions).toBeUndefined();
    await expect(Bun.file(join(repositoryRoot, "files/profiles/ws/opencode.jsonc")).exists()).resolves.toBe(false);
  });
  test("models, MCPs, and plugins meet pinned-lane policy", () => {
    expect(Object.values(overrides.opencode.agent).map((agent: any) => agent.model)).toEqual(expect.arrayContaining(["openai/gpt-5.6-sol", "openai/gpt-5.6-luna", "openai/gpt-5.6-terra"]));
    expect(Object.values(overrides.opencode.mcp).every((mcp: any) => mcp.type === "remote" && mcp.enabled === true)).toBe(true);
    expect(new Set(overrides.opencode.plugin).size).toBe(overrides.opencode.plugin.length);
  });
  test("transports all semantic request controls through supported options", () => {
    const expectedOptions = {
      plan: ["high", "low"], build: ["high", "low"], coder: ["medium", "low"], explore: ["medium", "medium"], researcher: ["medium", "medium"], scribe: ["medium", "low"], reviewer: ["high", "medium"]
    };
    for (const [name, [reasoningEffort, textVerbosity]] of Object.entries(expectedOptions)) {
      const agent = overrides.opencode.agent[name];
      expect(agent.options).toEqual({ reasoningEffort, textVerbosity });
      expect(agent.reasoningEffort).toBeUndefined();
      expect(agent.textVerbosity).toBeUndefined();
    }
  });
});
