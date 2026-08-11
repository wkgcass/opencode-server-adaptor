import { inspect } from "node:util"
import { optimizeInteractionPayload } from "./interaction-payload.ts"

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"
export type InteractionChannel = string
export type InteractionDirection = "in" | "out"

export interface InteractionLogOptions {
  omitPayload?: boolean
  mutedPayload?: boolean
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
}

export interface LogEntry {
  level: LogLevel
  message: string
  timestamp: string
  [key: string]: unknown
}

const ANSI = {
  reset: "\u001b[0m",
  white: "\u001b[97m",
  gray: "\u001b[90m",
  blue: "\u001b[94m",
  magenta: "\u001b[95m",
  orange: "\u001b[38;5;208m",
  red: "\u001b[91m",
} as const

function humanValue(value: unknown, compact: boolean): string {
  if (typeof value === "string") return value
  return inspect(value, {
    colors: false,
    depth: null,
    compact,
    breakLength: compact ? Infinity : 100,
    maxArrayLength: null,
    maxStringLength: null,
    sorted: false,
  })
}

function humanFields(fields?: Record<string, unknown>): string {
  if (!fields || Object.keys(fields).length === 0) return ""
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${humanValue(value, true)}`)
    .join(" ")
}

function jsonPayload(value: unknown): string {
  const seen = new WeakSet<object>()
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return item.toString()
    if (item instanceof Error) {
      return { name: item.name, message: item.message, stack: item.stack }
    }
    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return "[Circular]"
      seen.add(item)
    }
    return item
  })
  return serialized ?? JSON.stringify(String(value))
}

export class Logger {
  private minLevel: LogLevel
  private printLogs: boolean
  private verbose: boolean
  private readonly stream: { write: (data: string) => void }

  constructor(options?: {
    minLevel?: LogLevel
    printLogs?: boolean
    verbose?: boolean
    stream?: { write: (data: string) => void }
  }) {
    this.minLevel = options?.minLevel ?? "INFO"
    this.printLogs = options?.printLogs ?? false
    this.verbose = options?.verbose ?? false
    this.stream = options?.stream ?? process.stderr
  }

  configure(options: { minLevel?: LogLevel; printLogs?: boolean; verbose?: boolean }): void {
    if (options.minLevel !== undefined) this.minLevel = options.minLevel
    if (options.printLogs !== undefined) this.printLogs = options.printLogs
    if (options.verbose !== undefined) this.verbose = options.verbose
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel]
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (!this.printLogs) return
    if (!this.shouldLog(level)) return
    const levelColor =
      level === "ERROR" ? ANSI.red : level === "WARN" ? ANSI.orange : level === "DEBUG" ? ANSI.gray : ANSI.white
    const metadata = humanFields(fields)
    const suffix = metadata ? ` ${ANSI.gray}${metadata}${ANSI.reset}` : ""
    this.stream.write(
      `${ANSI.gray}${new Date().toISOString()}${ANSI.reset} ${levelColor}[${level}]${ANSI.reset} ${message}${suffix}\n`,
    )
  }

  /**
   * Emit a complete wire message when --verbose is active. The colored first
   * line is deliberately compact metadata; the untruncated payload is emitted
   * as compact JSON on a separate line so terminal output stays easy to scan
   * and copy. Callers may mute repetitive payloads without hiding them.
   */
  interaction(
    channel: InteractionChannel,
    direction: InteractionDirection,
    metadata: Record<string, unknown>,
    payload: unknown,
    options?: InteractionLogOptions,
  ): void {
    if (!this.printLogs || !this.verbose) return
    const isAgentChannel = channel !== "opencode"
    const color = isAgentChannel ? ANSI.magenta : ANSI.blue
    const label = isAgentChannel
      ? channel.charAt(0).toUpperCase() + channel.slice(1)
      : direction === "in"
        ? "OpenCode Request"
        : "OpenCode Response"
    const arrow = direction === "in" ? "→" : "←"
    const payloadLabel = isAgentChannel ? "Payload" : direction === "in" ? "Request Payload" : "Response Payload"
    const details = humanFields(metadata)
    const header = details ? ` ${details}` : ""
    const optimizedPayload = optimizeInteractionPayload(channel, metadata, payload)
    const metadataLine = `${color}${new Date().toISOString()} [${label} ${arrow}]${header}${ANSI.reset}\n`
    const payloadColor = options?.mutedPayload ? ANSI.gray : ANSI.white
    const payloadLine = options?.omitPayload
      ? ""
      : `${payloadColor}${payloadLabel}: ${jsonPayload(optimizedPayload)}${ANSI.reset}\n`
    this.stream.write(metadataLine + payloadLine)
  }

  isVerbose(): boolean {
    return this.printLogs && this.verbose
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("DEBUG", message, fields)
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("INFO", message, fields)
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("WARN", message, fields)
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("ERROR", message, fields)
  }

  child(fields: Record<string, unknown>): ChildLogger {
    return new ChildLogger(this, fields)
  }
}

export class ChildLogger {
  constructor(
    private readonly parent: Logger,
    private readonly fields: Record<string, unknown>,
  ) {}

  debug(message: string, fields?: Record<string, unknown>): void {
    this.parent.debug(message, { ...this.fields, ...fields })
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.parent.info(message, { ...this.fields, ...fields })
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.parent.warn(message, { ...this.fields, ...fields })
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.parent.error(message, { ...this.fields, ...fields })
  }

  interaction(
    channel: InteractionChannel,
    direction: InteractionDirection,
    metadata: Record<string, unknown>,
    payload: unknown,
    options?: InteractionLogOptions,
  ): void {
    this.parent.interaction(channel, direction, { ...this.fields, ...metadata }, payload, options)
  }

  isVerbose(): boolean {
    return this.parent.isVerbose()
  }

  child(fields: Record<string, unknown>): ChildLogger {
    return new ChildLogger(this.parent, { ...this.fields, ...fields })
  }
}

let globalLogger: Logger | null = null

export function getLogger(): Logger {
  if (!globalLogger) {
    globalLogger = new Logger()
  }
  return globalLogger
}

export function setLogger(logger: Logger): void {
  globalLogger = logger
}

export function parseLogLevel(value: string | undefined): LogLevel | null {
  if (!value) return null
  const upper = value.toUpperCase()
  if (upper === "DEBUG" || upper === "INFO" || upper === "WARN" || upper === "ERROR") {
    return upper
  }
  return null
}
