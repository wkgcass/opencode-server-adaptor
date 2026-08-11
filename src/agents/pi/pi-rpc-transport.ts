import type { PiRpcCommand, PiRpcResponse, PiEvent, PiRpcMessage } from "./types.ts"
import { parseCommandLine, resolveCommandExecutable } from "./command-line.ts"

export type PiTransportListener = (message: PiRpcMessage) => void
export type PiTransportExitListener = (error: Error, code: number | null) => void
const NESTED_PI_INTERACTION_PREFIX = "__OPENCODE_ADAPTOR_PI_INTERACTION__ "
const MAX_EVENT_BACKLOG = 1000

interface TransportLogger {
  debug: (msg: string, fields?: Record<string, unknown>) => void
  info: (msg: string, fields?: Record<string, unknown>) => void
  warn: (msg: string, fields?: Record<string, unknown>) => void
  error: (msg: string, fields?: Record<string, unknown>) => void
  interaction?: (
    channel: "opencode" | "pi",
    direction: "in" | "out",
    metadata: Record<string, unknown>,
    payload: unknown,
    options?: { omitPayload?: boolean },
  ) => void
  isVerbose?: () => boolean
}

export interface PiTransportOptions {
  cliPath: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  rpcTimeoutMs: number
  startTimeoutMs: number
  maxStdoutBytes?: number
  logger: TransportLogger
}

interface PendingRequest {
  resolve: (response: PiRpcResponse) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export class PiRpcTransport {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private readonly listeners = new Set<PiTransportListener>()
  private readonly exitListeners = new Set<PiTransportExitListener>()
  private readonly eventBacklog: PiEvent[] = []
  private readonly pending = new Map<string, PendingRequest>()
  private readonly logger: TransportLogger
  private readonly options: PiTransportOptions
  private stdoutBuffer = ""
  private stderrBuffer = ""
  private closed = false
  private outputFailed = false
  private backlogFlushScheduled = false

  constructor(options: PiTransportOptions) {
    this.options = options
    this.logger = options.logger
  }

  async start(): Promise<void> {
    if (this.proc) {
      throw new Error("Transport already started")
    }

    const args = this.options.args ?? ["--mode", "rpc"]
    const cliParts = parseCommandLine(this.options.cliPath)
    cliParts[0] = resolveCommandExecutable(cliParts[0]!)
    const fullCmd = [...cliParts, ...args]
    this.logger.info("Starting Pi RPC subprocess", { cmd: fullCmd.join(" ") })

    let startTimer: ReturnType<typeof setTimeout> | undefined
    const startDeadline = new Promise<never>((_, reject) => {
      startTimer = setTimeout(() => {
        reject(new Error(`Pi subprocess start timed out after ${this.options.startTimeoutMs}ms`))
      }, this.options.startTimeoutMs)
    })

    const startProc = async (): Promise<void> => {
      this.proc = Bun.spawn({
        cmd: fullCmd,
        cwd: this.options.cwd ?? process.cwd(),
        env: { ...process.env, ...this.options.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })

      this.startReading()
      this.logger.info("Pi RPC subprocess started", { pid: this.proc.pid })
    }

    try {
      await Promise.race([startProc(), startDeadline])
    } finally {
      if (startTimer) clearTimeout(startTimer)
    }
  }

  private startReading(): void {
    if (!this.proc) return

    const stdout = this.proc.stdout
    const stderr = this.proc.stderr

    if (typeof stdout === "object" && stdout !== null && "getReader" in stdout) {
      const readStdout = async () => {
        const reader = (stdout as ReadableStream<Uint8Array>).getReader()
        const decoder = new TextDecoder()

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            this.stdoutBuffer += decoder.decode(value, { stream: true })
            if (!this.processBuffer()) break
          }
        } catch (err) {
          if (!this.closed) {
            const message = err instanceof Error ? err.message : String(err)
            this.logger.error("Error reading Pi stdout", { error: message })
            this.failOutput(`Pi stdout reader failed: ${message}`)
          }
        } finally {
          this.stdoutBuffer += decoder.decode()
          if (this.stdoutBuffer.trim()) {
            const line = this.stdoutBuffer.endsWith("\r") ? this.stdoutBuffer.slice(0, -1) : this.stdoutBuffer
            if (this.isOversizedLine(line)) {
              this.failOutput(`Pi RPC record exceeded ${this.options.maxStdoutBytes ?? 100 * 1024 * 1024} bytes`)
            } else {
              this.parseLine(line)
            }
            this.stdoutBuffer = ""
          }
        }
      }
      void readStdout()
    }

    if (typeof stderr === "object" && stderr !== null && "getReader" in stderr) {
      const readStderr = async () => {
        const reader = (stderr as ReadableStream<Uint8Array>).getReader()
        const decoder = new TextDecoder()

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            this.stderrBuffer += decoder.decode(value, { stream: true })
            this.flushStderr()
          }
        } catch {
          // ignore stderr read errors
        } finally {
          this.flushStderr(true)
        }
      }
      void readStderr()
    }

    this.proc.exited.then((code: number | null) => {
      this.logger.info("Pi RPC subprocess exited", { code })
      this.handleProcessExit(code)
    })
  }

  private flushStderr(force = false): void {
    if (!this.stderrBuffer) return

    const lines = this.stderrBuffer.split(/\r?\n/)
    this.stderrBuffer = force ? "" : (lines.pop() ?? "")
    if (force && lines.at(-1) === "") lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      if (line.startsWith(NESTED_PI_INTERACTION_PREFIX)) {
        try {
          const nested = JSON.parse(line.slice(NESTED_PI_INTERACTION_PREFIX.length)) as {
            direction?: "in" | "out"
            stream?: string
            metadata?: Record<string, unknown>
            payload?: unknown
          }
          this.logger.interaction?.(
            "pi",
            nested.direction === "out" ? "out" : "in",
            { nested: true, stream: nested.stream ?? "unknown", ...nested.metadata },
            nested.payload,
          )
          continue
        } catch {
          // Preserve malformed bridge records as normal Pi stderr below.
        }
      }
      if (this.logger.isVerbose?.()) {
        this.logger.interaction?.("pi", "in", { stream: "stderr" }, line)
      } else {
        this.logger.warn("Pi stderr", { line })
      }
    }
  }

  private processBuffer(): boolean {
    const lines = this.stdoutBuffer.split(/\r?\n/)
    this.stdoutBuffer = lines.pop() ?? ""

    for (const line of lines) {
      if (!line.trim()) continue
      if (this.isOversizedLine(line)) {
        this.failOutput(`Pi RPC record exceeded ${this.options.maxStdoutBytes ?? 100 * 1024 * 1024} bytes`)
        return false
      }
      this.parseLine(line)
    }
    if (this.isOversizedLine(this.stdoutBuffer)) {
      this.failOutput(`Incomplete Pi RPC record exceeded ${this.options.maxStdoutBytes ?? 100 * 1024 * 1024} bytes`)
      return false
    }
    return true
  }

  private isOversizedLine(line: string): boolean {
    const maxBytes = this.options.maxStdoutBytes ?? 100 * 1024 * 1024
    return Buffer.byteLength(line, "utf8") > maxBytes
  }

  private failOutput(message: string): void {
    if (this.outputFailed || this.closed) return
    this.outputFailed = true
    this.logger.error(message)
    try {
      this.proc?.kill("SIGTERM")
    } catch {}
  }

  private parseLine(line: string): void {
    let message: PiRpcMessage
    try {
      message = JSON.parse(line) as PiRpcMessage
    } catch {
      this.logger.interaction?.("pi", "in", { stream: "stdout", invalid: true }, line)
      this.logger.warn("Invalid JSON from Pi", { line })
      return
    }

    const responseCommand =
      message.type === "response" && typeof (message as PiRpcResponse).command === "string"
        ? (message as PiRpcResponse).command
        : undefined
    this.logger.interaction?.(
      "pi",
      "in",
      {
        stream: "stdout",
        type: message.type,
        ...(responseCommand ? { command: responseCommand } : {}),
      },
      message,
      { omitPayload: responseCommand === "get_entries" },
    )

    if (message.type === "response") {
      const response = message as PiRpcResponse
      const id = response.id
      if (id) {
        const pending = this.pending.get(id)
        if (pending) {
          if (pending.timer) clearTimeout(pending.timer)
          this.pending.delete(id)
          if (response.success) {
            pending.resolve(response)
          } else {
            pending.reject(
              new Error(`Pi RPC command '${response.command}' failed: ${response.error ?? "unknown error"}`),
            )
          }
        } else {
          this.logger.debug("Received response with unknown id", { id })
        }
      }
    } else {
      const event = message as PiEvent
      if (this.listeners.size === 0 || this.eventBacklog.length > 0 || this.backlogFlushScheduled) {
        this.bufferEvent(event)
      } else {
        this.dispatchEvent(event)
      }
    }
  }

  private bufferEvent(event: PiEvent): void {
    if (this.eventBacklog.length >= MAX_EVENT_BACKLOG) {
      const dropped = this.eventBacklog.shift()
      if (dropped) this.warnDroppedEvent(dropped, "Pi transport event backlog exceeded its safety limit")
    }
    this.eventBacklog.push(event)
    this.scheduleBacklogFlush()
  }

  private scheduleBacklogFlush(): void {
    if (this.backlogFlushScheduled || this.listeners.size === 0 || this.eventBacklog.length === 0) return
    this.backlogFlushScheduled = true
    queueMicrotask(() => {
      this.backlogFlushScheduled = false
      if (this.listeners.size === 0) return
      const backlog = this.eventBacklog.splice(0)
      for (const event of backlog) this.dispatchEvent(event)
      if (this.eventBacklog.length > 0) this.scheduleBacklogFlush()
    })
  }

  private dispatchEvent(event: PiEvent): void {
    let delivered = 0
    let firstError: unknown
    for (const listener of this.listeners) {
      try {
        listener(event)
        delivered++
      } catch (err) {
        firstError ??= err
      }
    }
    if (delivered === 0) {
      this.warnDroppedEvent(
        event,
        `All ${this.listeners.size} Pi transport event listener(s) threw: ${
          firstError instanceof Error ? firstError.message : String(firstError)
        }`,
      )
    }
  }

  private warnDroppedEvent(event: PiEvent, reason: string): void {
    this.logger.warn("Pi event produced no OpenCode event", {
      piEvent: event.type,
      stage: "transport_delivery",
      reason,
    })
  }

  private dropEventBacklog(reason: string): void {
    for (const event of this.eventBacklog.splice(0)) this.warnDroppedEvent(event, reason)
  }

  private write(command: PiRpcCommand): void | Promise<void> {
    if (!this.proc || this.closed) {
      throw new Error("Transport not started")
    }

    const stdin = this.proc.stdin
    if (!stdin || typeof stdin === "number") {
      throw new Error("stdin not writable")
    }

    const data = JSON.stringify(command) + "\n"
    this.logger.interaction?.("pi", "out", { stream: "stdin", type: command.type }, command)
    const sink = stdin as {
      write: (data: string) => number | Promise<number>
      flush?: () => number | Promise<number>
    }
    const writeResult = sink.write(data)
    const flushResult = sink.flush?.()
    if (writeResult instanceof Promise || flushResult instanceof Promise) {
      return Promise.all([Promise.resolve(writeResult), Promise.resolve(flushResult)]).then(() => undefined)
    }
  }

  async send(command: PiRpcCommand, options?: { timeoutMs?: number | null }): Promise<PiRpcResponse> {
    const id = command.id ?? `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
    const cmdWithId = { ...command, id }
    const timeoutMs = options?.timeoutMs === undefined ? this.options.rpcTimeoutMs : options.timeoutMs

    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`RPC command '${command.type}' timed out after ${timeoutMs}ms`))
            }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })

      try {
        const writeResult = this.write(cmdWithId)
        if (writeResult instanceof Promise) {
          writeResult.then(
            () => this.logger.debug("Sent RPC command", { id, type: command.type }),
            (err: unknown) => {
              if (timer) clearTimeout(timer)
              this.pending.delete(id)
              reject(new Error(`Failed to write to Pi stdin: ${err instanceof Error ? err.message : String(err)}`))
            },
          )
        } else {
          this.logger.debug("Sent RPC command", { id, type: command.type })
        }
      } catch (err) {
        if (timer) clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async notify(command: PiRpcCommand): Promise<void> {
    await this.write(command)
    this.logger.debug("Sent RPC notification", { type: command.type })
  }

  subscribe(listener: PiTransportListener): () => void {
    this.listeners.add(listener)
    this.scheduleBacklogFlush()
    return () => this.listeners.delete(listener)
  }

  subscribeExit(listener: PiTransportExitListener): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  private handleProcessExit(code: number | null): void {
    if (this.closed) return

    this.closed = true
    this.proc = null
    const error = new Error(`Pi subprocess exited with code ${code}`)
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()

    for (const listener of this.exitListeners) {
      try {
        listener(error, code)
      } catch {}
    }
    this.dropEventBacklog("Pi transport exited before an event subscriber accepted the buffered event")
    this.listeners.clear()
    this.exitListeners.clear()
  }

  async stop(): Promise<void> {
    if (this.closed) return
    this.closed = true

    if (!this.proc) {
      for (const [, pending] of this.pending) {
        if (pending.timer) clearTimeout(pending.timer)
        pending.reject(new Error("Transport closed"))
      }
      this.pending.clear()
      this.dropEventBacklog("Pi transport stopped before an event subscriber accepted the buffered event")
      this.listeners.clear()
      this.exitListeners.clear()
      return
    }

    try {
      const stdin = this.proc.stdin
      if (stdin && typeof stdin !== "number") {
        try {
          ;(stdin as { end: () => void }).end()
        } catch {}
      }
    } catch {}

    try {
      await Promise.race([this.proc.exited, new Promise<void>((resolve) => setTimeout(() => resolve(), 3000))])
    } catch {}

    try {
      this.proc.kill("SIGTERM")
    } catch {}

    try {
      await Promise.race([this.proc.exited, new Promise<void>((resolve) => setTimeout(() => resolve(), 1000))])
    } catch {}

    try {
      this.proc.kill("SIGKILL")
    } catch {}

    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new Error("Transport closed"))
    }
    this.pending.clear()
    this.dropEventBacklog("Pi transport stopped before an event subscriber accepted the buffered event")
    this.listeners.clear()
    this.exitListeners.clear()

    this.logger.info("Pi RPC transport stopped")
  }

  get isClosed(): boolean {
    return this.closed
  }
}
