import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

export interface AppConfig {
  host: string
  port: number
  databasePath: string
  providerConfigPath: string
  piAgentDir: string
  defaultAgent: string
  piCliPath: string
  piSessionDir: string
  piProvider: string
  piModel: string
  maxActiveAgentProcesses: number
  agentIdleTimeoutMs: number
  agentStartTimeoutMs: number
  agentRpcTimeoutMs: number
  logLevel: string
  defaultWorkspace: string
  compatibilityVersion: string
  serverUsername: string | null
  serverPassword: string | null
  opencodeClient: string | null
  xdgStateHome: string | null
  maxGlobalConcurrentSubtasks: number
  maxConcurrentSubtasksPerParent: number
  maxSubtaskDepth: number
  subtaskTimeoutMs: number
  subtaskAgentScope: "user" | "project" | "both"
  subtaskTerminateGracePeriodMs: number
  subtaskStderrLimitBytes: number
}

export interface ConfigFile {
  compatibilityVersion?: string
  defaultAgent?: string
  piCliPath?: string
  piSessionDir?: string
  piProvider?: string
  piModel?: string
  maxActiveAgentProcesses?: number
  agentIdleTimeoutMs?: number
  agentStartTimeoutMs?: number
  agentRpcTimeoutMs?: number
  host?: string
  port?: number
  logLevel?: string
  defaultWorkspace?: string
  maxGlobalConcurrentSubtasks?: number
  maxConcurrentSubtasksPerParent?: number
  maxSubtaskDepth?: number
  subtaskTimeoutMs?: number
  subtaskAgentScope?: "user" | "project" | "both"
  subtaskTerminateGracePeriodMs?: number
  subtaskStderrLimitBytes?: number
}

const ADAPTOR_VERSION = "0.1.0"
export const OPENCODE_COMPAT_VERSION = "1.18.7"
const DEFAULT_COMPAT_VERSION = OPENCODE_COMPAT_VERSION

export function getAdaptorVersion(): string {
  return ADAPTOR_VERSION
}

export function getDefaultCompatVersion(): string {
  return DEFAULT_COMPAT_VERSION
}

export function getConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME
  if (xdgConfig && xdgConfig.trim().length > 0) {
    return join(xdgConfig, "opencode-server-adaptor")
  }
  return join(homedir(), ".config", "opencode-server-adaptor")
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json")
}

export function getDefaultProviderConfigPath(): string {
  return join(getConfigDir(), "providers.yaml")
}

export function getStateDir(): string {
  const xdgState = process.env.XDG_STATE_HOME
  if (xdgState && xdgState.trim().length > 0) {
    return join(xdgState, "opencode-server-adaptor")
  }
  return join(homedir(), ".local", "state", "opencode-server-adaptor")
}

export function getDefaultDatabasePath(): string {
  return join(getStateDir(), "adaptor.db")
}

export function getPiAgentDir(databasePath: string): string {
  return databasePath === ":memory:" ? "" : join(dirname(resolve(databasePath)), "pi")
}

function quoteCommandArgument(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/**
 * Bun-installed Pi uses a Node shebang. Running its JS entry through Bun
 * avoids depending on a separately working `node` binary in minimal WSL
 * environments while retaining `pi` as the portable fallback.
 */
export function getDefaultPiCliPath(): string {
  const bun = join(homedir(), ".bun", "bin", "bun")
  const pi = join(homedir(), ".bun", "bin", "pi")
  if (existsSync(bun) && existsSync(pi)) {
    try {
      return `${quoteCommandArgument(bun)} ${quoteCommandArgument(realpathSync(pi))}`
    } catch {
      // Fall through to normal PATH lookup.
    }
  }
  return "pi"
}

export function readConfigFile(): ConfigFile {
  const path = getConfigPath()
  if (!existsSync(path)) {
    return {}
  }
  try {
    const raw = readFileSync(path, "utf-8")
    return JSON.parse(raw) as ConfigFile
  } catch {
    return {}
  }
}

export function writeConfigFile(config: ConfigFile): void {
  const dir = getConfigDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const path = getConfigPath()
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8")
}

export function resolveCompatibilityVersion(): string {
  const envVersion = process.env.OPENCODE_ADAPTOR_COMPAT_VERSION
  if (envVersion && envVersion.trim().length > 0) {
    return envVersion.trim()
  }

  const fileConfig = readConfigFile()
  if (fileConfig.compatibilityVersion) {
    return fileConfig.compatibilityVersion
  }

  return DEFAULT_COMPAT_VERSION
}

export function isSupportedVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version)
}

function subtaskAgentScope(value: unknown): "user" | "project" | "both" {
  return value === "user" || value === "project" || value === "both" ? value : "both"
}

export function loadConfig(): AppConfig {
  const fileConfig = readConfigFile()
  const stateDir = getStateDir()
  const databasePath = process.env.DATABASE_PATH ?? join(stateDir, "adaptor.db")
  const providerConfigPath =
    process.env.PROVIDER_CONFIG_PATH ?? (databasePath === ":memory:" ? "" : getDefaultProviderConfigPath())

  const serverPassword = process.env.OPENCODE_SERVER_PASSWORD?.trim() || null
  const serverUsername = process.env.OPENCODE_SERVER_USERNAME?.trim() || (serverPassword ? "opencode" : null)

  return {
    host: process.env.HOST ?? fileConfig.host ?? "127.0.0.1",
    port: parseInt(process.env.PORT ?? "", 10) || (fileConfig.port ?? 4096),
    databasePath,
    providerConfigPath,
    piAgentDir: getPiAgentDir(databasePath),
    defaultAgent: process.env.DEFAULT_AGENT ?? fileConfig.defaultAgent ?? "pi",
    // NOTE: PI_CLI_PATH is not a public configuration option. It is used only
    // by tests that spawn the server as a subprocess and need to override
    // the Pi executable path via environment variable. Do not rely on it in
    // production deployments; use config.json's piCliPath if an override is
    // truly needed.
    piCliPath: process.env.PI_CLI_PATH ?? fileConfig.piCliPath ?? getDefaultPiCliPath(),
    piSessionDir: process.env.PI_SESSION_DIR ?? fileConfig.piSessionDir ?? join(stateDir, "pi-sessions"),
    piProvider: process.env.PI_PROVIDER ?? fileConfig.piProvider ?? "",
    piModel: process.env.PI_MODEL ?? fileConfig.piModel ?? "",
    maxActiveAgentProcesses:
      parseInt(process.env.MAX_ACTIVE_AGENT_PROCESSES ?? "", 10) || (fileConfig.maxActiveAgentProcesses ?? 3),
    agentIdleTimeoutMs:
      parseInt(process.env.AGENT_IDLE_TIMEOUT_MS ?? "", 10) || (fileConfig.agentIdleTimeoutMs ?? 300_000),
    agentStartTimeoutMs:
      parseInt(process.env.AGENT_START_TIMEOUT_MS ?? "", 10) || (fileConfig.agentStartTimeoutMs ?? 30_000),
    agentRpcTimeoutMs:
      parseInt(process.env.AGENT_RPC_TIMEOUT_MS ?? "", 10) || (fileConfig.agentRpcTimeoutMs ?? 120_000),
    logLevel: process.env.LOG_LEVEL ?? fileConfig.logLevel ?? "INFO",
    defaultWorkspace: process.env.DEFAULT_WORKSPACE ?? fileConfig.defaultWorkspace ?? process.cwd(),
    compatibilityVersion: resolveCompatibilityVersion(),
    serverUsername,
    serverPassword,
    opencodeClient: process.env.OPENCODE_CLIENT ?? null,
    xdgStateHome: process.env.XDG_STATE_HOME ?? null,
    maxGlobalConcurrentSubtasks:
      parseInt(process.env.MAX_GLOBAL_CONCURRENT_SUBTASKS ?? "", 10) || (fileConfig.maxGlobalConcurrentSubtasks ?? 8),
    maxConcurrentSubtasksPerParent:
      parseInt(process.env.MAX_CONCURRENT_SUBTASKS_PER_PARENT ?? "", 10) ||
      (fileConfig.maxConcurrentSubtasksPerParent ?? 4),
    maxSubtaskDepth: parseInt(process.env.MAX_SUBTASK_DEPTH ?? "", 10) || (fileConfig.maxSubtaskDepth ?? 3),
    subtaskTimeoutMs: parseInt(process.env.SUBTASK_TIMEOUT_MS ?? "", 10) || (fileConfig.subtaskTimeoutMs ?? 120_000),
    subtaskAgentScope: subtaskAgentScope(process.env.SUBTASK_AGENT_SCOPE ?? fileConfig.subtaskAgentScope),
    subtaskTerminateGracePeriodMs:
      parseInt(process.env.SUBTASK_TERMINATE_GRACE_PERIOD_MS ?? "", 10) ||
      (fileConfig.subtaskTerminateGracePeriodMs ?? 5000),
    subtaskStderrLimitBytes:
      parseInt(process.env.SUBTASK_STDERR_LIMIT_BYTES ?? "", 10) || (fileConfig.subtaskStderrLimitBytes ?? 1024 * 1024),
  }
}
