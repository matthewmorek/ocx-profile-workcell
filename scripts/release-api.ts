import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fail, parseArguments, parseTag, readJsonc, requiredArgument, resolvedInside, sha256, sha256File, writeJsonAtomic } from "./common";
import { classifyFailedFirstPublicationRecovery, classifyProductionState, parseReleaseManifest, parseRemoteRelease, type FailedFirstPublicationRecoveryPhase, type RemoteRelease } from "./release-state";

type ReleaseAsset = Readonly<{ id: number; name: string; url: string; browser_download_url?: string }>;
type Release = RemoteRelease & Readonly<{ upload_url: string; assets: readonly ReleaseAsset[] }>;
type FetchLike = typeof fetch;
type BundleAsset = Readonly<{ path: string; name: string; sha256: string }>;
type ReleaseBundle = Readonly<{ tag: string; version: string; path: string; assets: readonly BundleAsset[] }>;
type ReleaseIdentityDiagnostic = Readonly<{ id: number | null; tag: string | null; draft: boolean | null }>;
type LiveReleaseIdentityDiagnostic = Readonly<{ tag: string; version: string; commit: string; releasedAt: string }> | null;

export const releaseApiCommands = ["inspect", "inspect-first-publication-recovery", "ensure-draft", "assert-draft", "download", "publish", "publish-exact"] as const;
type ReleaseApiCommand = typeof releaseApiCommands[number];
const releaseApiCommandArguments = {
  inspect: ["--repository", "--base-url", "--tag", "--expected-release", "--out", "--token-env"],
  "inspect-first-publication-recovery": ["--repository", "--base-url", "--tag", "--expected-release", "--out", "--token-env", "--phase"],
  "ensure-draft": ["--repository", "--tag", "--bundle", "--token-env"],
  "assert-draft": ["--repository", "--tag", "--bundle", "--token-env"],
  download: ["--repository", "--tag", "--out-dir", "--token-env"],
  publish: ["--repository", "--tag", "--token-env"],
  "publish-exact": ["--repository", "--tag", "--bundle", "--expected-release-id", "--token-env"],
} as const satisfies Record<ReleaseApiCommand, readonly string[]>;

const apiHeaders = (token: string): HeadersInit => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

const assetDownloadHeaders = (token: string): HeadersInit => ({ ...apiHeaders(token), Accept: "application/octet-stream" });
const trustedReleaseAssetHosts = new Set([
  "release-assets.githubusercontent.com",
  "github-production-release-asset-2e65be.s3.amazonaws.com",
]);

function requiredToken(values: Map<string, string>): string {
  const value = process.env[requiredArgument(values, "--token-env")];
  if (!value) fail("Release API token environment variable is unset.");
  return value;
}

function bundleAssetNames(tag: string): readonly string[] {
  return [`ocx-workspace-profile-${tag}.tar.gz`, "provenance.json", "receipt.jsonc", "SHA256SUMS"];
}

function parseReleaseId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) fail("Expected release ID must be a positive integer.");
  const releaseId = Number(value);
  if (!Number.isSafeInteger(releaseId)) fail("Expected release ID must be a safe integer.");
  return releaseId;
}

function parseAssetId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function parseReleaseBundle(value: unknown, tag: string, bundlePath: string): ReleaseBundle {
  const manifestPath = resolve(bundlePath);
  const manifestRoot = dirname(manifestPath);
  if (!value || typeof value !== "object") fail("Release bundle is malformed.");
  const bundle = value as Record<string, unknown>;
  if (bundle.schemaVersion !== 1 || bundle.tag !== tag || bundle.version !== tag.slice(1) || !Array.isArray(bundle.assets)) fail("Release bundle tag or assets are malformed.");
  const assets = bundle.assets.map((asset): BundleAsset => {
    if (!asset || typeof asset !== "object") fail("Release bundle contains a malformed asset.");
    const candidate = asset as Record<string, unknown>;
    if (typeof candidate.path !== "string" || typeof candidate.name !== "string" || typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256) || isAbsolute(candidate.path) || candidate.path.includes("\\") || candidate.path.includes(":") || candidate.path.split("/").some((part) => !part || part === "." || part === "..") || basename(candidate.path) !== candidate.name) fail("Release bundle contains an unsafe asset.");
    return { path: resolvedInside(manifestRoot, candidate.path), name: candidate.name, sha256: candidate.sha256 };
  });
  const expected = bundleAssetNames(tag);
  if (assets.length !== expected.length || new Set(assets.map(({ name }) => name)).size !== expected.length || assets.some(({ name }) => !expected.includes(name))) fail("Release bundle asset set is incomplete or unexpected.");
  return { tag, version: bundle.version, path: manifestPath, assets };
}

async function immutableBundleAssets(bundle: ReleaseBundle): Promise<readonly BundleAsset[]> {
  return bundle.assets;
}

function parseRelease(value: unknown): Release | undefined {
  const base = parseRemoteRelease(value);
  if (!base || !value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.upload_url !== "string" || !Array.isArray(candidate.assets)) return undefined;
  const assets = candidate.assets.map((asset): ReleaseAsset | undefined => {
    if (!asset || typeof asset !== "object") return undefined;
    const item = asset as Record<string, unknown>;
    const id = parseAssetId(item.id);
    if (!id || typeof item.name !== "string" || !item.name || typeof item.url !== "string") return undefined;
    return typeof item.browser_download_url === "string" ? { id, name: item.name, url: item.url, browser_download_url: item.browser_download_url } : { id, name: item.name, url: item.url };
  });
  if (assets.some((asset) => !asset)) return undefined;
  return { ...base, upload_url: candidate.upload_url, assets: assets as ReleaseAsset[] };
}

function selectRelease(releases: readonly Release[], tag: string): Release | undefined {
  const matching = releases.filter((release) => release.tag_name === tag);
  if (matching.length > 1) fail(`GitHub contains multiple releases for ${tag}.`);
  return matching[0];
}

function normalizedReleaseIdentity(release: RemoteRelease | undefined): ReleaseIdentityDiagnostic {
  if (!release) return { id: null, tag: null, draft: null };
  return { id: release.id, tag: release.tag_name, draft: release.draft };
}

function normalizedLiveReleaseIdentity(live: unknown | null): LiveReleaseIdentityDiagnostic {
  if (live === null) return null;
  const manifest = parseReleaseManifest(live);
  if (!manifest) return null;
  return { tag: manifest.tag, version: manifest.version, commit: manifest.commit, releasedAt: manifest.releasedAt };
}

function reportClassificationFailure(live: unknown | null, targetRelease: RemoteRelease | undefined, releases: readonly RemoteRelease[]): void {
  console.error(JSON.stringify({
    liveRelease: normalizedLiveReleaseIdentity(live),
    targetRelease: normalizedReleaseIdentity(targetRelease),
    repositoryReleases: releases.map(normalizedReleaseIdentity),
  }));
}

export function createGitHubReleaseClient(token: string, request: FetchLike = fetch) {
  async function requestApi(url: string, init?: RequestInit): Promise<Response> {
    const response = await request(url.startsWith("https://") ? url : `https://api.github.com${url}`, { ...init, headers: { ...apiHeaders(token), ...init?.headers } });
    if (!response.ok) fail(`GitHub API ${url} failed: ${response.status} ${await response.text()}`);
    return response;
  }

  async function listReleases(repository: string): Promise<readonly Release[]> {
    const releases: Release[] = [];
    let url: string | undefined = `/repos/${repository}/releases?per_page=100&page=1`;
    while (url) {
      const response = await requestApi(url);
      const page = await response.json();
      if (!Array.isArray(page)) fail("GitHub release listing has an unexpected shape.");
      for (const value of page) {
        const release = parseRelease(value);
        if (!release) fail("GitHub release listing contains an unexpected release.");
        releases.push(release);
      }
      const next = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      if (next && !next.startsWith("https://api.github.com/")) fail("GitHub release pagination returned an unsafe next link.");
      url = next;
    }
    return releases;
  }

  async function getRelease(repository: string, tag: string): Promise<Release | undefined> { return selectRelease(await listReleases(repository), tag); }

  function validatedAssetApiUrl(repository: string, asset: ReleaseAsset): string {
    let url: URL;
    try { url = new URL(asset.url); }
    catch { fail(`Release asset ${asset.name} has a malformed API URL.`); }
    const expectedPath = `/repos/${repository}/releases/assets/${asset.id}`;
    if (url.origin !== "https://api.github.com" || url.username || url.password || url.search || url.hash || url.pathname !== expectedPath) fail(`Release asset ${asset.name} API URL does not match its repository and ID.`);
    return url.toString();
  }

  function trustedReleaseAssetRedirect(asset: ReleaseAsset, location: string | null): URL {
    if (!location) fail(`Release asset ${asset.name} redirect is missing Location.`);
    let url: URL;
    try { url = new URL(location); }
    catch { fail(`Release asset ${asset.name} redirect Location is malformed.`); }
    if (url.protocol !== "https:" || url.username || url.password || url.port || !trustedReleaseAssetHosts.has(url.hostname)) fail(`Release asset ${asset.name} redirect Location is not a trusted HTTPS release asset URL.`);
    return url;
  }

  async function downloadAsset(repository: string, asset: ReleaseAsset): Promise<Uint8Array> {
    const apiUrl = validatedAssetApiUrl(repository, asset);
    const response = await request(apiUrl, { headers: assetDownloadHeaders(token), redirect: "manual" });
    if (response.redirected || (response.url && response.url !== apiUrl)) {
      fail(`Release asset ${asset.name} returned an unexpected response URL.`);
    }
    if (response.status === 200) return new Uint8Array(await response.arrayBuffer());
    if (response.status !== 302) fail(`Unable to download release asset ${asset.name}: ${response.status}.`);
    const signedAssetUrl = trustedReleaseAssetRedirect(asset, response.headers.get("location"));
    const signedResponse = await request(signedAssetUrl, { redirect: "manual", credentials: "omit" });
    if (signedResponse.redirected || signedResponse.status !== 200) fail(`Release asset ${asset.name} signed URL returned an unexpected redirect or response: ${signedResponse.status}.`);
    return new Uint8Array(await signedResponse.arrayBuffer());
  }

  function assertDistinctAssetIds(assets: readonly ReleaseAsset[]): void {
    const ids = new Set<number>();
    for (const asset of assets) {
      if (ids.has(asset.id)) fail(`Release contains duplicate asset ID ${asset.id}.`);
      ids.add(asset.id);
    }
  }

  async function assertReleaseAssets(repository: string, current: Release, assets: readonly BundleAsset[], requireAll: boolean): Promise<void> {
    const existingByName = new Map<string, ReleaseAsset>();
    assertDistinctAssetIds(current.assets);
    for (const asset of current.assets) {
      if (existingByName.has(asset.name)) fail(`Release contains duplicate asset ${asset.name}.`);
      existingByName.set(asset.name, asset);
    }
    const expectedByName = new Map(assets.map((asset) => [asset.name, asset]));
    for (const asset of current.assets) if (!expectedByName.has(asset.name)) fail(`Release contains unexpected asset ${asset.name}.`);
    for (const expected of assets) {
      const localHash = await sha256File(expected.path);
      if (localHash !== expected.sha256) fail(`Workflow asset ${expected.name} does not match its immutable bundle hash.`);
      const existing = existingByName.get(expected.name);
      if (!existing) {
        if (requireAll) fail(`Published release is missing required asset ${expected.name}.`);
        continue;
      }
      if (sha256(await downloadAsset(repository, existing)) !== expected.sha256) fail(`Existing release asset ${expected.name} diverges; refusing overwrite.`);
    }
  }

  async function ensureDraft(repository: string, tag: string, bundle: ReleaseBundle): Promise<void> {
    const assets = await immutableBundleAssets(bundle);
    let current = await getRelease(repository, tag);
    if (!current) {
      const created = await request(`https://api.github.com/repos/${repository}/releases`, { method: "POST", headers: apiHeaders(token), body: JSON.stringify({ tag_name: tag, name: tag, draft: true, prerelease: false }) });
      if (created.status === 422) {
        current = await getRelease(repository, tag);
        if (!current) fail("GitHub rejected draft creation but no matching release exists.");
      } else {
        if (!created.ok) fail(`GitHub API /repos/${repository}/releases failed: ${created.status} ${await created.text()}`);
        current = parseRelease(await created.json());
        if (!current) fail("Created GitHub Release has an unexpected shape.");
      }
    }
    await assertReleaseAssets(repository, current, assets, !current.draft);
    if (!current.draft) return;
    const existingNames = new Set(current.assets.map(({ name }) => name));
    for (const asset of assets) {
      if (existingNames.has(asset.name)) continue;
      const uploaded = await request(`${current.upload_url.replace("{?name,label}", "")}?name=${encodeURIComponent(asset.name)}`, {
        method: "POST",
        headers: { ...apiHeaders(token), "Content-Type": "application/octet-stream" },
        body: await readFile(asset.path),
      });
      if (!uploaded.ok) fail(`Could not upload ${asset.name}: ${uploaded.status} ${await uploaded.text()}`);
    }
    const complete = await getRelease(repository, tag);
    if (!complete) fail("GitHub Release disappeared after asset upload.");
    await assertReleaseAssets(repository, complete, assets, true);
  }

  async function assertDraft(repository: string, tag: string, bundle: ReleaseBundle): Promise<void> {
    const current = await getRelease(repository, tag);
    if (!current || !current.draft) fail("Exact recovery draft does not exist.");
    await assertReleaseAssets(repository, current, await immutableBundleAssets(bundle), true);
  }

  async function downloadRelease(repository: string, tag: string, destination: string): Promise<void> {
    const current = await getRelease(repository, tag);
    if (!current || current.draft) fail(`Requested published release ${tag} does not exist.`);
    const expectedNames = bundleAssetNames(tag);
    if (current.assets.length !== expectedNames.length || new Set(current.assets.map(({ name }) => name)).size !== expectedNames.length || current.assets.some(({ name }) => !expectedNames.includes(name))) fail(`Release ${tag} does not have the immutable asset set.`);
    assertDistinctAssetIds(current.assets);
    await mkdir(destination, { recursive: true });
    for (const asset of current.assets) await Bun.write(join(destination, asset.name), await downloadAsset(repository, asset));
    const downloadedAssets = current.assets.map((asset) => ({ path: join(destination, asset.name), name: asset.name, sha256: "" }));
    for (const asset of downloadedAssets) {
      if (!await Bun.file(asset.path).exists()) fail(`Downloaded release asset is missing: ${asset.name}.`);
    }
  }

  async function publishRelease(repository: string, tag: string): Promise<void> {
    const current = await getRelease(repository, tag);
    if (!current) fail("Release draft does not exist.");
    if (!current.draft) return;
    await requestApi(`/repos/${repository}/releases/${current.id}`, { method: "PATCH", body: JSON.stringify({ draft: false }) });
  }

  async function publishExactRelease(repository: string, tag: string, bundle: ReleaseBundle, expectedReleaseId: number): Promise<void> {
    const assets = await immutableBundleAssets(bundle);
    const releasesBeforePublish = await listReleases(repository);
    const draft = selectRelease(releasesBeforePublish, tag);
    if (!draft) fail("Exact recovery draft does not exist.");
    if (draft.id !== expectedReleaseId) fail("Exact recovery draft ID changed before publication.");
    if (!draft.draft) fail("Exact recovery release is already published; refusing a generic no-op.");
    if (releasesBeforePublish.length !== 1) fail("Exact recovery requires the sole repository release to be the target draft.");
    await assertReleaseAssets(repository, draft, assets, true);
    await requestApi(`/repos/${repository}/releases/${draft.id}`, { method: "PATCH", body: JSON.stringify({ draft: false }) });
    const releasesAfterPublish = await listReleases(repository);
    const published = selectRelease(releasesAfterPublish, tag);
    if (!published || published.id !== expectedReleaseId || published.draft) fail("Exact recovery publication postcondition failed.");
    if (releasesAfterPublish.length !== 1) fail("Exact recovery publication changed the repository release inventory.");
    await assertReleaseAssets(repository, published, assets, true);
  }

  return { listReleases, getRelease, ensureDraft, assertDraft, downloadRelease, publishRelease, publishExactRelease };
}

async function inspect(values: Map<string, string>): Promise<void> {
  const repository = requiredArgument(values, "--repository");
  const targetTag = parseTag(requiredArgument(values, "--tag"));
  const expectedRelease = parseReleaseManifest(await readJsonc(requiredArgument(values, "--expected-release")));
  if (!expectedRelease || expectedRelease.tag !== targetTag) fail("Expected release manifest does not match the target tag.");
  const client = createGitHubReleaseClient(requiredToken(values));
  const response = await fetch(`${requiredArgument(values, "--base-url").replace(/\/$/, "")}/release.json`);
  if (!response.ok && response.status !== 404) fail(`Live release.json lookup failed: ${response.status}.`);
  const live = response.status === 404 ? null : await response.json();
  const parsedLive = live === null ? undefined : parseReleaseManifest(live);
  const releases = await client.listReleases(repository);
  let targetRelease: Release | undefined;
  const decision = (() => {
    try {
      targetRelease = selectRelease(releases, targetTag);
      const liveRelease = parsedLive ? selectRelease(releases, parsedLive.tag) : undefined;
      return classifyProductionState({ target: expectedRelease, live, targetRelease: targetRelease ?? null, liveRelease: liveRelease ?? null, repositoryReleases: releases });
    } catch (error) {
      reportClassificationFailure(live, targetRelease, releases);
      throw error;
    }
  })();
  await writeJsonAtomic(requiredArgument(values, "--out"), { schemaVersion: 1, decision, liveTag: parsedLive?.tag ?? null });
}

async function inspectFailedFirstPublicationRecovery(values: Map<string, string>): Promise<void> {
  const repository = requiredArgument(values, "--repository");
  const targetTag = parseTag(requiredArgument(values, "--tag"));
  const expectedRelease = parseReleaseManifest(await readJsonc(requiredArgument(values, "--expected-release")));
  if (!expectedRelease || expectedRelease.tag !== targetTag) fail("Expected release manifest does not match the target tag.");
  const phase = requiredArgument(values, "--phase") as FailedFirstPublicationRecoveryPhase;
  if (!["pre-draft", "pre-deploy", "pre-publish"].includes(phase)) fail("Recovery inspection phase is invalid.");
  const client = createGitHubReleaseClient(requiredToken(values));
  const response = await fetch(`${requiredArgument(values, "--base-url").replace(/\/$/, "")}/release.json`);
  if (!response.ok && response.status !== 404) fail(`Live release.json lookup failed: ${response.status}.`);
  const live = response.status === 404 ? null : await response.json();
  const releases = await client.listReleases(repository);
  let targetRelease: Release | undefined;
  const decision = (() => {
    try {
      targetRelease = selectRelease(releases, targetTag);
      return classifyFailedFirstPublicationRecovery({ target: expectedRelease, live, targetRelease: targetRelease ?? null, repositoryReleases: releases, phase });
    } catch (error) {
      reportClassificationFailure(live, targetRelease, releases);
      throw error;
    }
  })();
  await writeJsonAtomic(requiredArgument(values, "--out"), { schemaVersion: 1, decision, targetReleaseId: targetRelease?.id ?? null });
}

function parseReleaseApiCommand(value: string | undefined): ReleaseApiCommand | undefined {
  return releaseApiCommands.find((command) => command === value);
}

async function main(): Promise<void> {
  const command = parseReleaseApiCommand(Bun.argv[2]);
  const values = parseArguments(Bun.argv.slice(3), command ? releaseApiCommandArguments[command] : []);
  if (command === "inspect") return inspect(values);
  if (command === "inspect-first-publication-recovery") return inspectFailedFirstPublicationRecovery(values);
  const repository = requiredArgument(values, "--repository");
  const tag = parseTag(requiredArgument(values, "--tag"));
  const client = createGitHubReleaseClient(requiredToken(values));
  if (command === "ensure-draft") {
    const bundlePath = requiredArgument(values, "--bundle");
    return client.ensureDraft(repository, tag, parseReleaseBundle(await readJsonc(bundlePath), tag, bundlePath));
  }
  if (command === "assert-draft") {
    const bundlePath = requiredArgument(values, "--bundle");
    return client.assertDraft(repository, tag, parseReleaseBundle(await readJsonc(bundlePath), tag, bundlePath));
  }
  if (command === "download") return client.downloadRelease(repository, tag, requiredArgument(values, "--out-dir"));
  if (command === "publish") return client.publishRelease(repository, tag);
  if (command === "publish-exact") {
    const bundlePath = requiredArgument(values, "--bundle");
    return client.publishExactRelease(repository, tag, parseReleaseBundle(await readJsonc(bundlePath), tag, bundlePath), parseReleaseId(requiredArgument(values, "--expected-release-id")));
  }
  fail("Expected release-api subcommand inspect, inspect-first-publication-recovery, ensure-draft, assert-draft, download, publish, or publish-exact.");
}

if (import.meta.main) await main();
