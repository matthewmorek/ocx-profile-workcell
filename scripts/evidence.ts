import { fail } from "./common";

export type InstallEvidence = Readonly<{
  schemaVersion: 1;
  version: string;
  commit: string;
  installedComponents: readonly string[];
  resolvedDependencies: unknown;
  assertions: Readonly<Record<string, boolean>>;
  receipt: unknown;
  toolVersions: Readonly<Record<string, string>>;
}>;

const sensitiveKey = /token|secret|password|api[_-]?key/i;
const machinePath = /(?:^|[\s"'])\/(?:Users|home)\//;

export function sanitizeEvidenceValue(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\/(?:Users|home)\/[^\s"']+/g, "<redacted-path>");
  if (Array.isArray(value)) return value.map(sanitizeEvidenceValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !sensitiveKey.test(key))
    .map(([key, entry]) => [key, sanitizeEvidenceValue(entry)]));
}

export function assertEvidenceIsSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (machinePath.test(serialized) || sensitiveKey.test(serialized)) fail("Evidence contains a machine path or secret-like value.");
}

export function parseInstallEvidence(value: unknown): InstallEvidence {
  if (!value || typeof value !== "object") fail("Install evidence is malformed.");
  const evidence = value as Record<string, unknown>;
  if (evidence.schemaVersion !== 1 || typeof evidence.version !== "string" || typeof evidence.commit !== "string" || !/^[0-9a-f]{40}$/i.test(evidence.commit)) fail("Install evidence has an invalid schema, version, or commit.");
  if (!Array.isArray(evidence.installedComponents) || JSON.stringify([...evidence.installedComponents].sort()) !== JSON.stringify(["workspace", "ws", "ws-overrides"])) fail("Install evidence has an incomplete component set.");
  if (!evidence.assertions || typeof evidence.assertions !== "object" || Object.values(evidence.assertions).some((passed) => passed !== true)) fail("Install evidence contains failed assertions.");
  if (!evidence.toolVersions || typeof evidence.toolVersions !== "object" || Object.values(evidence.toolVersions).some((version) => typeof version !== "string" || !version)) fail("Install evidence has invalid tool versions.");
  if (!evidence.receipt || typeof evidence.receipt !== "object") fail("Install evidence has no sanitized receipt.");
  assertEvidenceIsSafe(evidence);
  return evidence as InstallEvidence;
}
