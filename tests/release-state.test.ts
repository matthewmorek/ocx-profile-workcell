import { describe, expect, test } from "bun:test";
import { classifyFailedFirstPublicationRecovery, classifyProductionState, type ReleaseManifest } from "../scripts/release-state";

const target: ReleaseManifest = { schemaVersion: 1, tag: "v0.2.0", version: "0.2.0", commit: "b".repeat(40), releasedAt: "2026-08-18T00:00:00.000Z" };
const first: ReleaseManifest = { ...target, tag: "v0.1.0", version: "0.1.0" };
const live = (version: string): ReleaseManifest => ({ ...target, tag: `v${version}`, version });
const release = (tag: string, draft: boolean) => ({ id: 1, draft, tag_name: tag, assets: [] });
const state = (overrides: Partial<Parameters<typeof classifyProductionState>[0]> = {}) => ({ target, live: null, targetRelease: null, liveRelease: null, repositoryReleases: [], ...overrides });

describe("production release state classification", () => {
  test("allows failed first-publication recovery only with no release or its sole matching draft", () => {
    const recoveryState = (overrides: Partial<Parameters<typeof classifyFailedFirstPublicationRecovery>[0]> = {}) => ({ target: first, live: null, targetRelease: null, repositoryReleases: [], ...overrides });
    const matchingDraft = release(first.tag, true);
    expect(classifyFailedFirstPublicationRecovery(recoveryState())).toEqual({ kind: "first-publication" });
    expect(classifyFailedFirstPublicationRecovery(recoveryState({ targetRelease: matchingDraft, repositoryReleases: [matchingDraft] }))).toEqual({ kind: "resume-draft" });
    expect(() => classifyFailedFirstPublicationRecovery(recoveryState({ live: first }))).toThrow("no live Pages");
    expect(() => classifyFailedFirstPublicationRecovery(recoveryState({ targetRelease: release(first.tag, false), repositoryReleases: [release(first.tag, false)] }))).toThrow("exact matching draft");
    expect(() => classifyFailedFirstPublicationRecovery(recoveryState({ repositoryReleases: [release("v0.0.9", true)] }))).toThrow("unexpected release state");
  });

  test("allows only a truly absent v0.1.0 first publication", () => {
    expect(classifyProductionState(state({ target: first }))).toEqual({ kind: "first-publication" });
    expect(classifyProductionState(state({ target: first, targetRelease: release(first.tag, true), repositoryReleases: [release(first.tag, true)] }))).toEqual({ kind: "first-publication" });
    expect(() => classifyProductionState(state())).toThrow("Only v0.1.0");
    expect(() => classifyProductionState(state({ target: first, targetRelease: release(first.tag, false), repositoryReleases: [release(first.tag, false)] }))).toThrow("Published GitHub Release exists");
    expect(() => classifyProductionState(state({ target: first, repositoryReleases: [{ ...release("v9.9.9", false), id: 2 }] }))).toThrow("Published GitHub Release exists");
  });

  test("requires a consistent published prior release before monotonic deployment", () => {
    expect(classifyProductionState(state({ live: live("0.1.0"), liveRelease: release("v0.1.0", false), repositoryReleases: [release("v0.1.0", false)] }))).toEqual({ kind: "release-with-recovery", recoveryTag: "v0.1.0" });
    expect(() => classifyProductionState(state({ live: live("0.1.0"), liveRelease: release("v0.1.0", true), repositoryReleases: [release("v0.1.0", true)] }))).toThrow("recovery release");
    expect(() => classifyProductionState(state({ live: live("0.3.0"), liveRelease: release("v0.3.0", false), repositoryReleases: [release("v0.3.0", false)] }))).toThrow("newer");
    expect(() => classifyProductionState(state({ live: live("0.1.0-01"), liveRelease: release("v0.1.0-01", false), repositoryReleases: [release("v0.1.0-01", false)] }))).toThrow("malformed");
  });

  test("resumes exact drafts and no-ops exact published releases", () => {
    expect(classifyProductionState(state({ live: target, targetRelease: release(target.tag, true), liveRelease: release(target.tag, true), repositoryReleases: [release(target.tag, true)] }))).toEqual({ kind: "resume-draft" });
    expect(classifyProductionState(state({ live: target, targetRelease: release(target.tag, false), liveRelease: release(target.tag, false), repositoryReleases: [release(target.tag, false)] }))).toEqual({ kind: "published-noop" });
  });

  test("fails closed for malformed or inconsistent equal state", () => {
    expect(() => classifyProductionState(state({ live: { ...target, commit: "wrong" }, targetRelease: release(target.tag, true), liveRelease: release(target.tag, true) }))).toThrow("malformed");
    expect(() => classifyProductionState(state({ live: { tag: target.tag }, targetRelease: release(target.tag, true) }))).toThrow("malformed");
    expect(() => classifyProductionState(state({ live: target, targetRelease: release("v0.2.1", true), liveRelease: release(target.tag, true) }))).toThrow("inconsistent");
    expect(() => classifyProductionState(state({ live: target, targetRelease: release(target.tag, true), liveRelease: { id: "bad" } }))).toThrow("Live GitHub Release state is malformed");
    expect(() => classifyProductionState(state({ live: target, targetRelease: release(target.tag, true), liveRelease: release("v0.1.0", false) }))).toThrow("Live GitHub Release tag is inconsistent");
  });
});
