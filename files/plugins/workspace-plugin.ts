import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { type Plugin, tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { getProjectId } from "./kdco-primitives/get-project-id"

// ==========================================
// PLAN SCHEMA & VALIDATION
// ==========================================

const PhaseStatus = z.enum(["PENDING", "IN PROGRESS", "COMPLETE", "BLOCKED"])

const TaskSchema = z.object({
	id: z.string().regex(/^\d+\.\d+$/, "Task ID must be hierarchical (e.g., '2.1')"),
	checked: z.boolean(),
	content: z.string().min(1, "Task content cannot be empty"),
	isCurrent: z.boolean().optional(),
	citation: z
		.string()
		.regex(/^ref:[a-z]+-[a-z]+-[a-z]+$/, "Citation must be ref:word-word-word format")
		.optional(),
})

const PhaseSchema = z.object({
	number: z.number().int().positive(),
	name: z.string().min(1, "Phase name cannot be empty"),
	status: PhaseStatus,
	tasks: z.array(TaskSchema).min(1, "Phase must have at least one task"),
})

const FrontmatterSchema = z.object({
	status: z.enum(["not-started", "in-progress", "complete", "blocked"]),
	phase: z.number().int().positive(),
	updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
})

const PlanSchema = z.object({
	frontmatter: FrontmatterSchema,
	goal: z.string().min(10, "Goal must be at least 10 characters"),
	context: z
		.array(
			z.object({
				decision: z.string(),
				rationale: z.string(),
				source: z.string(),
			}),
		)
		.optional(),
	phases: z.array(PhaseSchema).min(1, "Plan must have at least one phase"),
})

/**
 * Result type for plan parsing - either valid data or descriptive error.
 * Follows Law 2: Parse Don't Validate - boundary parsing returns trusted types.
 */
type ParseResult =
	| { ok: true; data: z.infer<typeof PlanSchema>; warnings: string[] }
	| { ok: false; error: string; hint: string }


/**
 * Raw extracted parts from markdown (no validation).
 * Used as intermediate type before Zod validation.
 */
interface ExtractedParts {
	frontmatter: Record<string, string | number> | null
	goal: string | null
	phases: Array<{
		number: number
		name: string
		status: string
		tasks: Array<{
			id: string
			checked: boolean
			content: string
			isCurrent: boolean
			citation?: string
		}>
	}>
}

/**
 * Extract all parts from markdown without validation (Law 2: Parse Don't Validate).
 * Returns raw extracted data - validation happens in parsePlanMarkdown.
 * This is a pure extraction function (Law 3: Purity).
 */
function extractMarkdownParts(content: string): ExtractedParts {
	// Extract frontmatter (no validation - just extraction)
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
	let frontmatter: Record<string, string | number> | null = null

	if (fmMatch) {
		frontmatter = {}
		const fmLines = fmMatch[1].split("\n")
		for (const line of fmLines) {
			const [key, ...valueParts] = line.split(":")
			if (key && valueParts.length > 0) {
				const value = valueParts.join(":").trim()
				frontmatter[key.trim()] = key.trim() === "phase" ? parseInt(value, 10) : value
			}
		}
	}

	// Extract goal (no validation - just extraction)
	const goalMatch = content.match(/## Goal\n([^\n#]+)/)
	const goal = goalMatch?.[1]?.trim() || null

	// Extract phases (no validation - just extraction)
	const phases: ExtractedParts["phases"] = []
	const phaseRegex =
		/## Phase (\d+): ([^[]+)\[([^\]]+)\]\n([\s\S]*?)(?=## Phase \d+:|## Notes|## Blockers|$)/g

	let phaseMatch = phaseRegex.exec(content)
	while (phaseMatch !== null) {
		const phaseNum = parseInt(phaseMatch[1], 10)
		const phaseName = phaseMatch[2].trim()
		const phaseStatus = phaseMatch[3].trim()
		const phaseContent = phaseMatch[4]

		const tasks: ExtractedParts["phases"][0]["tasks"] = []
		const taskRegex =
			/- \[([ x])\] (\*\*)?(\d+\.\d+) ([^←\n]+)(← CURRENT)?.*?(`ref:[a-z]+-[a-z]+-[a-z]+`)?/g

		let taskMatch = taskRegex.exec(phaseContent)
		while (taskMatch !== null) {
			tasks.push({
				id: taskMatch[3],
				checked: taskMatch[1] === "x",
				content: taskMatch[4].trim().replace(/\*\*/g, ""),
				isCurrent: !!taskMatch[5],
				citation: taskMatch[6]?.replace(/`/g, ""),
			})
			taskMatch = taskRegex.exec(phaseContent)
		}

		// Include phase even if no tasks (let Zod validate)
		phases.push({
			number: phaseNum,
			name: phaseName,
			status: phaseStatus,
			tasks,
		})
		phaseMatch = phaseRegex.exec(content)
	}

	return { frontmatter, goal, phases }
}

/**
 * Format Zod validation errors into human-readable messages (Law 4: Fail Loud).
 * Shows ALL errors at once with clear paths.
 */
function formatZodErrors(error: z.ZodError): string {
	const errorMessages: string[] = []

	for (const issue of error.issues) {
		const path = issue.path.length > 0 ? `[${issue.path.join(".")}]` : "[root]"

		// Provide helpful context based on error type
		let message = issue.message
		if (issue.code === "invalid_value") {
			const values = (issue as { values?: unknown[] }).values
			const input = (issue as { input?: unknown }).input
			message = `Invalid value "${input}". Expected: ${values?.join(" | ") ?? "valid value"}`
		} else if (issue.code === "invalid_type" && (issue as { input?: unknown }).input === null) {
			message = "Required field missing"
		}

		errorMessages.push(`${path}: ${message}`)
	}

	return errorMessages.join("\n")
}

/**
 * Parse and validate markdown plan in a single boundary operation.
 * Returns ParseResult: either trusted data or descriptive error with hint.
 *
 * Follows all 5 Laws:
 * - Law 1 (Early Exit): Guard at top for empty content
 * - Law 2 (Parse Don't Validate): Extract all → validate once at end
 * - Law 3 (Purity): No side effects, same input = same output
 * - Law 4 (Fail Loud): Shows ALL validation errors with clear paths
 * - Law 5 (Intentional Naming): Self-documenting function names
 */
function parsePlanMarkdown(content: string): ParseResult {
	const skillHint = "Load skill('plan-protocol') for the full format spec."

	// Guard: Content must be string (Law 1: Early Exit, Law 2: Parse at boundary)
	if (typeof content !== "string") {
		return {
			ok: false,
			error: `Expected markdown string, received ${typeof content}`,
			hint: skillHint,
		}
	}

	// Guard: Empty content (Law 1: Early Exit)
	if (!content.trim()) {
		return {
			ok: false,
			error: "Empty content provided",
			hint: skillHint,
		}
	}

	// Extract all parts without validation (Law 2: Parse Don't Validate)
	const parts = extractMarkdownParts(content)

	// Build candidate object for validation
	const candidate = {
		frontmatter: parts.frontmatter,
		goal: parts.goal,
		phases: parts.phases,
	}

	// Single validation point: Zod schema (Law 2: Parse Don't Validate)
	const result = PlanSchema.safeParse(candidate)
	if (!result.success) {
		return {
			ok: false,
			error: formatZodErrors(result.error),
			hint: skillHint,
		}
	}

	// Business rules validation (still part of single boundary)
	const warnings: string[] = []
	let currentCount = 0
	let inProgressCount = 0

	for (const phase of result.data.phases) {
		if (phase.status === "IN PROGRESS") inProgressCount++
		for (const task of phase.tasks) {
			if (task.isCurrent) currentCount++
		}
	}

	if (currentCount > 1) {
		return {
			ok: false,
			error: `Multiple tasks marked ← CURRENT (found ${currentCount}). Only one task may be current.`,
			hint: skillHint,
		}
	}

	if (inProgressCount > 1) {
		warnings.push("Multiple phases marked IN PROGRESS. Consider focusing on one phase at a time.")
	}

	return { ok: true, data: result.data, warnings }
}

/**
 * Format parse error with actionable guidance (Law 4: Fail Loud).
 * Includes error message, example, and skill hint.
 */
function formatParseError(error: string, hint: string): string {
	return `❌ Plan validation failed:

${error}

💡 ${hint}`
}

/**
 * Type guard for Node.js filesystem errors (ENOENT, EACCES, etc.)
 * Follows "Parse, Don't Validate" - handle uncertainty at boundaries.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error
}

/**
 * Expected input for experimental.chat.system.transform hook.
 * Note: The official SDK types this as {}, but runtime provides these properties.
 * See: https://github.com/sst/opencode/issues/6142
 */
interface SystemTransformInput {
	agent?: string
	sessionID?: string
}

/**
 * KDCO Workspace Plugin
 *
 * Provides plan management and targeted rule injection.
 * Research functionality has been moved to the delegation system (background-agents).
 * Follows "Elegant Defense" philosophy: Flat, Safe, and Fast.
 */

// ==========================================
// TASK TRACKING FOR VERIFICATION WORKFLOW
// ==========================================

type TrackedTaskAgent = "coder" | "tester"
type TesterResult = "passed" | "failed" | "infrastructure-error" | "blocked"

interface ActiveTaskCall {
	agent: TrackedTaskAgent
	sessionID: string
	startTime: number
}

/** Tracks in-flight coder and tester task calls within their parent session */
const activeTaskCalls = new Map<string, ActiveTaskCall>()

/** Stale call timeout - matches MAX_RUN_TIME_MS in background-agents.ts */
const STALE_CALL_TIMEOUT_MS = 15 * 60 * 1000

/** Periodic cleanup of orphaned callIDs (runs every 60s) */
const cleanupInterval = setInterval(() => {
	const now = Date.now()
	for (const [callID, data] of activeTaskCalls) {
		if (now - data.startTime > STALE_CALL_TIMEOUT_MS) {
			activeTaskCalls.delete(callID)
		}
	}
}, 60_000)
// Prevent interval from keeping process alive
cleanupInterval.unref?.()

function hasActiveTaskForSession(agent: TrackedTaskAgent, sessionID: string): boolean {
	for (const task of activeTaskCalls.values()) {
		if (task.agent === agent && task.sessionID === sessionID) return true
	}
	return false
}

function parseTesterResult(taskOutput: string): TesterResult | null {
	const results: string[] = []
	for (const rawLine of taskOutput.split(/\r?\n/)) {
		let line = rawLine.trim()
		// Accept only standalone status lines, with balanced inline Markdown wrappers.
		line = line.replace(/^(\*\*|__)(RESULT:)\1[ \t]*/i, "$2 ")
		line = line.replace(/^(\*\*|__|`)(RESULT:.*?)\1$/i, "$2")
		line = line.replace(/^(RESULT:[ \t]*)(\*\*|__|`)([^`*_]+)\2$/i, "$1$3")
		const match = line.match(/^RESULT:[ \t]*(.*)$/i)
		if (match) results.push(match[1].trim().toLowerCase())
	}
	if (results.length === 0 || new Set(results).size !== 1) return null
	const result = results[0]

	switch (result) {
		case "passed":
		case "failed":
		case "infrastructure-error":
		case "blocked":
			return result
		default:
			return null
	}
}

// ==========================================
// RULES FOR INJECTION
// ==========================================

const SHARED_PLAN_RULES = `<shared-plan>
The saved plan is shared by the root session and its child sessions; unrelated root sessions have separate plans.
Treat the accepted plan as a design artifact, not a live progress ledger. Save substantive design revisions, not full-plan rewrites for routine progress updates.
Saving a plan does not automatically require review, delegation, or a reread. Review is an explicit orchestration decision.
Use the plan already in context. Call \`plan_read\` only when the plan is missing or known to have changed; do not repeat reads for each task.
Give child agents bounded assignments with task IDs or section references to the shared saved plan, scope, constraints, and expected evidence; do not copy the full plan into prompts. Children can use \`plan_read\` when they need missing plan context.
</shared-plan>`

const PLAN_RULES = `<system-reminder>
${SHARED_PLAN_RULES}
<workspace-routing policy_level="critical">

## Agent Routing (STRICT BOUNDARIES)

| Agent | Scope | Use For |
|-------|-------|---------|
| \`explore\` | **INTERNAL ONLY** - codebase files | Find files, understand code structure, trace logic |
| \`researcher\` | **EXTERNAL ONLY** - outside codebase | Documentation, websites, npm packages, APIs, tutorials |
| \`scribe\` | Human-facing content | Documentation drafts, commit messages, PR descriptions |

## Critical Constraints

**You are a READ-ONLY orchestrator. You coordinate research, you do NOT search yourself.**

- \`explore\` CANNOT access external resources (docs, web, APIs)
- \`researcher\` CANNOT search codebase files
- Reuse available evidence; research only material unresolved external or version-sensitive claims
- For missing external docs about a library used in the codebase → \`researcher\`
- For how that library is used in THIS codebase → \`explore\`

<example>
User: "What does the OpenAI API say about function calling?"
Correct: delegate to researcher (EXTERNAL - API documentation)
Wrong: Try to answer from memory or use MCP tools directly
</example>

<example>
User: "Where is the auth middleware in this project?"
Correct: delegate to explore (INTERNAL - codebase search)
Wrong: Use grep/glob directly
</example>

<example>
User: "How should I implement OAuth2 in this project?"
Correct:
  1. Reuse established constraints and evidence already in context
  2. delegate to researcher for material unresolved OAuth2 or version-sensitive claims (EXTERNAL)
  3. delegate to explore for missing existing auth patterns (INTERNAL)
Wrong: Search codebase yourself or answer from memory
</example>

</workspace-routing>

<philosophy>
Load philosophy skills when making the corresponding design decisions, not merely forwarding assignments:
- Planning work → \`skill\` load \`plan-protocol\` (REQUIRED before using plan_save)
- Backend/logic work → \`skill\` load \`code-philosophy\`
- UI/frontend work → \`skill\` load \`frontend-philosophy\`
</philosophy>

<plan-format>
Use \`plan_save\` to save your implementation plan as markdown.

### Format
\`\`\`markdown
---
status: in-progress
phase: 2
updated: YYYY-MM-DD
---

# Implementation Plan

## Goal
[One sentence describing the outcome]

## Context & Decisions
| Decision | Rationale | Source |
|----------|-----------|--------|
| [choice] | [why] | \`ref:delegation-id\` |

## Phase 1: [Name] [COMPLETE]
- [x] 1.1 Task description
- [x] 1.2 Another task → \`ref:delegation-id\`

## Phase 2: [Name] [IN PROGRESS]
- [x] 2.1 Completed task
- [ ] **2.2 Current task** ← CURRENT
- [ ] 2.3 Pending task
\`\`\`

### Rules
1. **One CURRENT task** - Only one task may have ← CURRENT
2. **Cite decisions** - Record user constraints or repository paths/sections as provenance; use \`ref:delegation-id\` for choices informed by delegated research. Research only material unresolved external or version-sensitive claims; never manufacture citations
3. **Track progress separately** - Routine task completion does not require a full-plan save
4. **Auto-save after approval** - When user approves your plan, immediately call \`plan_save\`. Do NOT wait for user to remind you or switch modes.
</plan-format>

<instruction name="plan_persistence" policy_level="critical">

## Plan Mode Active
You are in PLAN MODE. Your primary deliverable is a saved implementation plan.

## Requirements
1. **First**: Load the \`plan-protocol\` skill to understand the required plan schema
2. **During**: Collaborate with the user to develop a comprehensive, well-cited plan
3. **Before exiting**: Ensure the finalized plan is saved with \`plan_save\`; do not save it again if unchanged

## CRITICAL
Saving your plan is a REQUIREMENT, not a request. Plans that are not saved will be lost when the session ends or mode changes. The user cannot see your plan unless you save it.

</instruction>
</system-reminder>`

const BUILD_RULES = `<system-reminder>
${SHARED_PLAN_RULES}
<delegation-mandate policy_level="critical">

## You Are an ORCHESTRATOR

You coordinate work. You do NOT implement, read repository files, or execute Bash directly.
Use plan/delegation tools for context and coordination, and native \`task\` agents for implementation and command execution.

**CRITICAL CONSTRAINTS:**
- Code changes and immediate focused self-checks → native \`task\` with \`coder\`
- Difficult diagnosis and corrective repair → native \`task\` with \`debugger\`
- Independent execution of existing verification → native \`task\` with \`tester\`
- Documentation files → native \`task\` with \`scribe\`
- Git and pull-request operations → native \`task\` with \`committer\`
- Codebase questions → \`delegate\` to \`explore\` (INTERNAL only)
- External docs/APIs → \`delegate\` to \`researcher\` (EXTERNAL only)
- Review after tester evidence or a material-limitation disposition → \`delegate\` to \`reviewer\`

**You may NOT:**
- Read, edit, or write repository files directly
- Run Bash commands directly
- Auto-spawn follow-up agents; every task or delegation must be an explicit orchestration decision

</delegation-mandate>

<workspace-routing policy_level="critical">

## Agent Routing (STRICT BOUNDARIES)

| Agent | Scope | Use For |
|-------|-------|---------|
| \`explore\` | **INTERNAL ONLY** - codebase files | Find files, understand code structure, trace logic |
| \`researcher\` | **EXTERNAL ONLY** - outside codebase | Documentation, websites, npm packages, APIs, tutorials |
| \`coder\` | Implementation | Write/edit code and run proportionate immediate focused self-checks |
| \`debugger\` | Difficult diagnosis and repair | Isolate hard failures and apply corrective implementation |
| \`tester\` | Independent existing verification | Run requested existing checks and return terminal evidence without modifying code or tests |
| \`reviewer\` | Independent review | Review only after receiving tester evidence or an explicit material-limitation disposition |
| \`scribe\` | Documentation | Write project documentation while preserving repository conventions |
| \`committer\` | Git and pull requests | Create atomic commits and explicitly authorized pull requests |

## Boundary Rules

- \`explore\` CANNOT access external resources (docs, web, APIs)
- \`researcher\` CANNOT search codebase files
- \`coder\` owns implementation and implementation-level self-checks; it is not a proxy for every Bash command
- \`debugger\` is reserved for difficult diagnosis or repair, not routine verification
- \`tester\` independently runs existing verification; it never authors, proposes, modifies, or repairs tests and never loads \`testing-philosophy\`
- Test design remains coder-owned
- \`reviewer\` follows tester evidence or the parent's explicit disposition of a material verification limitation

</workspace-routing>

<build-workflow>

### Before Writing Code
1. Use the shared saved plan already in context; call \`plan_read\` only if missing or known to have changed
2. Reuse relevant findings already in context; use \`delegation_read\` for missing relevant artifacts and \`delegation_list\` only when their IDs are unknown
3. Request research only for material unresolved external or version-sensitive claims. User constraints and established repository conventions need honest provenance, not new research or manufactured citations
4. Treat research snippets as evidence to inspect and adapt to local versions and conventions, not as production-ready code
5. For a sufficiently scoped implementation, send the assignment directly to \`coder\`; its bounded repository discovery does not require preliminary \`explore\` delegation. Use \`explore\` when missing facts materially affect scope or design, not as a routine prerequisite

### Philosophy Loading
The parent loads philosophy only when making design decisions, not merely dispatching accepted work. The implementing child still loads applicable skills:
- Frontend design → \`skill\` load \`frontend-philosophy\`
- Backend design → \`skill\` load \`code-philosophy\`

### Execution and Verification
1. Orient: Reuse the plan and relevant delegation findings already in context; do not read repository files directly
2. Implement: Send bounded implementation to \`coder\` by shared plan task ID or section, including scope, constraints, expected evidence, and proportionate immediate focused self-checks
3. Verify independently: Call native \`task\` with \`tester\` only when the implementation is ready for verification
4. Give tester a self-contained handoff containing changed files, acceptance criteria, exact existing commands to run, and coder evidence
5. Dispose tester evidence:
   - \`passed\` → when ready for review, send only the verified scope, changed files, acceptance criteria, and tester evidence to \`reviewer\`; a batch pass does not verify the entire plan
   - \`failed\` → route correction to \`coder\` or difficult diagnosis/repair to \`debugger\`; request a tester rerun only through a new explicit parent \`task\` call
   - \`infrastructure-error\` or \`blocked\` → decide whether the limitation is material; review may proceed only when the limitation and disposition are supplied to \`reviewer\`
   - missing, unrecognized, or contradictory status → request a report-only correction using existing tester evidence; do not rerun commands solely for formatting. If actual evidence is missing, inaccessible, stale, or insufficient, explicitly request fresh verification for that gap
6. Document: Delegate documentation work to \`scribe\`
7. Commit: Delegate to \`committer\` only with explicit authorization for each requested commit, push, or pull-request action; plan acceptance is not Git authorization

Do not claim completion without independent tester evidence or an explicit disposition explaining a material verification limitation.
A coder's self-checks are implementation evidence, not independent verification.
A tester never fixes a failure; failed evidence returns to \`coder\` or \`debugger\`, and the tester reruns only when the parent explicitly requests it.

</build-workflow>

<code-review-protocol>

## Code Review Protocol

When implementation is ready for review:
1. Obtain and inspect the tester's terminal result and evidence before review
2. For \`passed\`, when the verified scope is ready, delegate that scope to \`reviewer\` with changed files, acceptance criteria, and compact tester evidence: status, exact commands, exit codes, decisive failures, limitations, and accessible artifact references. Inline essential evidence when artifacts are inaccessible to the recipient; do not require the complete tester payload
3. For \`failed\`, correct through \`coder\` or \`debugger\`, then explicitly rerun \`tester\`; do not review the failed implementation as complete
4. For \`infrastructure-error\` or \`blocked\`, make an explicit material-limitation disposition and provide it to \`reviewer\` if review proceeds
5. Include verification disposition and review findings in the completion report
6. If critical (🔴) or major (🟠) issues are found, route fixes to \`coder\` or \`debugger\` and repeat independent verification before completion

Do NOT review before tester evidence or an explicit material-limitation disposition.
Do NOT claim "done" or "complete" without that evidence or disposition.

</code-review-protocol>
</system-reminder>`

const WorkspacePlugin: Plugin = async (ctx) => {
	const { directory } = ctx

	// Use git root commit hash for cross-worktree consistency
	const projectId = await getProjectId(directory)
	const baseDir = path.join(os.homedir(), ".local", "share", "opencode", "workspace", projectId)

	/**
	 * Resolves the root session ID by walking up the parent chain.
	 */
	async function getRootSessionID(sessionID?: string): Promise<string> {
		if (!sessionID) {
			throw new Error("sessionID is required to resolve root session scope")
		}

		let currentID = sessionID
		for (let depth = 0; depth < 10; depth++) {
			const session = await ctx.client.session.get({
				path: { id: currentID },
			})

			if (!session.data?.parentID) {
				return currentID
			}

			currentID = session.data.parentID
		}

		throw new Error("Failed to resolve root session: maximum traversal depth exceeded")
	}

	return {
		tool: {
			plan_save: tool({
				description:
					"Save the implementation plan as markdown. Must include citations (ref:delegation-id) for decisions based on research. Plan is validated before saving.",
				args: {
					content: tool.schema.string().describe("The full plan in markdown format"),
				},
				async execute(args, toolCtx) {
					// Guard 1: Session required (Law 1: Early Exit)
					if (!toolCtx?.sessionID) {
						return "❌ plan_save requires sessionID. This is a system error."
					}

					const rootID = await getRootSessionID(toolCtx.sessionID)
					const sessionDir = path.join(baseDir, rootID)
					await fs.mkdir(sessionDir, { recursive: true })

					// Guard 2: Parse and validate at boundary (Law 2: Parse Don't Validate)
					const result = parsePlanMarkdown(args.content)
					if (!result.ok) {
						return formatParseError(result.error, result.hint)
					}

					// Happy path: save
					await fs.writeFile(path.join(sessionDir, "plan.md"), args.content, "utf8")
					const warningCount = result.warnings?.length ?? 0
					const warningText =
						warningCount > 0 ? ` (${warningCount} warnings: ${result.warnings?.join(", ")})` : ""

					return `Plan saved.${warningText}`
				},
			}),

			plan_read: tool({
				description: "Read the current implementation plan for this session.",
				args: {
					reason: tool.schema
						.string()
						.describe("Brief explanation of why you are calling this tool"),
				},
				async execute(_args, toolCtx) {
					// Guard: Session required (Law 1: Early Exit)
					if (!toolCtx?.sessionID) {
						return "❌ plan_read requires sessionID. This is a system error."
					}
					const rootID = await getRootSessionID(toolCtx.sessionID)
					const planPath = path.join(baseDir, rootID, "plan.md")
					try {
						return await fs.readFile(planPath, "utf8")
					} catch (error) {
						if (isNodeError(error) && error.code === "ENOENT") return "No plan found."
						throw error
					}
				},
			}),
		},

		// Targeted Rule Injection
		"experimental.chat.system.transform": async (input: SystemTransformInput, output) => {
			const agent = input.agent

			// Universal date awareness (all agents) - Law 2: Parse intent, not just data
			const today = new Date().toISOString().split("T")[0]
			output.system.push(`<date-awareness>
Today is ${today}. When searching for documentation, APIs, or external resources, use the current year (${new Date().getFullYear()}). Do not default to outdated years from training data.
</date-awareness>`)

			// Agent-specific rules
			if (agent === "plan") {
				output.system.push(PLAN_RULES)
			} else if (agent === "build") {
				output.system.push(BUILD_RULES)
			}
		},

		// Track coder and tester task starts within the parent session
		"tool.execute.before": async (
			input: { tool: string; sessionID?: string; callID?: string },
			output: { args?: { subagent_type?: string; agent?: string } },
		) => {
			if (input.tool !== "task") return
			if (!input.callID || !input.sessionID) return

			const agent = output.args?.subagent_type || output.args?.agent
			if (agent !== "coder" && agent !== "tester") return

			activeTaskCalls.set(input.callID, {
				agent,
				sessionID: input.sessionID,
				startTime: Date.now(),
			})
		},

		// Session-scoped implementation verification reminders
		"tool.execute.after": async (
			input: { tool: string; sessionID: string; callID: string },
			output: { title: string; output: string; metadata: unknown },
		) => {

			if (!input.callID) return
			const trackedTask = activeTaskCalls.get(input.callID)
			if (!trackedTask) return

			activeTaskCalls.delete(input.callID)

			if (hasActiveTaskForSession(trackedTask.agent, trackedTask.sessionID)) return

			if (trackedTask.agent === "coder") {
				output.output += `\n\n<system-reminder>
No coder calls are currently active in this session; this does not mean the final planned task or implementation is complete. Assess the returned scope and evidence. When an implementation batch is ready, explicitly run native \`task\` with \`tester\` for independent existing verification before review.
Give tester bounded shared-plan references, changed files, exact existing commands, and compact coder evidence (status, commands, exit codes, decisive failures, limitations, accessible artifacts); inline essentials when artifacts are inaccessible. Tester must not author or repair tests.
</system-reminder>`
				return
			}

			const testerResult = parseTesterResult(output.output)
			switch (testerResult) {
				case "passed":
					output.output += `\n\n<system-reminder>
Tester RESULT is passed. Inspect the evidence and its coverage; the status alone does not prove completion. When ready, proceed to \`reviewer\` for only the verified scope with changed files, acceptance criteria, and compact evidence: status, commands, exit codes, decisive failures, limitations, and accessible artifacts. Inline essentials when artifacts are inaccessible; do not imply the entire plan is verified.
</system-reminder>`
					break
				case "failed":
					output.output += `\n\n<system-reminder>
Tester RESULT is failed. Route correction to \`coder\`, or difficult diagnosis/repair to \`debugger\`. After correction, rerun \`tester\` only through a new explicit parent task request before review or completion.
</system-reminder>`
					break
				case "infrastructure-error":
				case "blocked":
					output.output += `\n\n<system-reminder>
Tester RESULT is ${testerResult}. Make an explicit disposition of the material verification limitation. Review may proceed only if the limitation and disposition are supplied to \`reviewer\`; do not claim unqualified completion.
</system-reminder>`
					break
				default:
					output.output += `\n\n<system-reminder>
Tester result is invalid: a recognized, non-contradictory standalone \`RESULT: passed | failed | infrastructure-error | blocked\` line is required. Request a report-only correction with the existing tester evidence and required final contract; do not rerun commands solely for formatting. Supply accessible artifacts or inline essential evidence. If actual verification evidence is missing, inaccessible, stale, or insufficient, explicitly request fresh verification of the gap instead. Do not route a reporting failure to debugger.
</system-reminder>`
			}
		},

		// Compaction Hook - Inject plan context when session is compacted
		"experimental.session.compacting": async (
			input: { sessionID: string },
			output: { context: string[]; prompt?: string },
		) => {
			const rootID = await getRootSessionID(input.sessionID)
			const planPath = path.join(baseDir, rootID, "plan.md")

			let planContent: string | null = null
			try {
				planContent = await fs.readFile(planPath, "utf8")
			} catch (error) {
				if (!isNodeError(error) || error.code !== "ENOENT") throw error
			}

			if (!planContent) return

			// Extract current task from plan
			const currentMatch = planContent.match(/← CURRENT/)
			let currentTask: string | null = null
			if (currentMatch?.index !== undefined) {
				const start = Math.max(0, currentMatch.index - 100)
				const end = currentMatch.index + 50
				currentTask = planContent.slice(start, end).match(/\d+\.\d+ [^\n←]+/)?.[0] ?? null
			}

			output.context.push(`<workspace-context>
## Current Plan
${planContent}

## Design Reference
${currentTask ? `Task marked in saved plan: ${currentTask}` : "No task marked as CURRENT"}
The saved plan is a design artifact; its task markers may not reflect execution progress. Reuse this plan context without rereading it unless it has changed.

## Verification
Verify decisions against their stated provenance: user constraints, repository paths/sections, or relevant research artifacts. Use \`delegation_read("id")\` for missing delegated evidence; do not manufacture research for user or repository provenance.
</workspace-context>`)
		},
	}
}

export default WorkspacePlugin
