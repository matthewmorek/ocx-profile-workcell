import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createGitHubReleaseClient, parseReleaseBundle } from "../scripts/release-api";
import { repositoryRoot, sha256 } from "../scripts/common";

const tag = "v0.1.0";
const repository = "owner/repository";
const assetNames = [`ocx-workspace-profile-${tag}.tar.gz`, "provenance.json", "receipt.jsonc", "SHA256SUMS"];

type Asset = { id: number; name: string; url: string; browser_download_url: string };
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

function assetId(name: string): number { return 100 + assetNames.indexOf(name); }
function assetUrl(name: string): string { return `https://api.github.com/repos/${repository}/releases/assets/${assetId(name)}`; }
function assetName(url: string): string | undefined { return assetNames.find((name) => assetUrl(name) === url); }
function signedAssetUrl(name: string, host = "release-assets.githubusercontent.com"): string { return `https://${host}/github-production-release-asset-${assetId(name)}?X-Amz-Signature=test`; }
function signedAssetName(url: string, host = "release-assets.githubusercontent.com"): string | undefined { return assetNames.find((name) => signedAssetUrl(name, host) === url); }
function asset(name: string): Asset { return { id: assetId(name), name, url: assetUrl(name), browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}` }; }
function draft(assets: Asset[] = [], draftRelease = true): Draft {
  return { id: 47, draft: draftRelease, tag_name: tag, upload_url: "https://uploads.example/release{?name,label}", assets };
}

const expectedRelease = { schemaVersion: 1, tag, version: "0.1.0", commit: "a".repeat(40), releasedAt: "2026-01-01T00:00:00.000Z" };

async function inspectClassificationFailure(command: "inspect" | "inspect-first-publication-recovery") {
  const directory = await mkdtemp(join(tmpdir(), "release-api-inspect-test-"));
  const manifestPath = join(directory, "release.json");
  const preloadPath = join(directory, "mock-fetch.ts");
  const outputPath = join(directory, "state.json");
  const token = "classification-token-secret";
  const rawPayloadMarker = "classification-raw-payload-secret";
  const assetUrl = "https://private.example/classification-asset-secret";
  await Bun.write(manifestPath, JSON.stringify(expectedRelease));
  await Bun.write(preloadPath, [
    "globalThis.fetch = async (input) => {",
    "  const url = String(input);",
    "  if (url === 'https://pages.example/release.json') return Response.json({ token: 'classification-token-secret', raw: 'classification-raw-payload-secret', asset: 'https://private.example/classification-asset-secret' });",
    "  if (url === 'https://api.github.com/repos/owner/repository/releases?per_page=100&page=1') return Response.json([{ id: 47, draft: true, tag_name: 'v0.1.0', upload_url: 'https://private.example/classification-upload-secret', assets: [{ id: 99, name: 'classification-asset-secret', url: 'https://private.example/classification-asset-secret', browser_download_url: 'https://private.example/classification-download-secret' }], token: 'classification-token-secret', raw: 'classification-raw-payload-secret' }]);",
    "  throw new Error(`Unexpected fetch: ${url}`);",
    "};",
  ].join("\n"));
  const argumentsForCommand = [process.execPath, "--preload", preloadPath, "scripts/release-api.ts", command, "--repository", repository, "--base-url", "https://pages.example", "--tag", tag, "--expected-release", manifestPath, "--out", outputPath, "--token-env", "RELEASE_API_TEST_TOKEN"];
  if (command === "inspect-first-publication-recovery") argumentsForCommand.push("--phase", "pre-draft");
  const child = Bun.spawn(argumentsForCommand, { cwd: repositoryRoot, env: { ...process.env, RELEASE_API_TEST_TOKEN: token }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  await rm(directory, { recursive: true, force: true });
  return { assetUrl, exitCode, rawPayloadMarker, stderr, token };
}

function classificationDiagnostic(stderr: string): Record<string, unknown> {
  const line = stderr.split("\n").find((candidate) => candidate.startsWith("{"));
  if (!line) throw new Error(`Classification failure diagnostic is missing: ${stderr}`);
  return JSON.parse(line) as Record<string, unknown>;
}

describe("GitHub release API client", () => {
  for (const command of ["inspect", "inspect-first-publication-recovery"] as const) {
    test(`${command} emits normalized classification diagnostics without leaking raw state`, async () => {
      const { assetUrl, exitCode, rawPayloadMarker, stderr, token } = await inspectClassificationFailure(command);
      const diagnostic = classificationDiagnostic(stderr);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Live release.json is malformed.");
      expect(Object.keys(diagnostic)).toEqual(["liveRelease", "targetRelease", "repositoryReleases"]);
      expect(diagnostic.liveRelease).toBeNull();
      expect(diagnostic.targetRelease).toEqual({ id: 47, tag, draft: true });
      expect(diagnostic.repositoryReleases).toEqual([{ id: 47, tag, draft: true }]);
      expect(Object.keys(diagnostic.targetRelease as Record<string, unknown>)).toEqual(["id", "tag", "draft"]);
      for (const release of diagnostic.repositoryReleases as Record<string, unknown>[]) expect(Object.keys(release)).toEqual(["id", "tag", "draft"]);
      for (const secret of [assetUrl, rawPayloadMarker, token]) expect(stderr).not.toContain(secret);
    });
  }

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
      if (assetName(url)) return new Response(bytes.get(assetName(url)!));
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
    const divergent = draft([asset(assetNames[0])]);
    const requestFor = (current: Draft) => async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input); calls.push(url);
      if (url.endsWith("page=1")) return Response.json([current]);
      if (assetName(url) && current === divergent) return new Response("different bytes");
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
    const requestFor = (current: Draft, altered = false) => async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("page=1")) return Response.json([current]);
      if (assetName(url)) return new Response(altered ? "different bytes" : bytes.get(assetName(url)!));
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      const missing = draft(assetNames.slice(1).map(asset));
      const extra = draft([...assetNames.map(asset), asset("unexpected.txt")]);
      const altered = draft(assetNames.map(asset));
      for (const [current, message] of [[missing, "missing required asset"], [extra, "unexpected asset"], [altered, "diverges"]] as const) {
        await expect(createGitHubReleaseClient("test-token", requestFor(current, current === altered) as typeof fetch).assertDraft("owner/repository", tag, bundle)).rejects.toThrow(message);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("downloads direct 200 responses through authenticated API endpoints instead of draft browser URLs", async () => {
    const { directory, bundle } = await temporaryBundle();
    const bytes = new Map<string, Uint8Array>(); const calls: Array<{ url: string; headers: Headers }> = [];
    for (const name of assetNames) bytes.set(name, new Uint8Array(await Bun.file(join(directory, name)).arrayBuffer()));
    const current = draft(assetNames.map(asset));
    const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input); calls.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith("page=1")) return Response.json([current]);
      if (assetName(url)) return new Response(bytes.get(assetName(url)!));
      if (url.includes("/releases/download/")) return new Response("draft browser URL must not be called", { status: 404 });
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      await createGitHubReleaseClient("test-token", request as typeof fetch).assertDraft(repository, tag, bundle);
      const downloads = calls.filter(({ url }) => assetName(url));
      expect(downloads.map(({ url }) => url)).toEqual(assetNames.map(assetUrl));
      for (const { headers } of downloads) {
        expect(headers.get("Authorization")).toBe("Bearer test-token");
        expect(headers.get("Accept")).toBe("application/octet-stream");
      }
      expect(calls.some(({ url }) => url.includes("/releases/download/"))).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("follows one trusted release-asset redirect without forwarding GitHub credentials", async () => {
    const { directory, bundle } = await temporaryBundle();
    const bytes = new Map<string, Uint8Array>(); const calls: Array<{ url: string; init?: RequestInit }> = [];
    for (const name of assetNames) bytes.set(name, new Uint8Array(await Bun.file(join(directory, name)).arrayBuffer()));
    const current = draft(assetNames.map(asset));
    const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("page=1")) return Response.json([current]);
      const apiAsset = assetName(url);
      if (apiAsset) return new Response(null, { status: 302, headers: { Location: signedAssetUrl(apiAsset) } });
      const signedAsset = signedAssetName(url);
      if (signedAsset) return new Response(bytes.get(signedAsset));
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      await createGitHubReleaseClient("test-token", request as typeof fetch).assertDraft(repository, tag, bundle);
      const apiDownloads = calls.filter(({ url }) => assetName(url));
      const signedDownloads = calls.filter(({ url }) => signedAssetName(url));
      expect(apiDownloads).toHaveLength(assetNames.length);
      expect(signedDownloads).toHaveLength(assetNames.length);
      for (const { init } of apiDownloads) {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
        expect(init?.redirect).toBe("manual");
      }
      for (const { init } of signedDownloads) {
        expect(new Headers(init?.headers).get("Authorization")).toBeNull();
        expect(new Headers(init?.headers).get("X-GitHub-Api-Version")).toBeNull();
        expect(new Headers(init?.headers).get("Accept")).toBeNull();
        expect(init?.redirect).toBe("manual");
        expect(init?.credentials).toBe("omit");
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("follows redirects to the exact legacy GitHub release-asset host", async () => {
    const { directory, bundle } = await temporaryBundle();
    const legacyHost = "github-production-release-asset-2e65be.s3.amazonaws.com";
    const bytes = new Map<string, Uint8Array>();
    for (const name of assetNames) bytes.set(name, new Uint8Array(await Bun.file(join(directory, name)).arrayBuffer()));
    const current = draft(assetNames.map(asset));
    const request = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("page=1")) return Response.json([current]);
      const apiAsset = assetName(url);
      if (apiAsset) return new Response(null, { status: 302, headers: { Location: signedAssetUrl(apiAsset, legacyHost) } });
      const signedAsset = signedAssetName(url, legacyHost);
      if (signedAsset) return new Response(bytes.get(signedAsset));
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      await createGitHubReleaseClient("test-token", request as typeof fetch).assertDraft(repository, tag, bundle);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("rejects missing, malformed, and untrusted release-asset redirects", async () => {
    const { directory, bundle } = await temporaryBundle();
    const redirects = [
      { location: null, message: "missing Location" },
      { location: "not a URL", message: "Location is malformed" },
      { location: "https://assets.example/release", message: "not a trusted HTTPS release asset URL" },
      { location: "http://release-assets.githubusercontent.com/release", message: "not a trusted HTTPS release asset URL" },
      { location: "https://user:password@release-assets.githubusercontent.com/release", message: "not a trusted HTTPS release asset URL" },
      { location: "https://release-assets.githubusercontent.com:444/release", message: "not a trusted HTTPS release asset URL" },
    ];
    const requestFor = (location: string | null) => async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("page=1")) return Response.json([draft(assetNames.map(asset))]);
      if (assetName(url)) return new Response(null, { status: 302, headers: location ? { Location: location } : undefined });
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      for (const { location, message } of redirects) await expect(createGitHubReleaseClient("test-token", requestFor(location) as typeof fetch).assertDraft(repository, tag, bundle)).rejects.toThrow(message);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("rejects a redirect from an otherwise trusted signed release-asset URL", async () => {
    const { directory, bundle } = await temporaryBundle();
    const current = draft(assetNames.map(asset)); const calls: string[] = [];
    const request = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input); calls.push(url);
      if (url.endsWith("page=1")) return Response.json([current]);
      const apiAsset = assetName(url);
      if (apiAsset) return new Response(null, { status: 302, headers: { Location: signedAssetUrl(apiAsset) } });
      if (signedAssetName(url)) return new Response(null, { status: 302, headers: { Location: signedAssetUrl(assetNames[1]) } });
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      await expect(createGitHubReleaseClient("test-token", request as typeof fetch).assertDraft(repository, tag, bundle)).rejects.toThrow("signed URL returned an unexpected redirect or response: 302");
      expect(calls.filter((url) => signedAssetName(url))).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("fails closed for missing or duplicate asset IDs and malformed or mismatched API URLs", async () => {
    const { directory, bundle } = await temporaryBundle();
    const malformed = { ...asset(assetNames[0]), url: "not a URL" };
    const mismatched = { ...asset(assetNames[0]), url: "https://api.github.com/repos/other/repository/releases/assets/100" };
    const duplicate = [asset(assetNames[0]), { ...asset(assetNames[1]), id: assetId(assetNames[0]) }, ...assetNames.slice(2).map(asset)];
    const requestFor = (current: unknown) => async (input: RequestInfo | URL): Promise<Response> => String(input).endsWith("page=1") ? Response.json([current]) : new Response("unexpected", { status: 500 });
    try {
      await expect(createGitHubReleaseClient("test-token", requestFor({ ...draft(), assets: [{ ...asset(assetNames[0]), id: 0 }] }) as typeof fetch).assertDraft(repository, tag, bundle)).rejects.toThrow("unexpected release");
      await expect(createGitHubReleaseClient("test-token", requestFor(draft([malformed, ...assetNames.slice(1).map(asset)])) as typeof fetch).assertDraft(repository, tag, bundle)).rejects.toThrow("malformed API URL");
      await expect(createGitHubReleaseClient("test-token", requestFor(draft([mismatched, ...assetNames.slice(1).map(asset)])) as typeof fetch).assertDraft(repository, tag, bundle)).rejects.toThrow("does not match its repository and ID");
      await expect(createGitHubReleaseClient("test-token", requestFor(draft(duplicate)) as typeof fetch).assertDraft(repository, tag, bundle)).rejects.toThrow("duplicate asset ID");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("rejects non-default asset API ports before requesting the download", async () => {
    const { directory, bundle } = await temporaryBundle();
    const requests: string[] = [];
    const assetWithNonDefaultPort = { ...asset(assetNames[0]), url: `https://api.github.com:444/repos/${repository}/releases/assets/${assetId(assetNames[0])}` };
    const request = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input); requests.push(url);
      if (url.endsWith("page=1")) return Response.json([draft([assetWithNonDefaultPort, ...assetNames.slice(1).map(asset)])]);
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      await expect(createGitHubReleaseClient("test-token", request as typeof fetch).assertDraft(repository, tag, bundle)).rejects.toThrow("does not match its repository and ID");
      expect(requests).toEqual([`https://api.github.com/repos/${repository}/releases?per_page=100&page=1`]);
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
      if (assetName(url)) return new Response(bytes.get(assetName(url)!));
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
    let divergentDraft: Draft | undefined;
    const requestFor = (responses: () => Draft[], patch?: (current: Draft) => void) => async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("page=1")) return Response.json(responses());
      if (assetName(url) && responses()[0] === divergentDraft) return new Response("different bytes");
      if (assetName(url)) return new Response(bytes.get(assetName(url)!));
      if (url.endsWith("/releases/47") && init?.method === "PATCH") { patch?.(responses()[0]!); return Response.json({}); }
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      const current = draft(assetNames.map(asset));
      await expect(createGitHubReleaseClient("test-token", requestFor(() => [current]) as typeof fetch).publishExactRelease("owner/repository", tag, bundle, 48)).rejects.toThrow("ID changed");

      const extraRelease = { ...draft(), id: 48, tag_name: "v0.1.1" };
      await expect(createGitHubReleaseClient("test-token", requestFor(() => [draft(assetNames.map(asset)), extraRelease]) as typeof fetch).publishExactRelease("owner/repository", tag, bundle, 47)).rejects.toThrow("sole repository release");

      divergentDraft = draft(assetNames.map(asset));
      await expect(createGitHubReleaseClient("test-token", requestFor(() => [divergentDraft!]) as typeof fetch).publishExactRelease("owner/repository", tag, bundle, 47)).rejects.toThrow("diverges");

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
      if (assetName(url)) {
        const name = assetName(url)!; downloaded.push(name);
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
