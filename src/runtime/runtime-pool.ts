import type { AgentRuntime, AgentRuntimeContext, AgentAdapter, AgentRuntimeEvent } from "../agents/agent-adapter.ts"
import type { Logger } from "../logging/index.ts"
import { SessionQueue } from "./session-queue.ts"

interface PooledRuntime {
  runtime: AgentRuntime
  sessionId: string
  lastActive: number
  timer: ReturnType<typeof setTimeout> | null
  unsubscribe: () => void
  acceptEvents: boolean
  eventProjectionError?: unknown
}

export interface RuntimePoolOptions {
  maxActive: number
  idleTimeoutMs: number
  startTimeoutMs: number
  onEvent?: (sessionId: string, runtime: AgentRuntime, event: AgentRuntimeEvent) => void
  onEventError?: (sessionId: string, runtime: AgentRuntime, event: AgentRuntimeEvent, error: unknown) => void
}

export class RuntimePool {
  private pools = new Map<string, PooledRuntime>()
  private readonly queue = new SessionQueue()
  private readonly logger: Logger
  private readonly adapter: AgentAdapter
  private readonly options: RuntimePoolOptions
  private closed = false

  constructor(adapter: AgentAdapter, logger: Logger, options: RuntimePoolOptions) {
    this.adapter = adapter
    this.logger = logger
    this.options = options
  }

  async getOrCreate(context: AgentRuntimeContext): Promise<AgentRuntime> {
    if (this.closed) {
      throw new Error("RuntimePool is closed")
    }

    return this.queue.run(context.sessionId, async () => {
      const existing = this.pools.get(context.sessionId)
      if (existing) {
        existing.lastActive = Date.now()
        if (existing.timer) {
          clearTimeout(existing.timer)
          existing.timer = null
        }
        return existing.runtime
      }

      if (this.pools.size >= this.options.maxActive) {
        const evicted = await this.evictOldestIdle()
        if (!evicted) {
          throw new Error(`Agent runtime capacity reached (${this.options.maxActive}); all runtimes are busy`)
        }
      }

      this.logger.info("Creating agent runtime", { sessionId: context.sessionId, adapter: this.adapter.id })

      const pooled = await this.createWithTimeout(context)
      this.pools.set(context.sessionId, pooled)

      return pooled.runtime
    })
  }

  private async createWithTimeout(context: AgentRuntimeContext): Promise<PooledRuntime> {
    const runtime = await this.adapter.createRuntime(context)
    const pooled: PooledRuntime = {
      runtime,
      sessionId: context.sessionId,
      lastActive: Date.now(),
      timer: null,
      unsubscribe: () => {},
      acceptEvents: true,
    }
    pooled.unsubscribe = runtime.subscribe((event) => {
      if (!pooled.acceptEvents) {
        this.logger.warn("Agent event produced no OpenCode event", {
          sessionId: context.sessionId,
          adapter: this.adapter.id,
          agentEvent: event.type,
          stage: "runtime_pool",
          reason: "Runtime generation no longer accepts events",
        })
        return
      }
      const current = this.pools.get(context.sessionId)
      if (current && current !== pooled) {
        this.logger.warn("Agent event produced no OpenCode event", {
          sessionId: context.sessionId,
          adapter: this.adapter.id,
          agentEvent: event.type,
          stage: "runtime_pool",
          reason: "Event belongs to a stale Runtime generation",
        })
        return
      }
      if (!this.options.onEvent) {
        this.logger.warn("Agent event produced no OpenCode event", {
          sessionId: context.sessionId,
          adapter: this.adapter.id,
          agentEvent: event.type,
          stage: "runtime_pool",
          reason: "RuntimePool has no OpenCode event projector",
        })
        return
      }
      try {
        this.options.onEvent(context.sessionId, runtime, event)
      } catch (error) {
        pooled.acceptEvents = false
        pooled.eventProjectionError = error
        this.logger.warn("Agent event produced no OpenCode event", {
          sessionId: context.sessionId,
          adapter: this.adapter.id,
          agentEvent: event.type,
          stage: "opencode_projection",
          reason: "OpenCode projection threw; invalidating this Runtime generation",
          error: error instanceof Error ? error.message : String(error),
        })
        try {
          this.options.onEventError?.(context.sessionId, runtime, event, error)
        } catch (recoveryError) {
          this.logger.error("Agent runtime event projection recovery failed", {
            sessionId: context.sessionId,
            adapter: this.adapter.id,
            type: event.type,
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          })
        }
        void this.invalidate(context.sessionId, runtime, "event_projection_error")
      }
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Agent runtime start timed out after ${this.options.startTimeoutMs}ms`))
      }, this.options.startTimeoutMs)
    })

    try {
      await Promise.race([runtime.start(), timeoutPromise])
      if (!pooled.acceptEvents) {
        throw pooled.eventProjectionError ?? new Error("Agent runtime event projection failed during startup")
      }
      return pooled
    } catch (error) {
      pooled.acceptEvents = false
      pooled.unsubscribe()
      await runtime.stop().catch(() => undefined)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async evictOldestIdle(): Promise<boolean> {
    let oldest: PooledRuntime | null = null
    for (const pooled of this.pools.values()) {
      if (!pooled.timer) continue
      if (!oldest || pooled.lastActive < oldest.lastActive) {
        oldest = pooled
      }
    }
    if (oldest) {
      this.logger.info("Evicting idle runtime", { sessionId: oldest.sessionId })
      await this.stop(oldest.sessionId, "capacity", oldest.runtime)
      return true
    }
    return false
  }

  scheduleIdleCheck(sessionId: string): void {
    const pooled = this.pools.get(sessionId)
    if (!pooled) return
    if (pooled.timer) clearTimeout(pooled.timer)

    const runtime = pooled.runtime
    pooled.timer = setTimeout(() => {
      this.logger.info("Idle timeout, stopping runtime", { sessionId, timeoutMs: this.options.idleTimeoutMs })
      void this.stop(sessionId, "idle_timeout", runtime)
    }, this.options.idleTimeoutMs)
  }

  private async stopRuntime(sessionId: string, reason: string, expectedRuntime?: AgentRuntime): Promise<boolean> {
    const pooled = this.pools.get(sessionId)
    if (!pooled || (expectedRuntime && pooled.runtime !== expectedRuntime)) return false

    this.pools.delete(sessionId)
    pooled.acceptEvents = false
    pooled.unsubscribe()
    if (pooled.timer) {
      clearTimeout(pooled.timer)
      pooled.timer = null
    }

    try {
      await pooled.runtime.stop()
    } catch (err) {
      this.logger.error("Error stopping runtime", {
        sessionId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return true
  }

  async get(sessionId: string): Promise<AgentRuntime | null> {
    const pooled = this.pools.get(sessionId)
    return pooled?.runtime ?? null
  }

  has(sessionId: string): boolean {
    return this.pools.has(sessionId)
  }

  async invalidate(sessionId: string, runtime: AgentRuntime, reason = "invalidated"): Promise<boolean> {
    return this.stop(sessionId, reason, runtime)
  }

  async stop(sessionId: string, reason = "explicit", expectedRuntime?: AgentRuntime): Promise<boolean> {
    return this.queue.run(sessionId, () => this.stopRuntime(sessionId, reason, expectedRuntime))
  }

  async closeAll(): Promise<void> {
    this.closed = true
    const runtimes = Array.from(this.pools.values())
    await Promise.allSettled(runtimes.map((pooled) => this.stop(pooled.sessionId, "pool_close", pooled.runtime)))
    this.queue.clearAll()
  }

  get size(): number {
    return this.pools.size
  }

  getQueue(): SessionQueue {
    return this.queue
  }
}
