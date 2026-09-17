import { createHash } from "node:crypto";

import { z } from "zod";

export const idSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const oidSchema = z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/);
const text = z.string().min(1).max(32_768);
export const repositorySchema = z
  .object({
    host: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  })
  .strict();
export type Repository = z.infer<typeof repositorySchema>;
export const evidenceFailureSchema = z
  .object({
    category: z.enum([
      "authentication",
      "permission-denied",
      "rate-limited",
      "not-found",
      "service-unavailable",
      "network-unavailable",
    ]),
    exitCode: z.number().int(),
    httpStatus: z.number().int().optional(),
  })
  .strict();
export type EvidenceFailure = z.infer<typeof evidenceFailureSchema>;
/** checkedAt records the latest retrieval attempt, including failed attempts. Unavailable
 * sources have no items: an empty successful result and a failed request are different facts. */
export const evidenceResultSchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      checkedAt: z.iso.datetime(),
      items: z.array(z.unknown()),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      availability: z.literal("unavailable"),
      checkedAt: z.iso.datetime(),
      failure: evidenceFailureSchema,
    })
    .strict(),
]);
export type EvidenceResult = z.infer<typeof evidenceResultSchema>;
export const scopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("pr"),
      repository: repositorySchema,
      number: z.number().int().positive().max(2_147_483_647),
    })
    .strict(),
  z.object({ kind: z.literal("staged") }).strict(),
  z.object({ kind: z.literal("recent") }).strict(),
  z.object({ kind: z.literal("revision"), expression: text }).strict(),
  z
    .object({ kind: z.literal("paths"), paths: z.array(text).min(1).max(100) })
    .strict(),
]);
export type Scope = z.infer<typeof scopeSchema>;
export const handoffSchema = z
  .object({
    requirements: z.string().max(16_384),
    constraints: z.array(z.string().min(1).max(2048)).max(16),
    evidence: z
      .array(
        z
          .object({
            reference: z.string().min(1).max(2048),
            summary: z.string().max(2048),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export type Handoff = z.infer<typeof handoffSchema>;
export const emptyHandoff = (): Handoff => ({
  requirements: "",
  constraints: [],
  evidence: [],
});
export const pinsSchema = z
  .object({ base: oidSchema, head: oidSchema, mergeBase: oidSchema })
  .strict();
export type Pins = z.infer<typeof pinsSchema>;
export const candidateSchema = z
  .object({
    id: idSchema,
    rootCause: text,
    revision: oidSchema,
    path: text,
    line: z.number().int().positive(),
    scenario: text,
    evidence: text,
    severity: z.enum(["Critical", "Major", "Minor", "Nit"]),
    confidence: z.number().min(0).max(1),
    contract: text,
    remedy: text,
  })
  .strict();
export type Candidate = z.infer<typeof candidateSchema>;
export const slotSchema = z
  .object({
    id: idSchema,
    lens: text,
    session: text,
    outcome: z.enum([
      "pending",
      "running",
      "succeeded",
      "failed",
      "interrupted",
    ]),
    coverage: z.array(text),
    limitations: z.array(text),
    candidates: z.array(candidateSchema),
  })
  .strict();
export type Slot = z.infer<typeof slotSchema>;
export const dispositionSchema = z
  .object({
    candidate: idSchema,
    disposition: z.enum(["accepted", "rejected", "duplicate", "deferred"]),
    reason: text,
    duplicateOf: idSchema.optional(),
  })
  .strict();
export const findingSchema = z
  .object({
    id: idSchema,
    rootCause: text,
    firstRound: z.number().int().positive(),
    lastRound: z.number().int().positive(),
    status: z.enum([
      "open",
      "resolved-with-evidence",
      "superseded",
      "rejected",
      "duplicate",
      "needs-recheck",
    ]),
    candidate: candidateSchema,
    reason: text,
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;
export const snapshotSchema = z
  .object({
    fingerprint: text,
    patch: z.string(),
    files: z.record(
      z.string(),
      z
        .object({
          kind: z.enum(["file", "symlink", "submodule"]),
          content: z.string(),
        })
        .strict(),
    ),
    mutable: z.boolean(),
    limitations: z.array(text),
    contextPaths: z.array(text).default([]),
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export const roundSchema = z
  .object({
    number: z.number().int().positive(),
    status: z.enum([
      "prepared",
      "running",
      "interrupted",
      "evidence",
      "completed",
    ]),
    pins: pinsSchema,
    snapshot: snapshotSchema.optional(),
    specification: text,
    requirementsFingerprint: z.string().optional(),
    codeReport: z.string().optional(),
    evidenceFingerprint: text,
    evidence: z.record(z.string(), z.unknown()),
    basis: z.enum(["full", "delta", "reused"]),
    baseline: z.number().int().positive().optional(),
    deltaBase: oidSchema.optional(),
    reuseReason: text,
    freshness: z.enum(["current", "stale", "unknown"]),
    instructions: z.string(),
    testEvidence: z.string(),
    risk: z.string(),
    affectedScope: z
      .object({
        reliable: z.boolean(),
        rationale: text,
        paths: z.array(text).min(1),
      })
      .strict()
      .optional(),
    slots: z.array(slotSchema).max(4),
    adjudications: z.array(dispositionSchema),
    recheckedFindings: z.array(idSchema),
    limitations: z.array(text),
    evidenceLimitations: z.array(text).default([]),
    report: z.string().optional(),
  })
  .strict();
export type Round = z.infer<typeof roundSchema>;
export const manifestSchema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    owner: idSchema,
    project: text,
    request: text,
    initiator: text,
    coordinator: text.optional(),
    managedSessions: z.array(text),
    scope: scopeSchema,
    handoff: handoffSchema.default(emptyHandoff),
    lifecycle: z.enum([
      "opening",
      "ready",
      "running",
      "interrupted",
      "closing",
      "cleanup_failed",
    ]),
    needsDrain: z.boolean().default(false),
    created: text,
    updated: text,
    lastCompleted: z.number().int().positive().optional(),
    rounds: z.array(roundSchema),
    findings: z.array(findingSchema),
    cleanupError: z.string().optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (m.rounds.some((r, i) => r.number !== i + 1))
      invalid("Round sequence is invalid");
    if (
      m.lastCompleted !== undefined &&
      !m.rounds.some(
        (r) =>
          r.number === m.lastCompleted &&
          r.status === "completed" &&
          r.freshness === "current" &&
          r.report,
      )
    )
      invalid("Completed baseline is invalid");
    if (
      new Set(m.managedSessions).size !== m.managedSessions.length ||
      m.managedSessions.includes(m.initiator)
    )
      invalid("Managed sessions overlap the initiating conversation");
    if (m.coordinator && !m.managedSessions.includes(m.coordinator))
      invalid("Coordinator ownership is missing");
    for (const round of m.rounds) {
      if (
        new Set(round.slots.map((s) => s.session)).size !==
          round.slots.length ||
        round.slots.some(
          (s) =>
            !m.managedSessions.includes(s.session) ||
            s.session === m.coordinator,
        )
      )
        invalid("Worker ownership is invalid");
      const candidates = round.slots.flatMap((s) => s.candidates);
      if (
        new Set(candidates.map((c) => c.id)).size !== candidates.length ||
        new Set(round.adjudications.map((d) => d.candidate)).size !==
          round.adjudications.length
      )
        invalid("Candidate ownership is invalid");
      if (
        round.status === "completed" &&
        (!round.slots.length ||
          round.slots.some(
            (s) => s.outcome !== "succeeded" || !s.coverage.length,
          ) ||
          candidates.some(
            (c) => !round.adjudications.some((d) => d.candidate === c.id),
          ) ||
          round.adjudications.some((d) => d.disposition === "deferred"))
      )
        invalid("Completed round lacks coverage or adjudication");
    }
  });
export type Manifest = z.infer<typeof manifestSchema>;

/** Supplied by the trusted tool adapter from actual runtime context, never tool arguments. */
export interface Actor {
  project: string;
  session: string;
  agent: string;
}
export type Access = "status" | "coordinate" | "inspect" | "submit" | "close";
export function authorize(
  m: Manifest,
  actor: Actor,
  access: Access,
  round?: number,
): Slot | undefined {
  if (actor.project !== m.project)
    throw new Error("Review belongs to another project");
  const coordinator =
    actor.session === m.coordinator && actor.agent === "review";
  const initiator = actor.session === m.initiator;
  if (
    ["closing", "cleanup_failed"].includes(m.lifecycle) &&
    !["status", "close"].includes(access)
  )
    throw new Error("Review is closing");
  if (coordinator && access !== "submit") return;
  if (initiator && (access === "status" || access === "close")) return;
  const r = m.rounds.find((r) => r.number === round);
  const slot = r?.slots.find((s) => s.session === actor.session);
  if (
    actor.agent === "reviewer" &&
    slot &&
    m.lifecycle === "running" &&
    r?.status === "running" &&
    slot.outcome === "running" &&
    (access === "inspect" || access === "submit")
  )
    return slot;
  throw new Error("Unauthorized review operation");
}
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function sameRepository(a: Repository, b: Repository): boolean {
  return (
    `${a.host}/${a.owner}/${a.name}`.toLowerCase() ===
    `${b.host}/${b.owner}/${b.name}`.toLowerCase()
  );
}
