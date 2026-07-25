import { describe, expect, test } from "bun:test"
import type {
  AgentAdapter,
  AgentRuntime,
  AgentRuntimeContext,
  AgentRuntimeEvent,
  PermissionResponse,
  PromptInput,
} from "../../src/agents/agent-adapter.ts"
import { Logger } from "../../src/logging/index.ts"
import { RuntimePool } from "../../src/runtime/runtime-pool.ts"

const logger = new Logger({ minLevel: "ERROR" })

describe("RuntimePool lifecycle", () => {
  test("subscribes before start and keeps event ownership with each Runtime generation", async () => {
    const adapter = new FakeAdapter()
    const events: string[] = []
    const pool = new RuntimePool(adapter, logger, {
      maxActive: 1,
      idleTimeoutMs: 15,
      startTimeoutMs: 1000,
      onEvent: (_sessionId, _runtime, event) => events.push(event.type),
    })
    const context = createContext("session-a")

    try {
      const first = (await pool.getOrCreate(context)) as FakeRuntime
      expect(events).toEqual(["session_started"])
      first.emitMessage("message-1")
      pool.scheduleIdleCheck(context.sessionId)
      await waitUntil(() => pool.size === 0)

      const second = (await pool.getOrCreate(context)) as FakeRuntime
      second.emitMessage("message-2")

      expect(second).not.toBe(first)
      expect(first.stopped).toBe(true)
      expect(events).toEqual(["session_started", "message_completed", "session_started", "message_completed"])
    } finally {
      await pool.closeAll()
    }
  })

  test("capacity eviction does not leave a stale subscription for a recreated session", async () => {
    const adapter = new FakeAdapter()
    const observed: string[] = []
    const pool = new RuntimePool(adapter, logger, {
      maxActive: 1,
      idleTimeoutMs: 1000,
      startTimeoutMs: 1000,
      onEvent: (sessionId, _runtime, event) => {
        if (event.type === "message_completed") observed.push(`${sessionId}:${event.messageId}`)
      },
    })

    try {
      const firstA = (await pool.getOrCreate(createContext("session-a"))) as FakeRuntime
      pool.scheduleIdleCheck("session-a")
      await pool.getOrCreate(createContext("session-b"))
      pool.scheduleIdleCheck("session-b")
      const secondA = (await pool.getOrCreate(createContext("session-a"))) as FakeRuntime
      secondA.emitMessage("after-eviction")

      expect(firstA.stopped).toBe(true)
      expect(secondA).not.toBe(firstA)
      expect(observed).toEqual(["session-a:after-eviction"])
    } finally {
      await pool.closeAll()
    }
  })

  test("invalidates a Runtime when event projection throws and allows a clean recreation", async () => {
    const adapter = new FakeAdapter()
    const projectionErrors: string[] = []
    let failProjection = true
    const pool = new RuntimePool(adapter, logger, {
      maxActive: 1,
      idleTimeoutMs: 1000,
      startTimeoutMs: 1000,
      onEvent: (_sessionId, _runtime, event) => {
        if (event.type === "message_completed" && failProjection) throw new Error("database write failed")
      },
      onEventError: (_sessionId, _runtime, _event, error) => {
        projectionErrors.push(error instanceof Error ? error.message : String(error))
        throw new Error("projection recovery also failed")
      },
    })

    try {
      const first = (await pool.getOrCreate(createContext("session-a"))) as FakeRuntime
      first.emitMessage("broken")
      await waitUntil(() => pool.size === 0)

      failProjection = false
      const second = (await pool.getOrCreate(createContext("session-a"))) as FakeRuntime
      second.emitMessage("healthy")

      expect(first.stopped).toBe(true)
      expect(second).not.toBe(first)
      expect(projectionErrors).toEqual(["database write failed"])
    } finally {
      await pool.closeAll()
    }
  })

  test("logs an event projection failure once as an orange WARN", async () => {
    let output = ""
    const warningLogger = new Logger({
      minLevel: "WARN",
      printLogs: true,
      stream: { write: (data) => void (output += data) },
    })
    const adapter = new FakeAdapter()
    const pool = new RuntimePool(adapter, warningLogger, {
      maxActive: 1,
      idleTimeoutMs: 1000,
      startTimeoutMs: 1000,
      onEvent: (_sessionId, _runtime, event) => {
        if (event.type === "message_completed") throw new Error("database write failed")
      },
    })

    try {
      const runtime = (await pool.getOrCreate(createContext("session-warning"))) as FakeRuntime
      runtime.emitMessage("broken")
      await waitUntil(() => pool.size === 0)

      expect(output).toContain("\u001b[38;5;208m[WARN]")
      expect(output).toContain("Agent event produced no OpenCode event")
      expect(output).toContain("stage=opencode_projection")
      expect(output.match(/database write failed/g)).toHaveLength(1)
    } finally {
      await pool.closeAll()
    }
  })

  test("fails Runtime creation when a startup event cannot be projected", async () => {
    const adapter = new FakeAdapter()
    const pool = new RuntimePool(adapter, logger, {
      maxActive: 1,
      idleTimeoutMs: 1000,
      startTimeoutMs: 1000,
      onEvent: () => {
        throw new Error("startup projection failed")
      },
    })

    try {
      await expect(pool.getOrCreate(createContext("session-a"))).rejects.toThrow("startup projection failed")
      expect(pool.size).toBe(0)
      expect(adapter.runtimes).toHaveLength(1)
      expect(adapter.runtimes[0]?.stopped).toBe(true)
    } finally {
      await pool.closeAll()
    }
  })
})

class FakeAdapter implements AgentAdapter {
  readonly id = "fake"
  readonly displayName = "Fake"
  readonly runtimes: FakeRuntime[] = []

  async validateConfig(input: unknown) {
    return (input ?? {}) as Record<string, unknown>
  }

  async createRuntime(context: AgentRuntimeContext): Promise<AgentRuntime> {
    const runtime = new FakeRuntime(context.sessionId)
    this.runtimes.push(runtime)
    return runtime
  }
}

class FakeRuntime implements AgentRuntime {
  private readonly listeners = new Set<(event: AgentRuntimeEvent) => void>()
  stopped = false

  constructor(private readonly sessionId: string) {}

  async start(): Promise<void> {
    this.emit({ type: "session_started", sessionId: this.sessionId })
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  async prompt(_input: PromptInput): Promise<void> {}
  async abort(): Promise<void> {}
  async respondToPermission(_requestId: string, _response: PermissionResponse): Promise<void> {}

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emitMessage(messageId: string): void {
    this.emit({ type: "message_completed", sessionId: this.sessionId, messageId })
  }

  private emit(event: AgentRuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function createContext(sessionId: string): AgentRuntimeContext {
  return {
    sessionId,
    directory: process.cwd(),
    logger,
    config: {},
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for RuntimePool state")
    await Bun.sleep(5)
  }
}
