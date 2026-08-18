import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubReleaseClient } from "../scripts/release-api";
import { sha256 } from "../scripts/common";

const tag = "v0.1.0";
const assetNames = [`ocx-workspace-profile-${tag}.tar.gz`, "provenance.json", "receipt.jsonc", "SHA256SUMS"];

async function temporaryBundle() {
  const directory = await mkdtemp(join(tmpdir(), "release-api-test-"));
  const assets = await Promise.all(assetNames.map(async (name) => {
    const path = join(directory, name);
    const bytes = new TextEncoder().encode(name);
    await Bun.write(path, bytes);
    return { path, name, sha256: sha256(bytes) };
  }));
  return { directory, bundle: { tag, version: "0.1.0", assets } };
}

describe("GitHub release API client", () => {
  test("uploads only absent immutable draft assets", async () => {
    const { directory, bundle } = await temporaryBundle();
    const uploaded: string[] = [];
    const draft = { id: 1, draft: true, tag_name: tag, upload_url: "https://uploads.example/release{?name,label}", assets: [] as Array<{ name: string; browser_download_url: string }> };
    const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes(`/releases/tags/${tag}`)) return new Response("missing", { status: 404 });
      if (url.endsWith("/releases") && init?.method === "POST") return Response.json(draft);
      if (url.startsWith("https://uploads.example/")) { uploaded.push(new URL(url).searchParams.get("name")!); return Response.json({}); }
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      await createGitHubReleaseClient("test-token", request as typeof fetch).ensureDraft("owner/repository", tag, bundle);
      expect(uploaded).toEqual(assetNames);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("rejects a divergent asset without issuing an overwrite", async () => {
    const { directory, bundle } = await temporaryBundle();
    const draft = { id: 1, draft: true, tag_name: tag, upload_url: "https://uploads.example/release{?name,label}", assets: [{ name: assetNames[0], browser_download_url: "https://assets.example/archive" }] };
    const request = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes(`/releases/tags/${tag}`)) return Response.json(draft);
      if (url === "https://assets.example/archive") return new Response("different bytes");
      throw new Error(`Unexpected request ${url}`);
    };
    try {
      await expect(createGitHubReleaseClient("test-token", request as typeof fetch).ensureDraft("owner/repository", tag, bundle)).rejects.toThrow("diverges");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
