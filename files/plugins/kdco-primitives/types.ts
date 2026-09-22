/**
 * Shared types for kdco registry plugins.
 *
 * @module kdco-primitives/types
 */

import type { OpenCodeClient } from "@opencode/client"

/**
 * OpenCode client instance type.
 * Public HTTP client; never embeds another OpenCode host.
 */
export type OpencodeClient = OpenCodeClient
