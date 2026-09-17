import { lstat } from "node:fs/promises";

import {
  authorize,
  candidateSchema,
  dispositionSchema,
  fingerprint,
  evidenceResultSchema,
  roundSchema,
  slotSchema,
  type Actor,
  type Candidate,
  type Finding,
  type Manifest,
  type Round,
  type Scope,
  type Handoff,
  type Slot,
} from "./contracts";
import {
  GitHub,
  safePath,
  type EvidenceKind,
  type PullRequest,
} from "./github";
import type { Transport } from "./process";
import { ReviewStore, newId } from "./store";
import { ReviewWorkspace, localSnapshot, resolveLocalScope } from "./workspace";

export interface RoundContext {
  specification: string;
  instructions: string;
  testEvidence: string;
  risk: string;
  /** Coordinator's affected-dependency assessment. Absent/unreliable mapping forces a full round. */
  affectedScope?: Round["affectedScope"];
}
export interface CloseAdapter {
  /** Must abort and wait for every recorded session; return only after no work can write. Retry-safe. */
  drain(sessions: readonly string[]): Promise<void>;
  /** Deliver or durably retain the summary outside scratch before deleting it. Retry-safe. */
  deliver(report: string | undefined): Promise<void>;
  /** Retire managed sessions, not the initiating conversation. Retry-safe; missing sessions are success. */
  retire(sessions: readonly string[]): Promise<void>;
}
export type Inspection =
  | { kind: "diff" }
  | { kind: "tree" }
  | { kind: "file"; path: string }
  | { kind: "history"; path?: string }
  | { kind: "search"; text: string; limit?: number }
  | { kind: "evidence"; evidence: EvidenceKind };
function current(m: Manifest, number?: number): Round {
  const round =
    number === undefined
      ? m.rounds.at(-1)
      : m.rounds.find((r) => r.number === number);
  if (!round) throw new Error("Review round not found");
  return round;
}
const evidenceKinds: EvidenceKind[] = [
  "comments",
  "inline",
  "reviews",
  "checks",
  "statuses",
];
function auxiliaryLimitations(evidence: Record<string, unknown>): string[] {
  return evidenceKinds.flatMap((kind) => {
    const source = evidenceResultSchema.parse(evidence[kind]);
    if (source.availability === "unavailable") {
      const status =
        source.failure.httpStatus === undefined
          ? ""
          : `; HTTP ${source.failure.httpStatus}`;
      return [
        `GitHub ${kind} unavailable (${source.failure.category}${status}); current ${kind} evidence is unknown.`,
      ];
    }
    return source.truncated
      ? [`GitHub ${kind} retrieval is truncated; coverage is partial.`]
      : [];
  });
}
/** Timestamps are audit data, not new evidence. Losing access is qualified by enforced
 * limitations; newly available or changed facts still require an updated coordinator summary. */
function availableEvidenceChanged(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  if (fingerprint(previous.metadata) !== fingerprint(next.metadata))
    return true;
  return evidenceKinds.some((kind) => {
    const fresh = evidenceResultSchema.parse(next[kind]);
    if (fresh.availability === "unavailable") return false;
    const old = evidenceResultSchema.safeParse(previous[kind]);
    if (!old.success || old.data.availability !== "available") return true;
    return (
      fingerprint({ items: old.data.items, truncated: old.data.truncated }) !==
      fingerprint({ items: fresh.items, truncated: fresh.truncated })
    );
  });
}
function requirementsFingerprint(
  m: Manifest,
  context: RoundContext,
  pr?: Pick<PullRequest, "title" | "body">,
) {
  return fingerprint({
    handoff: {
      requirements: m.handoff.requirements,
      constraints: m.handoff.constraints,
    },
    specification: context.specification,
    instructions: context.instructions,
    risk: context.risk,
    pr: pr ? { title: pr.title, body: pr.body } : null,
  });
}

/** Infrastructure API: adapters must derive Actor from actual tool context, not model arguments.
 * All lifecycle/inspection mutations serialize on the same operation lock. No SDK sessions are
 * created here. V1 SDK 1.18.25 create has no permission field; the next layer must establish
 * effective restrictions before prompting and must not assume inherited permissions.
 */
export class ReviewCore {
  constructor(
    readonly store: ReviewStore,
    private readonly github = new GitHub(store.project),
    private readonly gitTransport?: Transport,
  ) {}
  private workspace(id: string) {
    return new ReviewWorkspace(this.store.directory(id), this.gitTransport);
  }
  async start(
    actor: Actor,
    request: string,
    scope: Scope,
    handoff?: Handoff,
  ): Promise<Manifest> {
    return this.store.create(
      actor,
      request,
      await resolveLocalScope(this.store.project, scope),
      handoff,
    );
  }
  async bind(id: string, actor: Actor, coordinator: string): Promise<Manifest> {
    return this.store.transaction(id, async (m) => {
      authorize(m, actor, "status");
      if (
        actor.session !== m.initiator ||
        (m.coordinator && m.coordinator !== coordinator) ||
        !coordinator ||
        coordinator === m.initiator
      )
        throw new Error("Invalid coordinator binding");
      m.coordinator = coordinator;
      if (!m.managedSessions.includes(coordinator))
        m.managedSessions.push(coordinator);
      await this.store.save(m);
      return m;
    });
  }
  async status(id: string, actor: Actor): Promise<Manifest> {
    const m = await this.store.load(id);
    authorize(m, actor, "status");
    return m;
  }
  async prepare(
    id: string,
    actor: Actor,
    context: RoundContext,
  ): Promise<{ round: Round; reused: boolean }> {
    context = roundSchema
      .pick({
        specification: true,
        instructions: true,
        testEvidence: true,
        risk: true,
        affectedScope: true,
      })
      .parse(context);
    return this.store.transaction(id, async (m) => {
      authorize(m, actor, "coordinate");
      if (m.lifecycle === "running" || m.needsDrain)
        throw new Error("Drain active or unknown reviewers before refreshing");
      if (!context.specification.trim())
        throw new Error("Record the specification basis first");
      for (const path of context.affectedScope?.paths ?? []) safePath(path);
      const workspace = this.workspace(id);
      m.lifecycle = "opening";
      await this.store.save(m);
      try {
        await workspace.initialize();
        const number = m.rounds.length + 1;
        let snapshot: Round["snapshot"],
          pins: Round["pins"],
          initial = false;
        const evidence: Record<string, unknown> = {};
        let prBasis: PullRequest | undefined;
        if (m.scope.kind === "pr") {
          await workspace.verifyLocalRepository(m.project, m.scope);
          const pr = await this.github.metadata(
            m.scope.repository,
            m.scope.number,
          );
          prBasis = pr;
          pins = await workspace.pinPR(m.project, m.scope, pr, number);
          evidence.metadata = pr;
          Object.assign(evidence, await this.mutableEvidence(m, pr));
        } else {
          const prior = m.rounds.find((r) => r.number === m.lastCompleted);
          const local = await localSnapshot(
            m.project,
            m.scope,
            prior?.snapshot?.contextPaths,
          );
          snapshot = local.snapshot;
          initial = local.initialCommit === true;
          pins = await workspace.pinLocal(
            m.project,
            local.base,
            local.head,
            number,
          );
          evidence.diffBase = local.diffBase;
        }
        const baseline = m.rounds.find((r) => r.number === m.lastCompleted);
        const requirements = requirementsFingerprint(m, context, prBasis);
        const sameContext = baseline?.requirementsFingerprint === requirements;
        const baselineAvailable =
          baseline && (await workspace.hasPins(baseline.pins));
        const sameInput =
          baseline &&
          sameContext &&
          fingerprint(baseline.pins) === fingerprint(pins) &&
          baseline.snapshot?.fingerprint === snapshot?.fingerprint;
        if (
          baseline &&
          baselineAvailable &&
          sameInput &&
          m.rounds.at(-1)?.number === baseline.number &&
          baseline.freshness === "current"
        ) {
          await workspace.assertClean(baseline.pins.head);
          const refreshed = { ...baseline.evidence, ...evidence };
          const round: Round = {
            ...structuredClone(baseline),
            ...context,
            number,
            status: "evidence",
            basis: "reused",
            baseline: baseline.number,
            snapshot,
            pins,
            evidence: refreshed,
            evidenceFingerprint: fingerprint(refreshed),
            evidenceLimitations:
              m.scope.kind === "pr" ? auxiliaryLimitations(refreshed) : [],
            freshness: "unknown",
            codeReport: baseline.codeReport ?? baseline.report,
            report: undefined,
            reuseReason:
              "Completed code coverage reused; mutable evidence requires a fresh summary.",
          };
          m.rounds.push(round);
          m.lifecycle = "ready";
          await this.store.save(m);
          return { round, reused: true };
        }
        let basis: "full" | "delta" = "full",
          deltaBase: string | undefined;
        let reuseReason = "Full pinned review; no reusable completed coverage.";
        if (
          baseline &&
          baselineAvailable &&
          sameContext &&
          !snapshot?.mutable &&
          !baseline.snapshot?.mutable &&
          baseline.pins.base === pins.base &&
          context.affectedScope?.reliable === true &&
          (await workspace.isAncestor(baseline.pins.head, pins.head))
        ) {
          basis = "delta";
          deltaBase = baseline.pins.head;
          reuseReason =
            "Reuse completed baseline coverage; inspect head delta, affected dependencies, and unresolved findings.";
        }
        if (initial) evidence.initialCommit = true;
        await workspace.checkoutHead(pins.head);
        const round: Round = {
          number,
          status: "prepared",
          pins,
          snapshot,
          ...context,
          requirementsFingerprint: requirements,
          evidence,
          evidenceFingerprint: fingerprint(evidence),
          evidenceLimitations:
            m.scope.kind === "pr" ? auxiliaryLimitations(evidence) : [],
          basis,
          baseline: baseline?.number,
          deltaBase,
          reuseReason,
          freshness: "unknown",
          slots: [],
          adjudications: [],
          recheckedFindings: [],
          limitations: snapshot?.limitations ?? [
            "No code/tests, hooks, filters, LFS downloads, or submodule updates executed.",
          ],
        };
        for (const finding of m.findings)
          if (["open", "needs-recheck"].includes(finding.status))
            finding.status = "needs-recheck";
        m.rounds.push(round);
        m.lifecycle = "ready";
        await this.store.save(m);
        return { round, reused: false };
      } catch (error) {
        m.lifecycle = "interrupted";
        await this.store.save(m);
        throw error;
      }
    });
  }
  private async mutableEvidence(
    m: Manifest,
    pr: PullRequest,
  ): Promise<Record<string, unknown>> {
    if (m.scope.kind !== "pr")
      throw new Error("PR evidence requires a PR scope");
    const evidence: Record<string, unknown> = { metadata: pr };
    for (const kind of evidenceKinds)
      evidence[kind] = await this.github.evidence(
        m.scope.repository,
        m.scope.number,
        pr.head.sha,
        kind,
      );
    return evidence;
  }
  /** Persist assignments before dispatch. The adapter launches only these exact reviewer sessions. */
  async dispatch(
    id: string,
    actor: Actor,
    assignments: { lens: string; session: string }[],
  ): Promise<Slot[]> {
    return this.store.transaction(id, async (m) => {
      authorize(m, actor, "coordinate");
      const round = current(m);
      if (
        m.lifecycle !== "ready" ||
        round.status !== "prepared" ||
        assignments.length < 1 ||
        assignments.length > 4
      )
        throw new Error("A prepared round requires 1–4 reviewer assignments");
      if (
        new Set(assignments.map((a) => a.session)).size !==
          assignments.length ||
        assignments.some(
          (a) =>
            m.managedSessions.includes(a.session) || a.session === m.initiator,
        )
      )
        throw new Error("Reviewer sessions must be independent and new");
      round.slots = assignments.map((a) =>
        slotSchema.parse({
          ...a,
          id: newId(),
          outcome: "running",
          coverage: [],
          limitations: [],
          candidates: [],
        }),
      );
      m.managedSessions.push(...assignments.map((a) => a.session));
      round.status = "running";
      m.lifecycle = "running";
      await this.store.save(m);
      return round.slots;
    });
  }
  /** Worker-safe view deliberately omits peers, candidates, adjudications, and retained findings. */
  async assignment(id: string, actor: Actor, number: number) {
    const m = await this.store.load(id),
      round = current(m, number);
    const slot = authorize(m, actor, "inspect", number);
    if (!slot) throw new Error("This operation requires a bound reviewer");
    return {
      round: number,
      pins: round.pins,
      scope: m.scope,
      lens: slot.lens,
      specification: round.specification,
      handoff: m.handoff,
      instructions: round.instructions,
      testEvidence: round.testEvidence,
      risk: round.risk,
      basis: round.basis,
      deltaBase: round.deltaBase,
      limitations: round.limitations,
    };
  }
  async submit(
    id: string,
    actor: Actor,
    number: number,
    result: {
      outcome: "succeeded" | "failed";
      coverage: string[];
      limitations: string[];
      candidates: Candidate[];
    },
  ): Promise<void> {
    await this.store.transaction(id, async (m) => {
      const round = current(m, number),
        slot = authorize(m, actor, "submit", number)!;
      const submission = slotSchema
        .pick({
          outcome: true,
          coverage: true,
          limitations: true,
          candidates: true,
        })
        .parse(result);
      if (!["succeeded", "failed"].includes(submission.outcome))
        throw new Error("Submit a terminal worker outcome");
      const parsed = slotSchema.parse({ ...slot, ...submission });
      if (parsed.outcome === "succeeded" && !parsed.coverage.length)
        throw new Error("Successful review requires coverage");
      const existing = new Set(
        round.slots.flatMap((s) => s.candidates.map((c) => c.id)),
      );
      for (const candidate of parsed.candidates) {
        candidateSchema.parse(candidate);
        safePath(candidate.path);
        if (
          candidate.revision !== round.pins.head ||
          existing.has(candidate.id)
        )
          throw new Error(
            "Candidate must be unique and bound to the pinned head",
          );
        existing.add(candidate.id);
      }
      Object.assign(slot, parsed);
      await this.store.save(m);
    });
  }
  async adjudicate(
    id: string,
    actor: Actor,
    dispositions: Round["adjudications"],
    findingUpdates: {
      id: string;
      status: Finding["status"];
      evidence: string;
    }[] = [],
  ): Promise<void> {
    await this.store.transaction(id, async (m) => {
      authorize(m, actor, "coordinate");
      const round = current(m);
      if (
        round.status !== "running" ||
        round.slots.some(
          (s) => s.outcome === "running" || s.outcome === "pending",
        )
      )
        throw new Error("Wait for all reviewer outcomes before adjudication");
      const candidates = round.slots.flatMap((s) => s.candidates);
      const parsed = dispositions.map((d) => dispositionSchema.parse(d));
      if (
        new Set(parsed.map((d) => d.candidate)).size !== parsed.length ||
        parsed.some((d) => !candidates.some((c) => c.id === d.candidate))
      )
        throw new Error("Invalid candidate adjudication");
      for (const d of parsed) {
        if (
          d.disposition === "duplicate" &&
          (!d.duplicateOf ||
            d.duplicateOf === d.candidate ||
            (!candidates.some((c) => c.id === d.duplicateOf) &&
              !m.findings.some((f) => f.id === d.duplicateOf)))
        )
          throw new Error(
            "Duplicate disposition requires a distinct known finding",
          );
        const candidate = candidates.find((c) => c.id === d.candidate)!;
        let finding =
          m.findings.find((f) => f.candidate.id === candidate.id) ??
          (d.disposition === "duplicate"
            ? undefined
            : m.findings.find(
                (f) =>
                  f.rootCause === candidate.rootCause &&
                  f.candidate.path === candidate.path &&
                  f.status !== "duplicate",
              ));
        if (!finding) {
          finding = {
            id: newId(),
            rootCause: candidate.rootCause,
            firstRound: round.number,
            lastRound: round.number,
            status: "open",
            candidate,
            reason: d.reason,
          };
          m.findings.push(finding);
        }
        finding.lastRound = round.number;
        finding.candidate = candidate;
        finding.reason = d.reason;
        finding.status = {
          accepted: "open",
          rejected: "rejected",
          duplicate: "duplicate",
          deferred: "needs-recheck",
        }[d.disposition] as Finding["status"];
        if (
          d.disposition !== "deferred" &&
          !round.recheckedFindings.includes(finding.id)
        )
          round.recheckedFindings.push(finding.id);
      }
      for (const update of findingUpdates) {
        const finding = m.findings.find((f) => f.id === update.id);
        if (!finding || !update.evidence.trim())
          throw new Error("Finding transitions require evidence");
        finding.status = update.status;
        finding.reason = update.evidence;
        finding.lastRound = round.number;
        if (!round.recheckedFindings.includes(finding.id))
          round.recheckedFindings.push(finding.id);
      }
      round.adjudications = parsed;
      await this.store.save(m);
    });
  }
  async complete(id: string, actor: Actor, report: string): Promise<Round> {
    return this.store.transaction(id, async (m) => {
      authorize(m, actor, "coordinate");
      const round = current(m);
      if (
        !["running", "evidence"].includes(round.status) ||
        round.slots.length < 1 ||
        round.slots.some((s) => s.outcome !== "succeeded") ||
        !report.trim()
      )
        throw new Error("Incomplete reviewer coverage");
      const candidates = round.slots.flatMap((s) => s.candidates);
      if (
        candidates.some(
          (c) => !round.adjudications.some((d) => d.candidate === c.id),
        ) ||
        round.adjudications.some((d) => d.disposition === "deferred") ||
        m.findings.some((f) => f.status === "needs-recheck")
      )
        throw new Error("Complete adjudication and finding rechecks first");
      const workspace = this.workspace(id);
      await workspace.assertClean(round.pins.head);
      round.freshness = "unknown";
      try {
        if (m.scope.kind === "pr") {
          const pr = await this.github.metadata(
            m.scope.repository,
            m.scope.number,
          );
          round.freshness =
            pr.base.sha === round.pins.base &&
            pr.head.sha === round.pins.head &&
            requirementsFingerprint(m, round, pr) ===
              round.requirementsFingerprint
              ? "current"
              : "stale";
          const refreshed = await this.mutableEvidence(m, pr);
          const previous = Object.fromEntries(
            ["metadata", ...evidenceKinds].map((key) => [
              key,
              round.evidence[key],
            ]),
          );
          round.evidence = { ...round.evidence, ...refreshed };
          round.evidenceLimitations = auxiliaryLimitations(refreshed);
          round.evidenceFingerprint = fingerprint(round.evidence);
          if (
            round.freshness === "current" &&
            availableEvidenceChanged(previous, refreshed)
          ) {
            await this.store.save(m);
            throw new Error(
              "Mutable evidence changed; inspect the refreshed evidence and complete an updated summary. Code coverage remains reusable.",
            );
          }
        } else if (
          requirementsFingerprint(m, round) !== round.requirementsFingerprint
        ) {
          round.freshness = "stale";
        } else if (round.snapshot?.mutable) {
          const fresh = await localSnapshot(
            m.project,
            m.scope,
            round.snapshot.contextPaths,
          );
          round.freshness =
            fresh.snapshot?.fingerprint === round.snapshot.fingerprint
              ? "current"
              : "stale";
        } else round.freshness = "current"; // Committed expressions are pinned, not moving branch promises.
      } catch (error) {
        await this.store.save(m);
        throw error;
      }
      round.evidenceFingerprint = fingerprint(round.evidence);
      if (round.freshness !== "current") {
        await this.store.save(m);
        throw new Error(
          "Review target changed; prepare a new round after draining workers",
        );
      }
      round.report = round.evidenceLimitations.length
        ? `Auxiliary evidence limitations (current; any contrary auxiliary claims below are unverified):\n${round.evidenceLimitations.map((limitation) => `- ${limitation}`).join("\n")}\n\n${report}`
        : report;
      if (round.basis !== "reused") round.codeReport = round.report;
      round.status = "completed";
      m.lastCompleted = round.number;
      m.lifecycle = "ready";
      await this.store.save(m);
      return round;
    });
  }
  /** End an incomplete round only after host-confirmed drain; preserve the last adjudicated baseline. */
  async interrupt(
    id: string,
    actor: Actor,
    drain: CloseAdapter["drain"],
  ): Promise<void> {
    await this.store.transaction(id, async (m) => {
      authorize(m, actor, "coordinate");
      const round = current(m);
      if (round.status === "completed")
        throw new Error("Completed rounds cannot be interrupted");
      await drain(round.slots.map((s) => s.session));
      for (const slot of round.slots)
        if (["pending", "running"].includes(slot.outcome))
          slot.outcome = "interrupted";
      round.status = "interrupted";
      m.lifecycle = "interrupted";
      m.needsDrain = false;
      await this.store.save(m);
    });
  }
  /** Retry only missing/failed slots after restart; successes survive only if pins and captured input still match. */
  async retry(
    id: string,
    actor: Actor,
    replacements: { slot: string; session: string }[],
  ): Promise<Slot[]> {
    return this.store.transaction(id, async (m) => {
      authorize(m, actor, "coordinate");
      const round = current(m);
      if (
        m.lifecycle !== "interrupted" ||
        round.status !== "interrupted" ||
        m.needsDrain
      )
        throw new Error("Reconcile and drain interrupted work before retrying");
      const missing = round.slots.filter((s) => s.outcome !== "succeeded");
      if (
        !round.slots.length ||
        replacements.length !== missing.length ||
        new Set(replacements.map((r) => r.slot)).size !== replacements.length ||
        new Set(replacements.map((r) => r.session)).size !==
          replacements.length ||
        replacements.some(
          (r) =>
            !missing.some((s) => s.id === r.slot) ||
            !r.session ||
            m.managedSessions.includes(r.session) ||
            r.session === m.initiator,
        )
      )
        throw new Error(
          "Replace every incomplete slot with a new independent session",
        );
      const workspace = this.workspace(id);
      await workspace.assertClean(round.pins.head);
      if (!(await workspace.hasPins(round.pins)))
        throw new Error("Baseline objects unavailable; prepare a full round");
      if (m.scope.kind === "pr") {
        const pr = await this.github.metadata(
          m.scope.repository,
          m.scope.number,
        );
        if (
          pr.head.sha !== round.pins.head ||
          pr.base.sha !== round.pins.base ||
          requirementsFingerprint(m, round, pr) !==
            round.requirementsFingerprint
        )
          throw new Error("PR moved; prepare a new round");
      } else if (
        requirementsFingerprint(m, round) !== round.requirementsFingerprint
      ) {
        throw new Error("Caller requirements changed; prepare a new round");
      } else if (round.snapshot?.mutable) {
        const local = await localSnapshot(
          m.project,
          m.scope,
          round.snapshot.contextPaths,
        );
        if (local.snapshot?.fingerprint !== round.snapshot.fingerprint)
          throw new Error("Local input changed; prepare a new round");
      }
      for (const replacement of replacements) {
        const slot = missing.find((s) => s.id === replacement.slot)!;
        const discarded = new Set(slot.candidates.map((c) => c.id));
        round.adjudications = round.adjudications.filter(
          (d) => !discarded.has(d.candidate),
        );
        for (const finding of m.findings) {
          if (
            discarded.has(finding.candidate.id) &&
            ["open", "needs-recheck"].includes(finding.status)
          )
            finding.status = "needs-recheck";
        }
        slot.session = replacement.session;
        slot.outcome = "running";
        slot.candidates = [];
        slot.coverage = [];
        slot.limitations = [];
        m.managedSessions.push(replacement.session);
      }
      round.status = "running";
      m.lifecycle = "running";
      await this.store.save(m);
      return missing;
    });
  }
  async inspect(
    id: string,
    actor: Actor,
    number: number,
    request: Inspection,
  ): Promise<unknown> {
    return this.store.transaction(id, async (m) => {
      authorize(m, actor, "inspect", number);
      const round = current(m, number);
      const workspace = this.workspace(id);
      if (request.kind === "evidence") {
        if (m.scope.kind !== "pr")
          throw new Error("GitHub evidence requires a PR scope");
        if (round.status === "completed")
          throw new Error(
            "Completed evidence is frozen; prepare an evidence-only round to refresh it",
          );
        const evidence = await this.github.evidence(
          m.scope.repository,
          m.scope.number,
          round.pins.head,
          request.evidence,
        );
        round.evidence[request.evidence] = evidence;
        round.evidenceLimitations = auxiliaryLimitations(round.evidence);
        round.evidenceFingerprint = fingerprint(round.evidence);
        await this.store.save(m);
        return evidence;
      }
      if (request.kind === "diff")
        return (
          round.snapshot?.patch ??
          workspace.diff(
            round.pins,
            round.deltaBase ??
              (typeof round.evidence.diffBase === "string"
                ? round.evidence.diffBase
                : undefined),
            round.evidence.initialCommit === true,
          )
        );
      if (request.kind === "history")
        return workspace.history(round.pins.head, request.path);
      const files = round.snapshot?.files;
      if (request.kind === "tree")
        return files
          ? Object.entries(files).map(([path, file]) => ({
              path,
              kind: file.kind,
            }))
          : workspace.tree(round.pins.head);
      if (request.kind === "file") {
        safePath(request.path);
        if (!files) return workspace.file(round.pins.head, request.path);
        if (!Object.hasOwn(files, request.path)) {
          if (
            !["paths", "staged"].includes(m.scope.kind) ||
            round.status === "completed"
          )
            throw new Error("File is outside the captured scope");
          const before = await localSnapshot(
            m.project,
            m.scope,
            round.snapshot!.contextPaths,
          );
          if (before.snapshot?.fingerprint !== round.snapshot!.fingerprint)
            throw new Error("Local input changed; prepare a new round");
          const captured = await localSnapshot(m.project, m.scope, [
            ...round.snapshot!.contextPaths,
            request.path,
          ]);
          if (
            !captured.snapshot ||
            !Object.hasOwn(captured.snapshot.files, request.path)
          )
            throw new Error("File is not in the captured scope or index");
          round.snapshot = captured.snapshot;
          await this.store.save(m);
          return round.snapshot!.files[request.path];
        }
        return files[request.path];
      }
      if (
        request.kind !== "search" ||
        !request.text ||
        request.text.length > 1000
      )
        throw new Error("Invalid inspection request");
      const limit = request.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new Error("Invalid search limit");
      const tree = files
        ? Object.entries(files).map(([path, file]) => ({
            path,
            kind: file.kind,
          }))
        : await workspace.tree(round.pins.head);
      const matches: { path: string; line: number; text: string }[] = [];
      for (const entry of tree) {
        if (entry.kind !== "file") continue;
        const file =
          files?.[entry.path] ??
          (await workspace.file(round.pins.head, entry.path));
        const content = Buffer.from(file.content, "base64").toString("utf8");
        if (content.includes("\0")) continue;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++)
          if (lines[i].includes(request.text)) {
            if (matches.length === limit) return { matches, truncated: true };
            matches.push({
              path: entry.path,
              line: i + 1,
              text: lines[i].slice(0, 2000),
            });
          }
      }
      return { matches, truncated: false };
    });
  }
  async close(
    id: string,
    actor: Actor,
    adapter: CloseAdapter,
    discard = false,
  ): Promise<void> {
    if (await this.store.finishRemoval(id, actor)) return;
    await this.store.transaction(id, async (m) => {
      authorize(m, actor, "close");
      m.lifecycle = "closing";
      await this.store.save(m);
      try {
        await adapter.drain(m.managedSessions);
        await adapter.deliver(
          m.rounds.find((r) => r.number === m.lastCompleted)?.report,
        );
        await adapter.retire(m.managedSessions);
        const workspace = this.workspace(id);
        let exists = true;
        try {
          await lstat(workspace.bare);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          exists = false;
        }
        // An explicitly discarded, never-published first round may contain a legacy partial
        // initialization without a config marker. Remove only the manifest-owned scratch root;
        // do not run Git against that unverified repository. Established rounds still validate.
        if (exists && !(discard && m.rounds.length === 0))
          await workspace.dispose(discard, m.rounds.at(-1)?.pins.head);
        await this.store.remove(m);
      } catch (error) {
        m.lifecycle = "cleanup_failed";
        m.cleanupError =
          "Cleanup incomplete; retry close. Owned resources retained.";
        await this.store.save(m);
        throw error;
      }
    });
  }
}
