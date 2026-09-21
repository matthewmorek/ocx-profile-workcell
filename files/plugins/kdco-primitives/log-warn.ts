/**
 * Warning logger for kdco registry plugins.
 *
 * V2 exposes no app logging API; warnings go to the host's stderr.
 *
 * @module kdco-primitives/log-warn
 */

import type { OpencodeClient } from "./types"

/**
 * Log a warning message to the host's stderr.
 * @param client - Retained for existing support-module callers; not used by V2.
 * @param service - Service name for log categorization (e.g., "worktree", "delegation")
 * @param message - Warning message to log
 *
 * @example
 * ```ts
 * // With client
 * logWarn(client, "delegation", "Task timed out after 30s")
 *
 * // Without client - logs to console
 * logWarn(undefined, "delegation", "Task timed out after 30s")
 * ```
 */
export function logWarn(
	_client: OpencodeClient | undefined,
	service: string,
	message: string,
): void {
	console.warn(`[${service}] ${message}`)
}
