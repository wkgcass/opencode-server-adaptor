// Vendored from @earendil-works/pi-coding-agent
// Source: packages/coding-agent/src/config.ts (extracted functions)
// Commit: 7df73a00c6cf85c000bf1ce1594c9284067a92f0
// License: MIT

import { join } from "node:path"
import { homedir } from "node:os"

// Hardcoded to match upstream default (pkg.piConfig?.configDir || ".pi")
export const CONFIG_DIR_NAME = ".pi"

// PI_CODING_AGENT_DIR env var name (upstream: `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`)
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR"

function expandTildePath(p: string): string {
	if (p.startsWith("~/") || p === "~") {
		return join(homedir(), p.slice(1))
	}
	return p
}

/** Get the agent config directory (e.g., ~/.pi/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR]
	if (envDir) {
		return expandTildePath(envDir)
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent")
}
