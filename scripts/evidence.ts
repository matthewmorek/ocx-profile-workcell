import { fail } from "./common";

export type ResolvedComponent = Readonly<{ identifier: string; revision: string; sha256: string }>;
export type InstallReceipt = Readonly<{ version: 1; root: string; installed: Readonly<Record<string, unknown>> }>;
export type RootProfileIdentity = Readonly<{ source: "matthewmorek/ws"; installedName: "ws" }>;
export type ToolVersions = Readonly<{ ocx: string; opencode: string }>;
export type ValidationRecord = Readonly<{ mode: "pinned" | "advisory"; expectedToolVersions: ToolVersions | null; discoveredToolVersions: ToolVersions }>;
export type ParsedInstallReceipt = Readonly<{ receipt: InstallReceipt; resolvedDependencyComponents: readonly ResolvedComponent[] }>;
export type InstallEvidence = Readonly<{ schemaVersion: 1; version: string; commit: string; rootProfile: RootProfileIdentity; resolvedDependencyComponents: readonly ResolvedComponent[]; assertions: Readonly<Record<string, true>>; receipt: InstallReceipt; validation: ValidationRecord; attempts?: readonly InstallAttemptOutcome[] }>;
export type InstallAttemptOutcome = Readonly<{ number: number; outcome: "succeeded" | "failed"; failure?: "timeout" | "network" }>;

const sensitiveKey = /token|secret|password|api[_-]?key/i;
const machinePath = /(?:^|[\s"'=])(?:file:\/\/)?\/(?:Users|home|private|var|tmp|opt|Volumes)\//;
const machinePathValue = /(^|[\s"'=])(?:file:\/\/)?\/(?:Users|home|private|var|tmp|opt|Volumes)\/[^\s"']+/g;
const requiredComponents = ["kdco/workspace", "matthewmorek/ws-overrides"];
const expectedRootProfile = { source: "matthewmorek/ws", installedName: "ws" } as const;

export function sanitizeEvidenceValue(value: unknown): unknown {
  if (typeof value === "string") return value.replace(machinePathValue, "$1<redacted-path>");
  if (Array.isArray(value)) return value.map(sanitizeEvidenceValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !sensitiveKey.test(key)).map(([key, entry]) => [key, sanitizeEvidenceValue(entry)]));
}
export function assertEvidenceIsSafe(value: unknown): void { const serialized = JSON.stringify(value); if (machinePath.test(serialized) || sensitiveKey.test(serialized)) fail("Evidence contains a machine path or secret-like value."); }

export function parseRootProfileIdentity(value: unknown): RootProfileIdentity {
  if (!value || typeof value !== "object") fail("Install evidence root profile identity is malformed.");
  const candidate = value as Record<string, unknown>;
  if (candidate.source !== expectedRootProfile.source || candidate.installedName !== expectedRootProfile.installedName || Object.keys(candidate).some((key) => key !== "source" && key !== "installedName")) fail("Install evidence root profile must identify matthewmorek/ws installed as ws.");
  return expectedRootProfile;
}

/** OCX receipts retain the filesystem root but not the invoked registry profile identity. */
export function assertReceiptProfileRoot(value: unknown, expectedProfileRoot: string): void {
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).root !== expectedProfileRoot) fail("Install receipt root does not match the disposable ws profile root.");
}

function parseResolvedComponent(value: unknown, location: string): ResolvedComponent {
  if (!value || typeof value !== "object") fail(`${location} is malformed.`);
  const record = value as Record<string, unknown>;
  if (typeof record.registryName !== "string" || !record.registryName || typeof record.name !== "string" || !record.name || typeof record.revision !== "string" || !record.revision || typeof record.hash !== "string" || !/^[a-f0-9]{64}$/i.test(record.hash) || record.revision !== `sha256:${record.hash}`) fail(`${location} must declare an exact registry identity, revision, and SHA-256.`);
  return { identifier: `${record.registryName}/${record.name}`, revision: record.revision, sha256: record.hash.toLowerCase() };
}

/** Parses OCX 2.0.14's documented receipt map; no serialized-text searching is permitted. */
export function parseInstallReceipt(value: unknown): ParsedInstallReceipt {
  if (!value || typeof value !== "object") fail("Install receipt is malformed.");
  const receipt = value as Record<string, unknown>;
  if (receipt.version !== 1 || typeof receipt.root !== "string" || !receipt.root || !receipt.installed || typeof receipt.installed !== "object" || Array.isArray(receipt.installed)) fail("Install receipt has an undocumented schema.");
  const components = Object.entries(receipt.installed as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, component]) => parseResolvedComponent(component, `Install receipt installed.${key}`));
  if (components.length === 0 || new Set(components.map(({ identifier }) => identifier)).size !== components.length || requiredComponents.some((identifier) => !components.some((component) => component.identifier === identifier))) fail("Install receipt has an incomplete component identity set.");
  const workspace = components.filter(({ identifier }) => identifier === "kdco/workspace");
  if (workspace.length !== 1) fail("Install receipt must resolve exactly one kdco/workspace revision.");
  if (receipt.root !== "<redacted-path>") fail("Install receipt root must be sanitized before it is recorded.");
  return { receipt: receipt as InstallReceipt, resolvedDependencyComponents: components };
}

function parseEvidenceComponents(value: unknown, location: string): readonly ResolvedComponent[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${location} must be a non-empty component list.`);
  const components = value.map((component, index) => {
    if (!component || typeof component !== "object") fail(`${location}[${index}] is malformed.`);
    const record = component as Record<string, unknown>;
    if (typeof record.identifier !== "string" || !record.identifier || typeof record.revision !== "string" || !record.revision || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(record.sha256) || record.revision !== `sha256:${record.sha256}` || Object.keys(record).some((key) => !["identifier", "revision", "sha256"].includes(key))) fail(`${location}[${index}] is malformed.`);
    return { identifier: record.identifier, revision: record.revision, sha256: record.sha256.toLowerCase() };
  });
  if (new Set(components.map(({ identifier }) => identifier)).size !== components.length) fail(`${location} contains duplicate identifiers.`);
  return components;
}

function parseToolVersions(value: unknown, location: string): ToolVersions {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${location} is malformed.`);
  const versions = value as Record<string, unknown>;
  if (typeof versions.ocx !== "string" || !versions.ocx || typeof versions.opencode !== "string" || !versions.opencode || Object.keys(versions).some((key) => key !== "ocx" && key !== "opencode")) fail(`${location} is malformed.`);
  return { ocx: versions.ocx, opencode: versions.opencode };
}

function parseValidationRecord(value: unknown): ValidationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Install evidence validation record is malformed.");
  const validation = value as Record<string, unknown>;
  if ((validation.mode !== "pinned" && validation.mode !== "advisory") || Object.keys(validation).some((key) => key !== "mode" && key !== "expectedToolVersions" && key !== "discoveredToolVersions")) fail("Install evidence validation record is malformed.");
  const discoveredToolVersions = parseToolVersions(validation.discoveredToolVersions, "Install evidence discovered tool versions");
  if (validation.mode === "advisory") {
    if (validation.expectedToolVersions !== null) fail("Advisory validation must not claim expected tool versions.");
    return { mode: "advisory", expectedToolVersions: null, discoveredToolVersions };
  }
  const expectedToolVersions = parseToolVersions(validation.expectedToolVersions, "Install evidence expected tool versions");
  if (expectedToolVersions.ocx !== "2.0.14" || expectedToolVersions.opencode !== "1.17.15" || expectedToolVersions.ocx !== discoveredToolVersions.ocx || expectedToolVersions.opencode !== discoveredToolVersions.opencode) fail("Pinned validation tool versions do not match the required toolchain.");
  return { mode: "pinned", expectedToolVersions, discoveredToolVersions };
}

export function parseInstallEvidence(value: unknown): InstallEvidence {
  if (!value || typeof value !== "object") fail("Install evidence is malformed."); const evidence = value as Record<string, unknown>;
  if (evidence.schemaVersion !== 1 || typeof evidence.version !== "string" || !evidence.version || typeof evidence.commit !== "string" || !/^[0-9a-f]{40}$/i.test(evidence.commit)) fail("Install evidence has an invalid schema, version, or commit.");
  const rootProfile = parseRootProfileIdentity(evidence.rootProfile);
  const parsedReceipt = parseInstallReceipt(evidence.receipt); const resolvedDependencyComponents = parseEvidenceComponents(evidence.resolvedDependencyComponents, "Install evidence resolvedDependencyComponents");
  if (JSON.stringify(resolvedDependencyComponents) !== JSON.stringify(parsedReceipt.resolvedDependencyComponents)) fail("Install evidence dependency resolution differs from its parsed receipt.");
  if (!evidence.assertions || typeof evidence.assertions !== "object" || Array.isArray(evidence.assertions) || Object.keys(evidence.assertions as Record<string, unknown>).length === 0 || Object.values(evidence.assertions).some((passed) => passed !== true)) fail("Install evidence must contain non-empty named assertions that all pass.");
  const validation = parseValidationRecord(evidence.validation);
  if (evidence.attempts !== undefined) assertInstallAttempts(evidence.attempts); assertEvidenceIsSafe(evidence);
  return { ...evidence, rootProfile, resolvedDependencyComponents, assertions: evidence.assertions as Record<string, true>, receipt: parsedReceipt.receipt, validation };
}
function assertInstallAttempts(value: unknown): asserts value is InstallAttemptOutcome[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) fail("Install evidence has an invalid attempt history.");
  for (const [index, attempt] of value.entries()) { if (!attempt || typeof attempt !== "object") fail("Install evidence has an invalid attempt record."); const record = attempt as Record<string, unknown>; if (!Number.isSafeInteger(record.number) || record.number !== index + 1 || (record.outcome !== "succeeded" && record.outcome !== "failed") || (record.outcome === "succeeded" && record.failure !== undefined) || (record.outcome === "failed" && record.failure !== "timeout" && record.failure !== "network")) fail("Install evidence has an invalid attempt record."); }
  if (value.at(-1)?.outcome !== "succeeded" || value.slice(0, -1).some((attempt) => attempt.outcome !== "failed")) fail("Install evidence has an invalid attempt outcome order.");
}
