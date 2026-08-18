import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createGitHubReleaseClient, parseReleaseBundle } from "../scripts/release-api";
import { sha256 } from "../scripts/common";

const tag = "v0.1.0";
const assetNames = [`ocx-workspace-profile-${tag}.tar.gz`, "provenance.json", "receipt.jsonc", "SHA256SUMS"];

type Asset = { name: string; browser_download_url: string };
type Draft = { id: number; draft: boolean; tag_name: string; upload_url: string; assets: Asset[] };

async function temporaryBundle() {
  const directory = await mkdtemp(join(tmpdir(), "release-api-test-"));
  const assets = await Promise.all(assetNames.map(async (name) => {
    const path = join(directory, name);
    const bytes = new TextEncoder().encode(name);
    await Bun.write(path, bytes);
    return { path, name, sha256: sha256(bytes) };
  }));
  const path = join(directory, "release-bundle.json");
  await Bun.write(path, JSON.stringify({ schemaVersion: 1, tag, version: "0.1.0", assets: assets.map((asset) => ({ ...asset, path: asset.name })) }));
  return { directory, bundle: { tag, version: "0.1.0", path, assets } };
}

function assetUrl(name: string): string { return `https://assets.example/${encodeURIComponent(name)}`; }
function asset(name: string): Asset { return { name, browser_download_url: assetUrl(name) }; }
function draft(assets: Asset[] = [], draftRelease = true): Draft {
  return { id: 47, draft: draftRelease, tag_name: tag, upload_url: "https://uploads.example/release{?name,label}", assets };
}

describe("GitHub release API client", () => {
  test("resolves manifest-relative assets from relative and absolute manifest paths without permitting escapes", async () => {
    const { directory, bundle } = await temporaryBundle();
    const manifest = JSON.parse(await Bun.file(bundle.path).text());
    try {
      const relativeManifestPath = relative(process.cwd(), bundle.path);
      for (const manifestPath of [relativeManifestPath, bundle.path]) {
        const parsed = parseReleaseBundle(manifest, tag, manifestPath);
        expect(parsed.path).toBe(bundle.path);
        expect(parsed.assets.map(({ path }) => path)).toEqual(bundle.assets.map(({ path }) => path));
      }
      const traversal = structuredClone(manifest);
      traversal.assets[0].path = `../${assetNames[0]}`;
      const absolute = structuredClone(manifest);
      absolute.assets[0].path = bundle.assets[0].path;
      expect(() => parseReleaseBundle(traversal, tag, relativeManifestPath)).toThrow("unsafe asset");
      expect(() => parseReleaseBundle(absolute, tag, relativeManifestPath)).toThrow("unsafe asset");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("finds drafts through authenticated paginated release listings", async () => {
    const target = draft(); const headers: string[] = [];
    const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input); headers.push(new Headers(init?.headers).get("Authorization") ?? "");
      if (url.endsWith("page=1")) return Response.json([{ ...draft([], false), tag_name: "v0.0.9" }], { headers: { Link: '<https://api.github.com/repos/owner/repository/releases?per_page=100&page=2>; rel="next"' } });
      if (url.endsWith("page=2")) return Response.json([target]);
      throw new Error(`Unexpected request ${url}`);
    };
    const found = await createGitHubReleaseClient("test-token", request as typeof fetch).getRelease("owner/repository", tag);
    expect(found?.id).toBe(47); expect(headers).toEqual(["Bearer test-token", "Bearer test-token"]);
  });

  test("reuses matching partial uploads and completes the exact draft asset contract", async () => {
    const { directory, bundle } = await temporaryBundle();
    const bytes = new Map<string, Uint8Array>();
    for (const name of assetNames) bytes.set(name, new Uint8Array(await Bun.file(join(directory, name)).arrayBuffer()));
    const current = draft([asset(assetNames[0])]); const uploaded: string[] = [];
    const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("page=1")) return Response.json([current]);
      if (url.startsWith("https://assets.example/")) return new Response(bytes.get(decodeURIComponent(new URL(url).pathname.slice(1))));
      if (url.startsWith("https://uploads.example/")) {
        const name = new URL(url).searchParams.get("name")!;
        uploaded.push(name); bytes.set(name, new Uint8Array(init?.body as Uint8Array)); current.assets.push(asset(name));
        return Response.json({});
      }
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      await createGitHubReleaseClient("test-token", request as typeof fetch).ensureDraft("owner/repository", tag, bundle);
      expect(uploaded).toEqual(assetNames.slice(1));
      expect(current.assets.map(({ name }) => name)).toEqual(assetNames);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("rejects unexpected and divergent existing assets without overwriting", async () => {
    const { directory, bundle } = await temporaryBundle();
    const calls: string[] = [];
    const extra = draft([asset("unexpected.txt")]);
    const divergent = draft([{ name: assetNames[0], browser_download_url: "https://assets.example/divergent" }]);
    const requestFor = (current: Draft) => async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input); calls.push(url);
      if (url.endsWith("page=1")) return Response.json([current]);
      if (url.endsWith("divergent")) return new Response("different bytes");
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      await expect(createGitHubReleaseClient("test-token", requestFor(extra) as typeof fetch).ensureDraft("owner/repository", tag, bundle)).rejects.toThrow("unexpected asset");
      await expect(createGitHubReleaseClient("test-token", requestFor(divergent) as typeof fetch).ensureDraft("owner/repository", tag, bundle)).rejects.toThrow("diverges");
      expect(calls.some((url) => url.startsWith("https://uploads.example/"))).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("fails fresh draft verification when draft assets are deleted, added, or altered between phases", async () => {
    const { directory, bundle } = await temporaryBundle();
    const bytes = new Map<string, Uint8Array>();
    for (const name of assetNames) bytes.set(name, new Uint8Array(await Bun.file(join(directory, name)).arrayBuffer()));
    const requestFor = (current: Draft) => async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("page=1")) return Response.json([current]);
      if (url.startsWith("https://assets.example/")) return new Response(bytes.get(decodeURIComponent(new URL(url).pathname.slice(1))));
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      const missing = draft(assetNames.slice(1).map(asset));
      const extra = draft([...assetNames.map(asset), asset("unexpected.txt")]);
      const altered = draft([{ name: assetNames[0], browser_download_url: "https://assets.example/altered" }, ...assetNames.slice(1).map(asset)]);
      for (const [current, message] of [[missing, "missing required asset"], [extra, "unexpected asset"], [altered, "diverges"]] as const) {
        await expect(createGitHubReleaseClient("test-token", requestFor(current) as typeof fetch).assertDraft("owner/repository", tag, bundle)).rejects.toThrow(message);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("normal publication publishes drafts, safely accepts matching published releases, and rejects missing or mismatched tags", async () => {
    const current = draft(); const requests: Array<{ url: string; method?: string }> = [];
    const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input); requests.push({ url, method: init?.method });
      if (url.endsWith("page=1")) return Response.json([current]);
      if (url.endsWith("/releases/47") && init?.method === "PATCH") { current.draft = false; return Response.json(current); }
      throw new Error(`Unexpected request ${url}`);
    };
    const mismatchedTag = { ...draft(), tag_name: "v0.1.1" };
    const mismatchedRequest = async (): Promise<Response> => Response.json([mismatchedTag]);
    const missingRequest = async (): Promise<Response> => Response.json([]);
    const client = createGitHubReleaseClient("test-token", request as typeof fetch);
    await client.publishRelease("owner/repository", tag);
    await client.publishRelease("owner/repository", tag);
    expect(requests.filter(({ method }) => method === "PATCH")).toEqual([{ url: "https://api.github.com/repos/owner/repository/releases/47", method: "PATCH" }]);
    await expect(createGitHubReleaseClient("test-token", missingRequest as typeof fetch).publishRelease("owner/repository", tag)).rejects.toThrow("Release draft does not exist");
    await expect(createGitHubReleaseClient("test-token", mismatchedRequest as typeof fetch).publishRelease("owner/repository", tag)).rejects.toThrow("Release draft does not exist");
  });

  test("publishes only the expected sole exact draft and verifies its published postcondition", async () => {
    const { directory, bundle } = await temporaryBundle();
    const bytes = new Map<string, Uint8Array>();
    for (const name of assetNames) bytes.set(name, new Uint8Array(await Bun.file(join(directory, name)).arrayBuffer()));
    const current = draft(assetNames.map(asset)); const requests: Array<{ url: string; method?: string }> = [];
    const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input); requests.push({ url, method: init?.method });
      if (url.endsWith("page=1")) return Response.json([current]);
      if (url.startsWith("https://assets.example/")) return new Response(bytes.get(decodeURIComponent(new URL(url).pathname.slice(1))));
      if (url.endsWith("/releases/47") && init?.method === "PATCH") { current.draft = false; return Response.json(current); }
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      const client = createGitHubReleaseClient("test-token", request as typeof fetch);
      await client.publishExactRelease("owner/repository", tag, bundle, 47);
      expect(requests.some(({ url }) => url.startsWith("https://uploads.example/"))).toBe(false);
      expect(requests).toContainEqual({ url: "https://api.github.com/repos/owner/repository/releases/47", method: "PATCH" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("rejects release-ID, inventory, asset, and publication-status changes around exact publication", async () => {
    const { directory, bundle } = await temporaryBundle();
    const bytes = new Map<string, Uint8Array>();
    for (const name of assetNames) bytes.set(name, new Uint8Array(await Bun.file(join(directory, name)).arrayBuffer()));
    const requestFor = (responses: () => Draft[], patch?: (current: Draft) => void) => async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("page=1")) return Response.json(responses());
      if (url.startsWith("https://assets.example/")) return new Response(bytes.get(decodeURIComponent(new URL(url).pathname.slice(1))));
      if (url.endsWith("/releases/47") && init?.method === "PATCH") { patch?.(responses()[0]!); return Response.json({}); }
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      const current = draft(assetNames.map(asset));
      await expect(createGitHubReleaseClient("test-token", requestFor(() => [current]) as typeof fetch).publishExactRelease("owner/repository", tag, bundle, 48)).rejects.toThrow("ID changed");

      const extraRelease = { ...draft(), id: 48, tag_name: "v0.1.1" };
      await expect(createGitHubReleaseClient("test-token", requestFor(() => [draft(assetNames.map(asset)), extraRelease]) as typeof fetch).publishExactRelease("owner/repository", tag, bundle, 47)).rejects.toThrow("sole repository release");

      const divergent = draft([{ name: assetNames[0], browser_download_url: "https://assets.example/divergent" }, ...assetNames.slice(1).map(asset)]);
      await expect(createGitHubReleaseClient("test-token", requestFor(() => [divergent]) as typeof fetch).publishExactRelease("owner/repository", tag, bundle, 47)).rejects.toThrow("diverges");

      const unchangedDraft = draft(assetNames.map(asset));
      await expect(createGitHubReleaseClient("test-token", requestFor(() => [unchangedDraft]) as typeof fetch).publishExactRelease("owner/repository", tag, bundle, 47)).rejects.toThrow("postcondition failed");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("downloads exactly the four public release assets without requiring the local bundle manifest", async () => {
    const { directory } = await temporaryBundle();
    const published = draft(assetNames.map(asset), false); const downloaded: string[] = [];
    const request = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("page=1")) return Response.json([published]);
      if (url.startsWith("https://assets.example/")) {
        const name = decodeURIComponent(new URL(url).pathname.slice(1)); downloaded.push(name);
        return new Response(name);
      }
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      const destination = join(directory, "downloaded");
      await createGitHubReleaseClient("test-token", request as typeof fetch).downloadRelease("owner/repository", tag, destination);
      expect(downloaded).toEqual(assetNames);
      expect(await Bun.file(join(destination, "release-bundle.json")).exists()).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("fails loudly when the upstream release API is unavailable", async () => {
    const request = async (): Promise<Response> => new Response("unavailable", { status: 503 });
    await expect(createGitHubReleaseClient("test-token", request as typeof fetch).getRelease("owner/repository", tag)).rejects.toThrow("503");
  });
});
