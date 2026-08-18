import { describe, expect, test } from "bun:test";
import { classifyProductionState, type ReleaseManifest } from "../scripts/release-state";

const target: ReleaseManifest = { schemaVersion: 1, tag: "v0.2.0", version: "0.2.0", commit: "b".repeat(40), releasedAt: "2026-08-18T00:00:00.000Z" };
const first: ReleaseManifest = { ...target, tag: "v0.1.0", version: "0.1.0" };
const live = (version: string): ReleaseManifest => ({ ...target, tag: `v${version}`, version });
const release = (tag: string, draft: boolean) => ({ id: 1, draft, tag_name: tag, assets: [] });

describe("production release state classification", () => {
  test("allows only a truly absent v0.1.0 first publication", () => {
    expect(classifyProductionState({ target: first, live: null, targetRelease: null, liveRelease: null })).toEqual({ kind: "first-publication" });
    expect(classifyProductionState({ target: first, live: null, targetRelease: release(first.tag, true), liveRelease: null })).toEqual({ kind: "first-publication" });
    expect(() => classifyProductionState({ target, live: null, targetRelease: null, liveRelease: null })).toThrow("Only v0.1.0");
    expect(() => classifyProductionState({ target: first, live: null, targetRelease: release(first.tag, false), liveRelease: null })).toThrow("Published GitHub Release exists");
  });

  test("requires a consistent published prior release before monotonic deployment", () => {
    expect(classifyProductionState({ target, live: live("0.1.0"), targetRelease: null, liveRelease: release("v0.1.0", false) })).toEqual({ kind: "release-with-recovery", recoveryTag: "v0.1.0" });
    expect(() => classifyProductionState({ target, live: live("0.1.0"), targetRelease: null, liveRelease: release("v0.1.0", true) })).toThrow("recovery release");
    expect(() => classifyProductionState({ target, live: live("0.3.0"), targetRelease: null, liveRelease: release("v0.3.0", false) })).toThrow("newer");
    expect(() => classifyProductionState({ target, live: live("0.1.0-01"), targetRelease: null, liveRelease: release("v0.1.0-01", false) })).toThrow("malformed");
  });

  test("resumes exact drafts and no-ops exact published releases", () => {
    expect(classifyProductionState({ target, live: target, targetRelease: release(target.tag, true), liveRelease: release(target.tag, true) })).toEqual({ kind: "resume-draft" });
    expect(classifyProductionState({ target, live: target, targetRelease: release(target.tag, false), liveRelease: release(target.tag, false) })).toEqual({ kind: "published-noop" });
  });

  test("fails closed for malformed or inconsistent equal state", () => {
    expect(() => classifyProductionState({ target, live: { ...target, commit: "wrong" }, targetRelease: release(target.tag, true), liveRelease: release(target.tag, true) })).toThrow("malformed");
    expect(() => classifyProductionState({ target, live: { tag: target.tag }, targetRelease: release(target.tag, true), liveRelease: null })).toThrow("malformed");
    expect(() => classifyProductionState({ target, live: target, targetRelease: release("v0.2.1", true), liveRelease: release(target.tag, true) })).toThrow("inconsistent");
    expect(() => classifyProductionState({ target, live: target, targetRelease: release(target.tag, true), liveRelease: { id: "bad" } })).toThrow("Live GitHub Release state is malformed");
    expect(() => classifyProductionState({ target, live: target, targetRelease: release(target.tag, true), liveRelease: release("v0.1.0", false) })).toThrow("Live GitHub Release tag is inconsistent");
  });
});
