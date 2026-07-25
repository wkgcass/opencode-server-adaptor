import type { IPty, IDisposable } from "bun-pty"
import type { EventBus } from "../event/index.ts"
import { createEvent } from "../event/index.ts"
import type { Logger } from "../logging/index.ts"

const BUFFER_LIMIT = 2 * 1024 * 1024
const REPLAY_CHUNK = 64 * 1024

/** Idle PTYs (no connected WebSocket subscriber) are reaped after this long. */
const IDLE_TIMEOUT_MS = 15 * 60_000

export interface PtyInfo {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status: "running" | "exited"
  pid: number
  exitCode?: number
}

export interface PtySocketData {
  ptyID: string
  cursor?: number
}

interface Subscriber {
  socket: Bun.ServerWebSocket<PtySocketData>
  active: boolean
  pending: string[]
}

interface PtySession {
  info: PtyInfo
  directory: string
  process: IPty
  buffer: string
  bufferCursor: number
  cursor: number
  subscribers: Set<Subscriber>
  listeners: IDisposable[]
  /** Pending idle-reap timer; set while there is no subscriber, cleared on connect. */
  idleTimer: ReturnType<typeof setTimeout> | null
}

export class PtyManager {
  private readonly sessions = new Map<string, PtySession>()
  private readonly tickets = new Map<string, { ptyID: string; directory: string; expires: number }>()

  constructor(
    private readonly events: EventBus,
    private readonly logger: Logger,
    private readonly disablePtyTokenCheck = false,
    private readonly idleTimeoutMs = IDLE_TIMEOUT_MS,
  ) {}

  list(directory: string): PtyInfo[] {
    return [...this.sessions.values()]
      .filter((session) => session.directory === directory)
      .map((session) => session.info)
  }

  get(id: string, directory?: string): PtyInfo | undefined {
    const session = this.sessions.get(id)
    return session && (directory === undefined || session.directory === directory) ? session.info : undefined
  }

  async create(input: {
    command?: string
    args?: string[]
    directory: string
    cwd: string
    title?: string
    env?: Record<string, string>
  }): Promise<PtyInfo> {
    const id = `pty_${crypto.randomUUID().replaceAll("-", "")}`
    const command = input.command?.trim() || (process.platform === "win32" ? "powershell.exe" : "bash")
    const args = input.args ?? []
    const { spawn } = await import("bun-pty")
    const processHandle = spawn(command, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env,
        TERM: "xterm-256color",
        OPENCODE_TERMINAL: "1",
      } as Record<string, string>,
    })
    const info: PtyInfo = {
      id,
      title: input.title?.trim() || `Terminal ${id.slice(-4)}`,
      command,
      args,
      cwd: input.cwd,
      status: "running",
      pid: processHandle.pid,
    }
    const session: PtySession = {
      info,
      directory: input.directory,
      process: processHandle,
      buffer: "",
      bufferCursor: 0,
      cursor: 0,
      subscribers: new Set(),
      listeners: [],
      idleTimer: null,
    }
    this.sessions.set(id, session)
    session.listeners.push(
      processHandle.onData((chunk) => this.onData(session, chunk)),
      processHandle.onExit(({ exitCode }) => this.onExit(session, exitCode)),
    )
    this.events.publish(createEvent("pty.created", { info }), session.directory)
    this.scheduleIdle(session)
    return info
  }

  update(id: string, input: { title?: string; size?: { cols?: number; rows?: number } }): PtyInfo | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    if (typeof input.title === "string" && input.title.trim()) session.info.title = input.title.trim()
    const cols = input.size?.cols
    const rows = input.size?.rows
    if (
      session.info.status === "running" &&
      Number.isSafeInteger(cols) &&
      Number.isSafeInteger(rows) &&
      cols! > 0 &&
      rows! > 0
    ) {
      session.process.resize(cols!, rows!)
    }
    this.events.publish(createEvent("pty.updated", { info: session.info }), session.directory)
    return session.info
  }

  remove(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    this.cancelIdle(session)
    this.sessions.delete(id)
    for (const listener of session.listeners) listener.dispose()
    if (session.info.status === "running") {
      try {
        session.process.kill()
      } catch {}
    }
    for (const subscriber of session.subscribers) subscriber.socket.close(1000)
    session.subscribers.clear()
    this.events.publish(createEvent("pty.deleted", { id }), session.directory)
    return true
  }

  issueTicket(ptyID: string, directory: string): { ticket: string; expires_in: number } | undefined {
    const session = this.sessions.get(ptyID)
    if (!session || session.directory !== directory) return undefined
    const ticket = crypto.randomUUID()
    const expiresIn = 30
    this.tickets.set(ticket, { ptyID, directory, expires: Date.now() + expiresIn * 1000 })
    return { ticket, expires_in: expiresIn }
  }

  tryUpgrade(
    request: Request,
    server: Pick<Bun.Server<PtySocketData>, "upgrade">,
    directory: string,
  ): Response | undefined {
    const url = new URL(request.url)
    const match = request.method === "GET" ? url.pathname.match(/^\/api\/pty\/([^/]+)\/connect$/) : undefined
    if (!match) return undefined
    const ptyID = decodeURIComponent(match[1]!)
    const session = this.sessions.get(ptyID)
    if (!session || session.directory !== directory) return new Response(null, { status: 404 })
    if (!this.disablePtyTokenCheck) {
      const ticket = url.searchParams.get("ticket")
      const issued = ticket ? this.tickets.get(ticket) : undefined
      if (ticket) this.tickets.delete(ticket)
      if (!issued || issued.ptyID !== ptyID || issued.directory !== directory || issued.expires <= Date.now()) {
        return new Response(null, { status: 403 })
      }
    }
    if (session.info.status !== "running") return new Response(null, { status: 409 })
    const rawCursor = url.searchParams.get("cursor")
    const parsedCursor = rawCursor === null ? undefined : Number(rawCursor)
    const cursor =
      parsedCursor !== undefined && Number.isSafeInteger(parsedCursor) && parsedCursor >= -1 ? parsedCursor : undefined
    return server.upgrade(request, { data: { ptyID, cursor } })
      ? undefined
      : new Response("WebSocket upgrade required", { status: 426 })
  }

  open(socket: Bun.ServerWebSocket<PtySocketData>): void {
    const session = this.sessions.get(socket.data.ptyID)
    if (!session || session.info.status !== "running") {
      socket.close(4404, "session not found or exited")
      return
    }
    const subscriber: Subscriber = { socket, active: false, pending: [] }
    session.subscribers.add(subscriber)
    this.cancelIdle(session)
    const end = session.cursor
    const from =
      socket.data.cursor === -1
        ? end
        : typeof socket.data.cursor === "number" && Number.isSafeInteger(socket.data.cursor)
          ? Math.max(0, socket.data.cursor)
          : 0
    const offset = Math.max(0, from - session.bufferCursor)
    const replay = offset < session.buffer.length ? session.buffer.slice(offset) : ""
    for (let i = 0; i < replay.length; i += REPLAY_CHUNK) socket.send(replay.slice(i, i + REPLAY_CHUNK))
    socket.send(metaFrame(end))
    subscriber.active = true
    for (const chunk of subscriber.pending) socket.send(chunk)
    subscriber.pending.length = 0
    this.logger.debug("PTY client connected", { id: session.info.id, cursor: end })
  }

  message(socket: Bun.ServerWebSocket<PtySocketData>, message: string | Buffer): void {
    const session = this.sessions.get(socket.data.ptyID)
    if (!session || session.info.status !== "running") return
    const text = typeof message === "string" ? message : message.toString("utf8")
    session.process.write(text)
  }

  closeSocket(socket: Bun.ServerWebSocket<PtySocketData>): void {
    const session = this.sessions.get(socket.data.ptyID)
    if (!session) return
    for (const subscriber of session.subscribers) {
      if (subscriber.socket === socket) session.subscribers.delete(subscriber)
    }
    if (session.subscribers.size === 0 && session.info.status === "running") {
      this.scheduleIdle(session)
    }
  }

  close(): void {
    for (const id of [...this.sessions.keys()]) this.remove(id)
    this.tickets.clear()
  }

  /**
   * Arms (or re-arms) the idle-reap timer for a session with no subscriber.
   * Running shells and already-exited sessions are both reaped after the
   * timeout; the latter clears the lingering session record once Desktop has
   * had plenty of time to observe the exit.
   */
  private scheduleIdle(session: PtySession): void {
    if (this.idleTimeoutMs <= 0) return
    this.cancelIdle(session)
    const id = session.info.id
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      const reason = session.info.status === "running" ? "no client has consumed it" : "it exited and was not removed"
      this.logger.warn(
        `Reaping idle PTY: ${reason} for ${Math.round(this.idleTimeoutMs / 60_000)} min`,
        { id, status: session.info.status },
      )
      this.remove(id)
    }, this.idleTimeoutMs)
    session.idleTimer.unref?.()
  }

  private cancelIdle(session: PtySession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
  }

  private onData(session: PtySession, chunk: string): void {
    session.cursor += chunk.length
    for (const subscriber of session.subscribers) {
      try {
        if (subscriber.active) subscriber.socket.send(chunk)
        else subscriber.pending.push(chunk)
      } catch {
        session.subscribers.delete(subscriber)
      }
    }
    session.buffer += chunk
    if (session.buffer.length > BUFFER_LIMIT) {
      const excess = session.buffer.length - BUFFER_LIMIT
      session.buffer = session.buffer.slice(excess)
      session.bufferCursor += excess
    }
  }

  private onExit(session: PtySession, exitCode: number): void {
    if (session.info.status === "exited") return
    session.info.status = "exited"
    session.info.exitCode = Math.max(0, exitCode)
    for (const subscriber of session.subscribers) subscriber.socket.close(1000)
    session.subscribers.clear()
    this.events.publish(
      createEvent("pty.exited", { id: session.info.id, exitCode: session.info.exitCode }),
      session.directory,
    )
    this.scheduleIdle(session)
  }
}

function metaFrame(cursor: number): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify({ cursor }))
  const frame = new Uint8Array(encoded.length + 1)
  frame[0] = 0
  frame.set(encoded, 1)
  return frame
}
