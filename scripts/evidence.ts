import { fail } from "./common";

export type ResolvedComponent = Readonly<{ identifier: string; revision: string; sha256: string }>;
export type InstallReceipt = Readonly<{ version: 1; root: string; installed: Readonly<Record<string, unknown>> }>;
export type ParsedInstallReceipt = Readonly<{ receipt: InstallReceipt; components: readonly ResolvedComponent[]; resolvedDependencies: readonly ResolvedComponent[] }>;
export type InstallEvidence = Readonly<{ schemaVersion: 1; version: string; commit: string; installedComponents: readonly ResolvedComponent[]; resolvedDependencies: readonly ResolvedComponent[]; assertions: Readonly<Record<string, true>>; receipt: InstallReceipt; toolVersions: Readonly<Record<string, string>>; attempts?: readonly InstallAttemptOutcome[] }>;
export type InstallAttemptOutcome = Readonly<{ number: number; outcome: "succeeded" | "failed"; failure?: "timeout" | "network" }>;

const sensitiveKey = /token|secret|password|api[_-]?key/i;
const machinePath = /(?:^|[\s"'=])(?:file:\/\/)?\/(?:Users|home|private|var|tmp|opt|Volumes)\//;
const machinePathValue = /(^|[\s"'=])(?:file:\/\/)?\/(?:Users|home|private|var|tmp|opt|Volumes)\/[^\s"']+/g;
const requiredComponents = ["kdco/workspace", "matthewmorek/ws-overrides"];

export function sanitizeEvidenceValue(value: unknown): unknown {
  if (typeof value === "string") return value.replace(machinePathValue, "$1<redacted-path>");
  if (Array.isArray(value)) return value.map(sanitizeEvidenceValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !sensitiveKey.test(key)).map(([key, entry]) => [key, sanitizeEvidenceValue(entry)]));
}
export function assertEvidenceIsSafe(value: unknown): void { const serialized = JSON.stringify(value); if (machinePath.test(serialized) || sensitiveKey.test(serialized)) fail("Evidence contains a machine path or secret-like value."); }

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
  return { receipt: receipt as InstallReceipt, components, resolvedDependencies: workspace };
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

export function parseInstallEvidence(value: unknown): InstallEvidence {
  if (!value || typeof value !== "object") fail("Install evidence is malformed."); const evidence = value as Record<string, unknown>;
  if (evidence.schemaVersion !== 1 || typeof evidence.version !== "string" || !evidence.version || typeof evidence.commit !== "string" || !/^[0-9a-f]{40}$/i.test(evidence.commit)) fail("Install evidence has an invalid schema, version, or commit.");
  const parsedReceipt = parseInstallReceipt(evidence.receipt); const installedComponents = parseEvidenceComponents(evidence.installedComponents, "Install evidence installedComponents"); const resolvedDependencies = parseEvidenceComponents(evidence.resolvedDependencies, "Install evidence resolvedDependencies");
  if (JSON.stringify(installedComponents) !== JSON.stringify(parsedReceipt.components) || JSON.stringify(resolvedDependencies) !== JSON.stringify(parsedReceipt.resolvedDependencies)) fail("Install evidence component resolution differs from its parsed receipt.");
  if (!evidence.assertions || typeof evidence.assertions !== "object" || Array.isArray(evidence.assertions) || Object.keys(evidence.assertions as Record<string, unknown>).length === 0 || Object.values(evidence.assertions).some((passed) => passed !== true)) fail("Install evidence must contain non-empty named assertions that all pass.");
  if (!evidence.toolVersions || typeof evidence.toolVersions !== "object" || Array.isArray(evidence.toolVersions) || Object.values(evidence.toolVersions).some((toolVersion) => typeof toolVersion !== "string" || !toolVersion)) fail("Install evidence has invalid tool versions.");
  if (evidence.attempts !== undefined) assertInstallAttempts(evidence.attempts); assertEvidenceIsSafe(evidence);
  return { ...evidence, installedComponents, resolvedDependencies, assertions: evidence.assertions as Record<string, true>, receipt: parsedReceipt.receipt, toolVersions: evidence.toolVersions as Record<string, string> };
}
function assertInstallAttempts(value: unknown): asserts value is InstallAttemptOutcome[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) fail("Install evidence has an invalid attempt history.");
  for (const [index, attempt] of value.entries()) { if (!attempt || typeof attempt !== "object") fail("Install evidence has an invalid attempt record."); const record = attempt as Record<string, unknown>; if (!Number.isSafeInteger(record.number) || record.number !== index + 1 || (record.outcome !== "succeeded" && record.outcome !== "failed") || (record.outcome === "succeeded" && record.failure !== undefined) || (record.outcome === "failed" && record.failure !== "timeout" && record.failure !== "network")) fail("Install evidence has an invalid attempt record."); }
  if (value.at(-1)?.outcome !== "succeeded" || value.slice(0, -1).some((attempt) => attempt.outcome !== "failed")) fail("Install evidence has an invalid attempt outcome order.");
}
