/**
 * notify
 * Native OS notifications for OpenCode
 *
 * Philosophy: "Notify the human when the AI needs them back, not for every micro-event."
 *
 * Features:
 * - Uses cmux native notifications and session status when running inside cmux
 * - Auto-detects terminal emulator (Ghostty, Kitty, iTerm, WezTerm, etc.)
 * - Suppresses notifications when terminal is focused (like Ghostty does)
 * - Click notification to focus terminal
 * - Only debug, plan, and build primary sessions; child activity is always silent
 *
 * Uses cmux CLI first (if available), then node-notifier fallback:
 * - cmux: `cmux notify --title ... --subtitle ... --body ...`
 * - cmux status: `cmux set-status <key> <value>` / `cmux clear-status <key>`
 * - macOS: terminal-notifier (native NSUserNotificationCenter)
 * - Windows: SnoreToast (native toast notifications)
 * - Linux: notify-send (native desktop notifications)
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
// @ts-expect-error - installed at runtime by OCX
import detectTerminal from "detect-terminal"
// @ts-expect-error - installed at runtime by OCX
import notifier from "node-notifier"
import type { OpencodeClient } from "./kdco-primitives/types"
import { sendNotificationWithFallback } from "./notify/backend"
import {
	canUseCmuxNotification,
	clearCmuxStatus,
	sendCmuxNotification,
	sendCmuxStatus,
} from "./notify/cmux"
import {
	buildCmuxSessionStatusTransitionForEvent,
	buildCmuxSessionStatusTransitionForQuestionTool,
	getCmuxSessionStatusText,
	type CmuxSessionStatusTransition,
} from "./notify/status"
import { parseOscTitleContext, writeOscTitleBestEffort } from "./notify/title"

interface NotifyConfig {
	/** @deprecated Ignored: Workcell never notifies for child sessions. */
	notifyChildSessions: boolean
	/** Sound configuration per event type */
	sounds: {
		idle: string
		error: string
		permission: string
		question?: string
	}
	/** Quiet hours configuration */
	quietHours: {
		enabled: boolean
		start: string // "HH:MM" format
		end: string // "HH:MM" format
	}
	/** Override terminal detection (optional) */
	terminal?: string
}

interface TerminalInfo {
	name: string | null
	bundleId: string | null
	processName: string | null
}

const DEFAULT_CONFIG: NotifyConfig = {
	notifyChildSessions: false,
	sounds: {
		idle: "Glass",
		error: "Basso",
		permission: "Submarine",
	},
	quietHours: {
		enabled: false,
		start: "22:00",
		end: "08:00",
	},
}

// Terminal name to macOS process name mapping (for focus detection)
const TERMINAL_PROCESS_NAMES: Record<string, string> = {
	ghostty: "Ghostty",
	kitty: "kitty",
	iterm: "iTerm2",
	iterm2: "iTerm2",
	wezterm: "WezTerm",
	alacritty: "Alacritty",
	terminal: "Terminal",
	apple_terminal: "Terminal",
	hyper: "Hyper",
	warp: "Warp",
	vscode: "Code",
	"vscode-insiders": "Code - Insiders",
}

// ==========================================
// CONFIGURATION
// ==========================================

async function loadConfig(): Promise<NotifyConfig> {
	const configPath = path.join(os.homedir(), ".config", "opencode", "kdco-notify.json")

	try {
		const content = await fs.readFile(configPath, "utf8")
		const userConfig = JSON.parse(content) as Partial<NotifyConfig>

		// Merge with defaults
		return {
			...DEFAULT_CONFIG,
			...userConfig,
			sounds: {
				...DEFAULT_CONFIG.sounds,
				...userConfig.sounds,
			},
			quietHours: {
				...DEFAULT_CONFIG.quietHours,
				...userConfig.quietHours,
			},
		}
	} catch {
		// Config doesn't exist or is invalid, use defaults
		return DEFAULT_CONFIG
	}
}

// ==========================================
// TERMINAL DETECTION (macOS)
// ==========================================

async function runOsascript(script: string): Promise<string | null> {
	if (process.platform !== "darwin") return null

	try {
		const proc = Bun.spawn(["osascript", "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
		})
		const output = await new Response(proc.stdout).text()
		return output.trim()
	} catch {
		return null
	}
}

async function getBundleId(appName: string): Promise<string | null> {
	return runOsascript(`id of application "${appName}"`)
}

async function getFrontmostApp(): Promise<string | null> {
	return runOsascript(
		'tell application "System Events" to get name of first application process whose frontmost is true',
	)
}

async function detectTerminalInfo(config: NotifyConfig): Promise<TerminalInfo> {
	// Use config override if provided
	const terminalName = config.terminal || detectTerminal() || null

	if (!terminalName) {
		return { name: null, bundleId: null, processName: null }
	}

	// Get process name for focus detection
	const processName = TERMINAL_PROCESS_NAMES[terminalName.toLowerCase()] || terminalName

	// Dynamically get bundle ID from macOS (no hardcoding!)
	const bundleId = await getBundleId(processName)

	return {
		name: terminalName,
		bundleId,
		processName,
	}
}

async function isTerminalFocused(terminalInfo: TerminalInfo): Promise<boolean> {
	if (!terminalInfo.processName) return false
	if (process.platform !== "darwin") return false

	const frontmost = await getFrontmostApp()
	if (!frontmost) return false

	// Case-insensitive comparison
	return frontmost.toLowerCase() === terminalInfo.processName.toLowerCase()
}

// ==========================================
// QUIET HOURS CHECK
// ==========================================

function isQuietHours(config: NotifyConfig): boolean {
	if (!config.quietHours.enabled) return false

	const now = new Date()
	const currentMinutes = now.getHours() * 60 + now.getMinutes()

	const [startHour, startMin] = config.quietHours.start.split(":").map(Number)
	const [endHour, endMin] = config.quietHours.end.split(":").map(Number)

	const startMinutes = startHour * 60 + startMin
	const endMinutes = endHour * 60 + endMin

	// Handle overnight quiet hours (e.g., 22:00 - 08:00)
	if (startMinutes > endMinutes) {
		return currentMinutes >= startMinutes || currentMinutes < endMinutes
	}

	return currentMinutes >= startMinutes && currentMinutes < endMinutes
}

// ==========================================
// SOURCE SESSION OWNERSHIP
// ==========================================

async function getNotificationSession(client: OpencodeClient, sessionID: string) {
	try {
		const { data, error } = await client.session.get({ path: { id: sessionID } })
		// OpenCode 1.18.25 returns persisted Session.agent on GET /session/:id.
		// Its legacy SDK omits that field (the v2 Session schema includes it).
		// Validate the wire field rather than casting the legacy client to v2.
		// This is current session identity, not historical event-time attribution.
		if (error || !data || data.id !== sessionID || data.parentID !== undefined) return null
		if (!("agent" in data)) return null
		if (data.agent !== "debug" && data.agent !== "plan" && data.agent !== "build") return null
		return data
	} catch {
		return null
	}
}

// ==========================================
// NOTIFICATION SENDER
// ==========================================

interface NotificationOptions {
	title: string
	message: string
	subtitle?: string
	cmuxBody?: string
	sound: string
	terminalInfo: TerminalInfo
}

interface NotificationRuntime {
	preferCmux: boolean
}

const QUESTION_DEDUPE_WINDOW_MS = 1500
const READY_DEDUPE_WINDOW_MS = 1500
const PERMISSION_DEDUPE_WINDOW_MS = 1500
const CMUX_SESSION_STATUS_KEY_PREFIX = "opencode.session"
const CMUX_BUSY_ANIMATION_INTERVAL_MS = 80
const CMUX_BUSY_ANIMATION_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

type RecentNotifications = Map<string, number>
type SessionLogicalState = CmuxSessionStatusTransition["logicalState"]
type CmuxSessionLogicalStateBySessionID = Map<
	string,
	SessionLogicalState
>
type TitleSessionLogicalStateBySessionID = Map<string, SessionLogicalState>
type CmuxSessionStatusWriteIntent =
	| {
		readonly sessionID: string
		readonly kind: "set-status"
		readonly text: string
	}
	| {
		readonly sessionID: string
		readonly kind: "clear-status"
	}

function isCmuxSessionStatusWriteIntentEqual(
	left: CmuxSessionStatusWriteIntent,
	right: CmuxSessionStatusWriteIntent,
): boolean {
	if (left.kind !== right.kind) return false
	if (left.kind === "clear-status" || right.kind === "clear-status") return true
	return left.text === right.text
}

function buildCmuxSessionStatusWriteIntentForLogicalState(
	sessionID: string,
	logicalState: Exclude<CmuxSessionStatusTransition["logicalState"], "animated-busy">,
): CmuxSessionStatusWriteIntent {
	if (logicalState === "idle") {
		return {
			sessionID,
			kind: "clear-status",
		}
	}

	return {
		sessionID,
		kind: "set-status",
		text: getCmuxSessionStatusText(logicalState),
	}
}

function buildCmuxSessionStatusKey(sessionID: string): string {
	return `${CMUX_SESSION_STATUS_KEY_PREFIX}.${sessionID}`
}

function toNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") return null

	const normalized = value.trim()
	if (!normalized) return null

	return normalized
}

function shouldSendDedupedNotification(
	recentNotifications: RecentNotifications,
	dedupeKey: string,
	windowMs: number,
	nowMs = Date.now(),
): boolean {
	for (const [key, timestamp] of recentNotifications) {
		if (nowMs - timestamp >= windowMs) {
			recentNotifications.delete(key)
		}
	}

	const lastSentAt = recentNotifications.get(dedupeKey)
	if (lastSentAt !== undefined && nowMs - lastSentAt < windowMs) {
		return false
	}

	recentNotifications.set(dedupeKey, nowMs)
	return true
}

function buildQuestionToolDedupeKey(sessionID: unknown, callID: unknown): string | null {
	const normalizedSessionID = toNonEmptyString(sessionID)
	if (!normalizedSessionID) return null

	const normalizedCallID = toNonEmptyString(callID)
	if (!normalizedCallID) return null

	return `question:${normalizedSessionID}:${normalizedCallID}`
}

function buildQuestionEventDedupeKey(properties: unknown): string | null {
	if (!properties || typeof properties !== "object") return null

	const record = properties as Record<string, unknown>
	const normalizedSessionID = toNonEmptyString(record.sessionID)
	if (!normalizedSessionID) return null

	const toolInfo =
		record.tool && typeof record.tool === "object"
			? (record.tool as Record<string, unknown>)
			: undefined
	const normalizedCallID = toNonEmptyString(toolInfo?.callID)
	if (normalizedCallID) {
		return `question:${normalizedSessionID}:${normalizedCallID}`
	}

	const normalizedRequestID = toNonEmptyString(record.id)
	if (normalizedRequestID) {
		return `question:${normalizedSessionID}:request:${normalizedRequestID}`
	}

	return null
}

function buildSessionReadyDedupeKey(sessionID: unknown): string | null {
	const normalizedSessionID = toNonEmptyString(sessionID)
	if (!normalizedSessionID) return null

	return `session-ready:${normalizedSessionID}`
}

function buildPermissionEventDedupeKey(properties: unknown): string | null {
	if (!properties || typeof properties !== "object") return null

	const record = properties as Record<string, unknown>
	const normalizedRequestID = toNonEmptyString(record.id)
	if (!normalizedRequestID) return null

	return `permission:request:${normalizedRequestID}`
}

function sendNodeNotification(options: NotificationOptions): void {
	const { title, message, sound, terminalInfo } = options

	// Base notification options
	const notifyOptions: Record<string, unknown> = {
		title,
		message,
		sound,
	}

	// macOS-specific: click notification to focus terminal
	if (process.platform === "darwin" && terminalInfo.bundleId) {
		notifyOptions.activate = terminalInfo.bundleId
	}

	notifier.notify(notifyOptions)
}

async function sendNotification(
	options: NotificationOptions,
	runtime: NotificationRuntime,
): Promise<void> {
	await sendNotificationWithFallback({
		preferCmux: runtime.preferCmux,
		tryCmuxNotify: () =>
			sendCmuxNotification({
				title: options.title,
				subtitle: options.subtitle,
				body: options.cmuxBody ?? options.message,
			}),
		sendNodeNotify: () => sendNodeNotification(options),
	})
}

// ==========================================
// EVENT HANDLERS
// ==========================================

async function handleSessionIdle(
	sessionTitle: string,
	config: NotifyConfig,
	terminalInfo: TerminalInfo,
	notificationRuntime: NotificationRuntime,
): Promise<void> {
	// Check quiet hours
	if (isQuietHours(config)) return

	// Check if terminal is focused (suppress notification if user is already looking)
	if (await isTerminalFocused(terminalInfo)) return

	await sendNotification(
		{
			title: "Ready for review",
			message: sessionTitle,
			subtitle: sessionTitle,
			cmuxBody: "OpenCode task is ready for review",
			sound: config.sounds.idle,
			terminalInfo,
		},
		notificationRuntime,
	)
}

async function handleSessionError(
	error: string | undefined,
	config: NotifyConfig,
	terminalInfo: TerminalInfo,
	notificationRuntime: NotificationRuntime,
): Promise<void> {
	// Check quiet hours
	if (isQuietHours(config)) return

	// Check if terminal is focused (suppress notification if user is already looking)
	if (await isTerminalFocused(terminalInfo)) return

	const errorMessage = error?.slice(0, 100) || "Something went wrong"

	await sendNotification(
		{
			title: "Something went wrong",
			message: errorMessage,
			sound: config.sounds.error,
			terminalInfo,
		},
		notificationRuntime,
	)
}

async function handlePermissionUpdated(
	config: NotifyConfig,
	terminalInfo: TerminalInfo,
	notificationRuntime: NotificationRuntime,
): Promise<void> {
	// Check quiet hours
	if (isQuietHours(config)) return

	// Check if terminal is focused (suppress notification if user is already looking)
	if (await isTerminalFocused(terminalInfo)) return

	await sendNotification(
		{
			title: "Waiting for you",
			message: "OpenCode needs your input",
			sound: config.sounds.permission,
			terminalInfo,
		},
		notificationRuntime,
	)
}

async function handleQuestionAsked(
	config: NotifyConfig,
	terminalInfo: TerminalInfo,
	notificationRuntime: NotificationRuntime,
): Promise<void> {
	// Guard: quiet hours only (no focus check for questions - tmux workflow)
	if (isQuietHours(config)) return

	const sound = config.sounds.question ?? config.sounds.permission

	await sendNotification(
		{
			title: "Question for you",
			message: "OpenCode needs your input",
			sound,
			terminalInfo,
		},
		notificationRuntime,
	)
}

// ==========================================
// PLUGIN EXPORT
// ==========================================

const NotifyPlugin: Plugin = async (ctx) => {
	const { client } = ctx

	// Load config once at startup
	const config = await loadConfig()

	// Detect terminal once at startup (cached for performance)
	const terminalInfo = await detectTerminalInfo(config)
	const notificationRuntime: NotificationRuntime = {
		preferCmux: canUseCmuxNotification(),
	}
	const oscTitleContext = parseOscTitleContext()
	const shouldSuppressCmuxSessionStatusWrites = oscTitleContext?.mayWriteOscTitle === true
	const recentQuestionNotifications: RecentNotifications = new Map()
	const recentReadyNotifications: RecentNotifications = new Map()
	const recentPermissionNotifications: RecentNotifications = new Map()
	const titleSessionLogicalStates: TitleSessionLogicalStateBySessionID = new Map()
	const titleBusySessionIDs = new Set<string>()
	let titleBusySpinnerFrameIndex = 0
	let titleBusySpinnerTicker: ReturnType<typeof setInterval> | null = null
	let lastWrittenOscTitle: string | null = null
	const cmuxSessionLogicalStates: CmuxSessionLogicalStateBySessionID = new Map()
	const committedCmuxSessionStatusWrites = new Map<string, CmuxSessionStatusWriteIntent>()
	const pendingCmuxSessionStatusWrites = new Map<string, CmuxSessionStatusWriteIntent>()
	const animatedBusySessionIDs = new Set<string>()
	const busyAnimationFrameIndexBySessionID = new Map<string, number>()
	let busyAnimationTicker: ReturnType<typeof setInterval> | null = null
	let cmuxStatusUpdatesDisabled = shouldSuppressCmuxSessionStatusWrites
	let isCmuxStatusDrainActive = false
	let inFlightCmuxSessionStatusWrite: CmuxSessionStatusWriteIntent | null = null

	const writeOscTitleIfNeeded = (title: string): void => {
		if (!oscTitleContext?.mayWriteOscTitle) return
		if (lastWrittenOscTitle === title) return

		lastWrittenOscTitle = title
		writeOscTitleBestEffort(title)
	}

	const buildBusySpinnerTitle = (): string => {
		const frame =
			CMUX_BUSY_ANIMATION_FRAMES[titleBusySpinnerFrameIndex] ?? CMUX_BUSY_ANIMATION_FRAMES[0]
		titleBusySpinnerFrameIndex = (titleBusySpinnerFrameIndex + 1) % CMUX_BUSY_ANIMATION_FRAMES.length
		return `${frame} ${oscTitleContext?.baseTitle ?? ""}`
	}

	const stopTitleBusySpinnerTicker = (): void => {
		if (!titleBusySpinnerTicker) return

		clearInterval(titleBusySpinnerTicker)
		titleBusySpinnerTicker = null
	}

	const writeNextBusyOscTitleFrame = (): void => {
		if (titleBusySessionIDs.size === 0) {
			return
		}

		writeOscTitleIfNeeded(buildBusySpinnerTitle())
	}

	const startTitleBusySpinnerTicker = (): void => {
		if (!oscTitleContext?.mayWriteOscTitle) return
		if (titleBusySpinnerTicker || titleBusySessionIDs.size === 0) return

		const interval = setInterval(() => {
			if (titleBusySessionIDs.size === 0) {
				stopTitleBusySpinnerTicker()
				return
			}

			writeNextBusyOscTitleFrame()
		}, CMUX_BUSY_ANIMATION_INTERVAL_MS)

		;(interval as { unref?: () => void }).unref?.()
		titleBusySpinnerTicker = interval
	}

	const startBusyOscTitleForSession = (sessionID: string): void => {
		const wasBusy = titleBusySessionIDs.has(sessionID)
		titleBusySessionIDs.add(sessionID)

		if (!wasBusy && titleBusySessionIDs.size === 1) {
			titleBusySpinnerFrameIndex = 0
			writeNextBusyOscTitleFrame()
		}

		startTitleBusySpinnerTicker()
	}

	const stopBusyOscTitleForSession = (sessionID: string): void => {
		titleBusySessionIDs.delete(sessionID)

		if (titleBusySessionIDs.size > 0) {
			return
		}

		stopTitleBusySpinnerTicker()
		titleBusySpinnerFrameIndex = 0
		if (oscTitleContext) {
			writeOscTitleIfNeeded(oscTitleContext.baseTitle)
		}
	}

	const applyOscTitleSessionStatusTransition = (
		transition: CmuxSessionStatusTransition | null,
	): void => {
		if (!oscTitleContext?.mayWriteOscTitle || !transition) return

		const previousLogicalState = titleSessionLogicalStates.get(transition.sessionID)
		if (previousLogicalState === transition.logicalState) return

		titleSessionLogicalStates.set(transition.sessionID, transition.logicalState)

		if (transition.logicalState === "animated-busy") {
			startBusyOscTitleForSession(transition.sessionID)
			return
		}

		stopBusyOscTitleForSession(transition.sessionID)
	}

	const pruneCmuxSessionStateAfterTerminalClear = (sessionID: string): boolean => {
		if (cmuxSessionLogicalStates.get(sessionID) !== "idle") return false
		if (pendingCmuxSessionStatusWrites.has(sessionID)) return false
		if (inFlightCmuxSessionStatusWrite?.sessionID === sessionID) return false

		cmuxSessionLogicalStates.delete(sessionID)
		committedCmuxSessionStatusWrites.delete(sessionID)
		animatedBusySessionIDs.delete(sessionID)
		busyAnimationFrameIndexBySessionID.delete(sessionID)

		if (animatedBusySessionIDs.size === 0) {
			stopBusyAnimationTicker()
		}

		return true
	}

	const stopBusyAnimationTicker = (): void => {
		if (!busyAnimationTicker) return

		clearInterval(busyAnimationTicker)
		busyAnimationTicker = null
	}

	const clearBusyAnimationState = (): void => {
		stopBusyAnimationTicker()
		animatedBusySessionIDs.clear()
		busyAnimationFrameIndexBySessionID.clear()
	}

	const getLatestCmuxSessionStatusWriteForSession = (
		sessionID: string,
	): CmuxSessionStatusWriteIntent | undefined => {
		const pendingWrite = pendingCmuxSessionStatusWrites.get(sessionID)
		if (pendingWrite) {
			return pendingWrite
		}

		if (inFlightCmuxSessionStatusWrite?.sessionID === sessionID) {
			return inFlightCmuxSessionStatusWrite
		}

		return committedCmuxSessionStatusWrites.get(sessionID)
	}

	const dequeueNextCmuxSessionStatusWrite = (): CmuxSessionStatusWriteIntent | null => {
		const next = pendingCmuxSessionStatusWrites.values().next().value
		if (!next) return null

		pendingCmuxSessionStatusWrites.delete(next.sessionID)
		return next
	}

	const runCmuxSessionStatusWrite = async (
		writeIntent: CmuxSessionStatusWriteIntent,
	): Promise<boolean> => {
		const statusKey = buildCmuxSessionStatusKey(writeIntent.sessionID)
		if (writeIntent.kind === "clear-status") {
			return clearCmuxStatus({ key: statusKey })
		}

		return sendCmuxStatus({
			key: statusKey,
			text: writeIntent.text,
		})
	}

	const drainCmuxSessionStatusWrites = async (): Promise<void> => {
		if (isCmuxStatusDrainActive || cmuxStatusUpdatesDisabled) return

		isCmuxStatusDrainActive = true

		try {
			while (!cmuxStatusUpdatesDisabled) {
				const nextWriteIntent = dequeueNextCmuxSessionStatusWrite()
				if (!nextWriteIntent) return

				inFlightCmuxSessionStatusWrite = nextWriteIntent
				const didUpdateStatus = await runCmuxSessionStatusWrite(nextWriteIntent)
				inFlightCmuxSessionStatusWrite = null

				if (!didUpdateStatus) {
					cmuxStatusUpdatesDisabled = true
					pendingCmuxSessionStatusWrites.clear()
					clearBusyAnimationState()
					return
				}

				if (
					nextWriteIntent.kind === "clear-status" &&
					pruneCmuxSessionStateAfterTerminalClear(nextWriteIntent.sessionID)
				) {
					continue
				}

				committedCmuxSessionStatusWrites.set(nextWriteIntent.sessionID, nextWriteIntent)
			}
		} finally {
			inFlightCmuxSessionStatusWrite = null
			isCmuxStatusDrainActive = false

			if (!cmuxStatusUpdatesDisabled && pendingCmuxSessionStatusWrites.size > 0) {
				void drainCmuxSessionStatusWrites()
			}
		}
	}

	const enqueueCmuxSessionStatusWrite = (writeIntent: CmuxSessionStatusWriteIntent): void => {
		if (!notificationRuntime.preferCmux || cmuxStatusUpdatesDisabled) return

		const latestWriteIntent = getLatestCmuxSessionStatusWriteForSession(writeIntent.sessionID)
		if (latestWriteIntent && isCmuxSessionStatusWriteIntentEqual(latestWriteIntent, writeIntent)) return

		pendingCmuxSessionStatusWrites.set(writeIntent.sessionID, writeIntent)
		void drainCmuxSessionStatusWrites()
	}

	const enqueueNextBusyAnimationFrame = (sessionID: string): void => {
		if (!animatedBusySessionIDs.has(sessionID)) return

		const frameIndex = busyAnimationFrameIndexBySessionID.get(sessionID) ?? 0
		const frameText = CMUX_BUSY_ANIMATION_FRAMES[frameIndex] ?? CMUX_BUSY_ANIMATION_FRAMES[0]

		busyAnimationFrameIndexBySessionID.set(
			sessionID,
			(frameIndex + 1) % CMUX_BUSY_ANIMATION_FRAMES.length,
		)

		enqueueCmuxSessionStatusWrite({
			sessionID,
			kind: "set-status",
			text: frameText,
		})
	}

	const startBusyAnimationTicker = (): void => {
		if (busyAnimationTicker || cmuxStatusUpdatesDisabled || animatedBusySessionIDs.size === 0) return

		const interval = setInterval(() => {
			if (cmuxStatusUpdatesDisabled) {
				clearBusyAnimationState()
				return
			}

			if (animatedBusySessionIDs.size === 0) {
				stopBusyAnimationTicker()
				return
			}

			for (const sessionID of animatedBusySessionIDs) {
				enqueueNextBusyAnimationFrame(sessionID)
			}
		}, CMUX_BUSY_ANIMATION_INTERVAL_MS)

		;(interval as { unref?: () => void }).unref?.()
		busyAnimationTicker = interval
	}

	const startBusyAnimationForSession = (sessionID: string): void => {
		const wasAnimating = animatedBusySessionIDs.has(sessionID)
		animatedBusySessionIDs.add(sessionID)

		if (!wasAnimating) {
			busyAnimationFrameIndexBySessionID.set(sessionID, 0)
			enqueueNextBusyAnimationFrame(sessionID)
		}

		startBusyAnimationTicker()
	}

	const stopBusyAnimationForSession = (sessionID: string): void => {
		animatedBusySessionIDs.delete(sessionID)
		busyAnimationFrameIndexBySessionID.delete(sessionID)

		if (animatedBusySessionIDs.size === 0) {
			stopBusyAnimationTicker()
		}
	}

	const applyCmuxSessionStatusTransition = (
		transition: CmuxSessionStatusTransition | null,
	): void => {
		if (!notificationRuntime.preferCmux || !transition || cmuxStatusUpdatesDisabled) return

		const previousLogicalState = cmuxSessionLogicalStates.get(transition.sessionID)
		if (previousLogicalState === transition.logicalState) return

		cmuxSessionLogicalStates.set(transition.sessionID, transition.logicalState)

		if (transition.logicalState === "animated-busy") {
			startBusyAnimationForSession(transition.sessionID)
			return
		}

		stopBusyAnimationForSession(transition.sessionID)
		enqueueCmuxSessionStatusWrite(
			buildCmuxSessionStatusWriteIntentForLogicalState(
				transition.sessionID,
				transition.logicalState,
			),
		)
	}

	const applyRuntimeSessionStatusTransition = (
		transition: CmuxSessionStatusTransition | null,
	): void => {
		applyOscTitleSessionStatusTransition(transition)
		applyCmuxSessionStatusTransition(transition)
	}

	const notifyQuestionIfNeeded = async (dedupeKey: string | null): Promise<void> => {
		if (
			dedupeKey &&
			!shouldSendDedupedNotification(
				recentQuestionNotifications,
				dedupeKey,
				QUESTION_DEDUPE_WINDOW_MS,
			)
		) {
			return
		}

		await handleQuestionAsked(config, terminalInfo, notificationRuntime)
	}

	const notifySessionReadyIfNeeded = async (sessionID: unknown, title: string): Promise<void> => {
		const normalizedSessionID = toNonEmptyString(sessionID)
		if (!normalizedSessionID) return

		const dedupeKey = buildSessionReadyDedupeKey(normalizedSessionID)
		if (!dedupeKey) return

		if (
			!shouldSendDedupedNotification(recentReadyNotifications, dedupeKey, READY_DEDUPE_WINDOW_MS)
		) {
			return
		}

		await handleSessionIdle(
			title.slice(0, 50) || "Task",
			config,
			terminalInfo,
			notificationRuntime,
		)
	}

	const notifyPermissionIfNeeded = async (properties: unknown): Promise<void> => {
		const dedupeKey = buildPermissionEventDedupeKey(properties)

		if (
			dedupeKey &&
			!shouldSendDedupedNotification(
				recentPermissionNotifications,
				dedupeKey,
				PERMISSION_DEDUPE_WINDOW_MS,
			)
		) {
			return
		}

		await handlePermissionUpdated(config, terminalInfo, notificationRuntime)
	}

	// Serialize lookup AND effects per source, so a slow busy lookup cannot
	// overtake idle/deletion. These promises are not an authorization cache.
	const sourceQueues = new Map<string, Promise<void>>()
	const forgetSource = (sessionID: string): void => {
		// Only retire state this source previously owned; a child cannot clear
		// its parent's status or reset an otherwise untouched terminal title.
		if (titleSessionLogicalStates.has(sessionID)) {
			stopBusyOscTitleForSession(sessionID)
			titleSessionLogicalStates.delete(sessionID)
		}
		if (cmuxSessionLogicalStates.has(sessionID)) {
			applyCmuxSessionStatusTransition({ sessionID, logicalState: "idle" })
		}
	}
	const withNotificationSource = (
		sourceID: unknown,
		deleted: boolean,
		action: (title: string) => Promise<void>,
	): Promise<void> => {
		const sessionID = toNonEmptyString(sourceID)
		if (!sessionID) return Promise.resolve()
		const previous = sourceQueues.get(sessionID) ?? Promise.resolve()
		const next = previous.catch(() => {}).then(async () => {
			const session = deleted ? null : await getNotificationSession(client, sessionID)
			if (!session) {
				forgetSource(sessionID)
				return
			}
			await action(session.title)
		})
		sourceQueues.set(sessionID, next)
		return next.finally(() => {
			if (sourceQueues.get(sessionID) === next) sourceQueues.delete(sessionID)
		})
	}

	return {
		"tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }) => {
			if (input.tool === "question") {
				await withNotificationSource(input.sessionID, false, async () => {
					applyRuntimeSessionStatusTransition(
						buildCmuxSessionStatusTransitionForQuestionTool(input.sessionID),
					)
					await notifyQuestionIfNeeded(buildQuestionToolDedupeKey(input.sessionID, input.callID))
				})
			}
		},
		event: async ({ event }: { event: Event }): Promise<void> => {
			const runtimeEvent = event as { type: string; properties: Record<string, unknown> }
			if (!runtimeEvent.properties || typeof runtimeEvent.properties !== "object") return
			const lifecycle =
				runtimeEvent.type === "session.updated" || runtimeEvent.type === "session.deleted"
			const info = runtimeEvent.properties.info
			const sourceID =
				lifecycle && info && typeof info === "object" && "id" in info
					? info.id
					: runtimeEvent.properties.sessionID
			const runtimeSessionStatusTransition = buildCmuxSessionStatusTransitionForEvent(
				runtimeEvent.type,
				runtimeEvent.properties,
			)
			if (!lifecycle && !runtimeSessionStatusTransition) return
			await withNotificationSource(sourceID, runtimeEvent.type === "session.deleted", async (title) => {
				applyRuntimeSessionStatusTransition(runtimeSessionStatusTransition)

				switch (runtimeEvent.type) {
					case "session.status":
					case "session.idle": {
						if (runtimeSessionStatusTransition?.logicalState === "idle") {
							await notifySessionReadyIfNeeded(runtimeSessionStatusTransition.sessionID, title)
						}
						break
					}
					case "session.error": {
						const error = runtimeEvent.properties.error
						const errorMessage = typeof error === "string" ? error : error ? String(error) : undefined
						await handleSessionError(
							errorMessage,
							config,
							terminalInfo,
							notificationRuntime,
						)
						break
					}

					case "permission.updated":
					case "permission.asked": {
						await notifyPermissionIfNeeded(runtimeEvent.properties)
						break
					}
					case "question.asked": {
						const dedupeKey = buildQuestionEventDedupeKey(runtimeEvent.properties)
						await notifyQuestionIfNeeded(dedupeKey)
						break
					}
				}
			})
		},
	}
}

export default NotifyPlugin
