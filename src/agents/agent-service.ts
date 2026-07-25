import type { AgentAdapterRegistry } from "../agents/registry.ts"
import { RuntimePool } from "../runtime/runtime-pool.ts"
import type { SessionRepository } from "../session/index.ts"
import type { MessageRepository, ToolPart } from "../message/index.ts"
import type { EventBus } from "../event/index.ts"
import type { Logger } from "../logging/index.ts"
import type {
  AgentAdapter,
  AgentCompactionResult,
  AgentModel,
  AgentRuntime,
  AgentRuntimeEvent,
} from "../agents/agent-adapter.ts"
import { createEvent } from "../event/index.ts"
import type { AppConfig } from "../config/index.ts"
import { SessionQueue } from "../runtime/session-queue.ts"
import { SubtaskManager, type SubtaskResult } from "../agents/subtask-manager.ts"
import { subagentSessionTitle } from "./subagents/subagent-session.ts"

import type { DatabaseService } from "../db/index.ts"

interface RuntimeSubtask {
  parentSessionId: string
  parentToolPartId: string
  callId: string
  childSessionId: string
  childUserMessageId: string
  childPromptPartId: string
  childAssistantMessageId: string
  published: boolean
}

function runtimeSubtaskKey(parentSessionId: string, callId: string): string {
  return `${parentSessionId}\0${callId}`
}

function retargetRuntimeEvent(event: AgentRuntimeEvent, sessionId: string, messageId: string): AgentRuntimeEvent {
  return {
    ...event,
    sessionId,
    ...("messageId" in event ? { messageId } : {}),
  } as AgentRuntimeEvent
}

export class AgentConversationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
    this.name = "AgentConversationError"
  }
}

export class AgentService {
  private readonly pools = new Map<string, RuntimePool>()
  private readonly registry: AgentAdapterRegistry
  private readonly sessions: SessionRepository
  private readonly messages: MessageRepository
  private readonly events: EventBus
  private readonly logger: Logger
  private readonly config: AppConfig
  private readonly db: DatabaseService
  private readonly globalQueue = new SessionQueue()
  private readonly partIdMap = new Map<string, Map<string, string>>()
  /**
   * OpenCode streams text deltas from memory and persists the complete part at
   * the block boundary. Rewriting the entire JSON part synchronously for every
   * provider token stalls the runtime's event reader and turns a short burst into an
   * increasingly expensive O(n²) database workload.
   */
  private readonly streamedPartText = new Map<string, string>()
  private readonly subtaskManager: SubtaskManager
  private readonly sessionModels = new Map<string, AgentModel>()
  private readonly sessionRuntimeAdapters = new Map<string, string>()
  private readonly sessionRuntimeRevisions = new Map<string, string | number | undefined>()
  private readonly abortedSessions = new Set<string>()
  private readonly titleJobs = new Set<string>()
  private readonly runtimeSubtasks = new Map<string, RuntimeSubtask>()
  private readonly pendingStarts = new Map<string, Set<ReturnType<typeof setTimeout>>>()

  constructor(
    registry: AgentAdapterRegistry,
    sessions: SessionRepository,
    messages: MessageRepository,
    events: EventBus,
    logger: Logger,
    config: AppConfig,
    db: DatabaseService,
  ) {
    this.registry = registry
    this.sessions = sessions
    this.messages = messages
    this.events = events
    this.logger = logger
    this.config = config
    this.db = db

    this.subtaskManager = new SubtaskManager(registry, sessions, messages, events, logger, config)
  }

  generateTitle(
    sessionId: string,
    userMessage: string,
    model: { providerID: string; modelID: string } | undefined,
  ): void {
    if (this.titleJobs.has(sessionId)) return
    const session = this.sessions.get(sessionId)
    if (!session || session.parentID || session.title !== "Untitled") return
    const adapter = this.registry.get(session.agent)
    if (!adapter.generateTitle) return
    this.titleJobs.add(sessionId)
    setTimeout(() => {
      void adapter.generateTitle!(session.directory, userMessage, model)
        .then((title) => {
          if (!title) return
          const current = this.sessions.get(sessionId)
          if (!current || current.title !== "Untitled") return
          const updated = this.sessions.update(sessionId, { title })
          if (updated) {
            this.events.publish(createEvent("session.updated", { sessionID: sessionId, info: updated }))
          }
        })
        .catch((error) => {
          this.logger.warn("Failed to generate session title", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => {
          this.titleJobs.delete(sessionId)
        })
    }, 0)
  }

  private getPool(agentId: string): RuntimePool {
    let pool = this.pools.get(agentId)
    if (!pool) {
      const adapter = this.registry.get(agentId)
      pool = new RuntimePool(adapter, this.logger, {
        maxActive: this.config.maxActiveAgentProcesses,
        idleTimeoutMs: this.config.agentIdleTimeoutMs,
        startTimeoutMs: this.config.agentStartTimeoutMs,
        onEvent: (sessionId, runtime, event) => this.handleAgentEvent(event, sessionId, runtime, agentId),
        onEventError: (sessionId, runtime, event, error) =>
          this.handleAgentEventProjectionError(sessionId, runtime, agentId, event, error),
      })
      this.pools.set(agentId, pool)
    }
    return pool
  }

  private deferStart(sessionId: string, operation: () => Promise<void>): void {
    const timer = setTimeout(() => {
      const pending = this.pendingStarts.get(sessionId)
      pending?.delete(timer)
      if (pending?.size === 0) this.pendingStarts.delete(sessionId)
      void operation()
    }, 0)
    let pending = this.pendingStarts.get(sessionId)
    if (!pending) {
      pending = new Set()
      this.pendingStarts.set(sessionId, pending)
    }
    pending.add(timer)
  }

  private cancelPendingStarts(sessionId: string): void {
    const pending = this.pendingStarts.get(sessionId)
    if (!pending) return
    for (const timer of pending) clearTimeout(timer)
    this.pendingStarts.delete(sessionId)
  }

  schedulePrompt(
    sessionId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    model?: AgentModel,
  ): void {
    this.deferStart(sessionId, () => this.prompt(sessionId, text, userMessageId, assistantMessageId, model))
  }

  schedulePromptWithSubtasks(
    sessionId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    subtaskParts: Array<{
      prompt: string
      description: string
      agent: string
      model?: AgentModel
    }>,
    mode: "sequential" | "parallel" | "chain",
    model?: AgentModel,
  ): void {
    this.deferStart(sessionId, () =>
      this.promptWithSubtasks(sessionId, text, userMessageId, assistantMessageId, subtaskParts, mode, model),
    )
  }

  private getOrCreatePartIdMap(sessionId: string): Map<string, string> {
    let m = this.partIdMap.get(sessionId)
    if (!m) {
      m = new Map()
      this.partIdMap.set(sessionId, m)
    }
    return m
  }

  private async restartRuntimeIfModelChanged(
    sessionId: string,
    adapter: AgentAdapter,
    model: AgentModel | undefined,
    pool: RuntimePool,
  ): Promise<void> {
    const current = this.sessionModels.get(sessionId)
    const currentAdapterId = this.sessionRuntimeAdapters.get(sessionId)
    const currentRevision = this.sessionRuntimeRevisions.get(sessionId)
    const modelChanged = Boolean(
      model && (!current || current.providerID !== model.providerID || current.modelID !== model.modelID),
    )
    const nextRevision = adapter.getRuntimeRevision?.(model)
    const configChanged = currentRevision !== nextRevision
    const adapterChanged = currentAdapterId !== adapter.id
    if (!modelChanged && !configChanged && !adapterChanged) {
      return
    }

    const previousPool = adapterChanged && currentAdapterId ? this.pools.get(currentAdapterId) : pool
    if (previousPool?.has(sessionId)) {
      this.logger.info("Agent runtime configuration changed, restarting runtime", {
        sessionId,
        oldAgentId: currentAdapterId,
        agentId: adapter.id,
        oldModel: current,
        newModel: model,
        oldRevision: currentRevision,
        newRevision: nextRevision,
      })

      this.partIdMap.delete(sessionId)

      await previousPool.stop(sessionId, "configuration_changed")
    }

    if (model) {
      this.sessionModels.set(sessionId, { providerID: model.providerID, modelID: model.modelID })
    }
    this.sessionRuntimeRevisions.set(sessionId, nextRevision)
    this.sessionRuntimeAdapters.set(sessionId, adapter.id)
  }

  hasAgent(agentId: string): boolean {
    return this.registry.has(agentId)
  }

  private async runtimeConfig(adapter: AgentAdapter, model: AgentModel | undefined) {
    const input = adapter.getRuntimeConfig?.(model) ?? { model }
    return adapter.validateConfig(input)
  }

  async prompt(
    sessionId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    model?: { providerID: string; modelID: string },
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const agentId = session.agent
    const adapter = this.registry.get(agentId)
    const pool = this.getPool(agentId)
    let promptRuntime: AgentRuntime | undefined

    try {
      await this.globalQueue.run(sessionId, async () => {
        this.abortedSessions.delete(sessionId)
        await this.restartRuntimeIfModelChanged(sessionId, adapter, model, pool)

        const runtime = await pool.getOrCreate({
          sessionId,
          directory: session.directory,
          logger: this.logger.child({ sessionId, agent: agentId }),
          config: await this.runtimeConfig(adapter, model),
        })
        promptRuntime = runtime

        await runtime.prompt({
          sessionId,
          text,
          messageId: userMessageId,
          assistantMessageId,
        })
        pool.scheduleIdleCheck(sessionId)
      })
    } catch (err) {
      if (promptRuntime) {
        await this.invalidateRuntime(sessionId, promptRuntime, agentId, "prompt_failed")
      }
      this.logger.error("Agent prompt failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      this.sessions.setStatus(sessionId, "idle")
      this.messages.setMessageError(assistantMessageId, {
        type: "agent_error",
        message: err instanceof Error ? err.message : String(err),
      })
      this.publishMessageParts(assistantMessageId)
      this.events.publish(
        createEvent("session.error", {
          sessionID: sessionId,
          messageID: assistantMessageId,
          error: {
            name: "UnknownError",
            data: { message: err instanceof Error ? err.message : String(err) },
          },
        }),
      )
      this.publishMessage(assistantMessageId)
      this.publishStatus(sessionId, "idle")
    }
  }

  async compact(sessionId: string, model?: AgentModel, customInstructions?: string): Promise<AgentCompactionResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    return this.globalQueue.run(sessionId, async () => {
      const current = this.sessions.get(sessionId)
      if (!current) throw new Error(`Session not found: ${sessionId}`)
      const adapter = this.registry.get(current.agent)
      const pool = this.getPool(current.agent)
      const selectedModel =
        model ??
        this.sessionModels.get(sessionId) ??
        (current.model ? { providerID: current.model.providerID, modelID: current.model.id } : undefined)

      await this.restartRuntimeIfModelChanged(sessionId, adapter, selectedModel, pool)
      const runtime = await pool.getOrCreate({
        sessionId,
        directory: current.directory,
        logger: this.logger.child({ sessionId, agent: current.agent }),
        config: await this.runtimeConfig(adapter, selectedModel),
      })
      if (!runtime.compact) {
        throw new Error(`Agent '${current.agent}' does not support session compaction`)
      }
      this.sessions.setStatus(sessionId, "busy")
      this.publishStatus(sessionId, "busy")
      try {
        return await runtime.compact({ customInstructions })
      } finally {
        this.sessions.setStatus(sessionId, "idle")
        pool.scheduleIdleCheck(sessionId)
        this.publishStatus(sessionId, "idle")
        this.events.publish(createEvent("session.idle", { sessionID: sessionId }))
      }
    })
  }

  private async getConversationRuntime(sessionId: string): Promise<{
    runtime: AgentRuntime
    pool: RuntimePool
  }> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new AgentConversationError(`Session not found: ${sessionId}`, 404)
    const adapter = this.registry.get(session.agent)
    const pool = this.getPool(session.agent)
    const model =
      this.sessionModels.get(sessionId) ??
      (session.model ? { providerID: session.model.providerID, modelID: session.model.id } : undefined)
    await this.restartRuntimeIfModelChanged(sessionId, adapter, model, pool)
    const runtime = await pool.getOrCreate({
      sessionId,
      directory: session.directory,
      logger: this.logger.child({ sessionId, agent: session.agent }),
      config: await this.runtimeConfig(adapter, model),
    })
    return { runtime, pool }
  }

  async revert(
    sessionId: string,
    messageId: string,
    partId?: string,
  ): Promise<NonNullable<ReturnType<SessionRepository["get"]>>> {
    return this.globalQueue.run(sessionId, async () => {
      const session = this.sessions.get(sessionId)
      if (!session) throw new AgentConversationError(`Session not found: ${sessionId}`, 404)
      if (["busy", "running", "waiting_permission"].includes(session.status)) {
        throw new AgentConversationError("Session is busy", 409)
      }

      let target = this.messages.getMessage(messageId)
      if (!target || target.sessionID !== sessionId) {
        throw new AgentConversationError(`Message not found: ${messageId}`, 404)
      }
      if (partId) {
        const part = this.messages.getPart(partId)
        if (!part || part.sessionID !== sessionId || part.messageID !== messageId) {
          throw new AgentConversationError(`Part not found: ${partId}`, 404)
        }
      }
      if (target.role === "assistant") {
        target = this.messages.getMessage(target.parentID)
      }
      if (!target || target.role !== "user" || target.sessionID !== sessionId) {
        throw new AgentConversationError("Conversation rollback requires a user turn", 400)
      }

      const { runtime, pool } = await this.getConversationRuntime(sessionId)
      if (!runtime.fork) {
        throw new AgentConversationError(`Agent '${session.agent}' does not support conversation forks`)
      }
      try {
        await runtime.fork({ messageId: target.id })
      } catch (error) {
        throw new AgentConversationError(error instanceof Error ? error.message : String(error))
      }
      const updated = this.sessions.setRevert(sessionId, { messageID: target.id })
      if (!updated) throw new AgentConversationError(`Session not found: ${sessionId}`, 404)
      this.events.publish(createEvent("session.updated", { sessionID: sessionId, info: updated }))
      pool.scheduleIdleCheck(sessionId)
      return updated
    })
  }

  async unrevert(sessionId: string): Promise<NonNullable<ReturnType<SessionRepository["get"]>>> {
    return this.globalQueue.run(sessionId, async () => {
      const session = this.sessions.get(sessionId)
      if (!session) throw new AgentConversationError(`Session not found: ${sessionId}`, 404)
      if (["busy", "running", "waiting_permission"].includes(session.status)) {
        throw new AgentConversationError("Session is busy", 409)
      }
      if (!session.revert) return session

      const { runtime, pool } = await this.getConversationRuntime(sessionId)
      if (!runtime.restoreFork) {
        throw new AgentConversationError(`Agent '${session.agent}' does not support restoring conversation forks`)
      }
      try {
        await runtime.restoreFork()
      } catch (error) {
        throw new AgentConversationError(error instanceof Error ? error.message : String(error))
      }
      const updated = this.sessions.clearRevert(sessionId)
      if (!updated) throw new AgentConversationError(`Session not found: ${sessionId}`, 404)
      this.events.publish(createEvent("session.updated", { sessionID: sessionId, info: updated }))
      pool.scheduleIdleCheck(sessionId)
      return updated
    })
  }

  async commitRevert(sessionId: string): Promise<void> {
    await this.globalQueue.run(sessionId, async () => {
      const session = this.sessions.get(sessionId)
      if (!session?.revert) return
      const { runtime, pool } = await this.getConversationRuntime(sessionId)
      if (!runtime.commitFork) {
        throw new AgentConversationError(`Agent '${session.agent}' cannot commit a conversation fork`)
      }
      try {
        await runtime.commitFork()
      } catch (error) {
        throw new AgentConversationError(error instanceof Error ? error.message : String(error))
      }
      const removed = this.messages.deleteMessagesFrom(sessionId, session.revert.messageID)
      const updated = this.sessions.clearRevert(sessionId)
      for (const removedMessageId of removed) {
        this.events.publish(
          createEvent("message.removed", {
            sessionID: sessionId,
            messageID: removedMessageId,
          }),
        )
      }
      if (updated) {
        this.events.publish(createEvent("session.updated", { sessionID: sessionId, info: updated }))
      }
      pool.scheduleIdleCheck(sessionId)
    })
  }

  private async promptInternal(
    sessionId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    model?: { providerID: string; modelID: string },
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const agentId = session.agent
    const adapter = this.registry.get(agentId)
    const pool = this.getPool(agentId)
    let promptRuntime: AgentRuntime | undefined

    try {
      await this.restartRuntimeIfModelChanged(sessionId, adapter, model, pool)

      const runtime = await pool.getOrCreate({
        sessionId,
        directory: session.directory,
        logger: this.logger.child({ sessionId, agent: agentId }),
        config: await this.runtimeConfig(adapter, model),
      })
      promptRuntime = runtime

      await runtime.prompt({
        sessionId,
        text,
        messageId: userMessageId,
        assistantMessageId,
      })
      pool.scheduleIdleCheck(sessionId)
    } catch (err) {
      if (promptRuntime) {
        await this.invalidateRuntime(sessionId, promptRuntime, agentId, "prompt_failed")
      }
      this.logger.error("Agent promptInternal failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      this.sessions.setStatus(sessionId, "idle")
      this.messages.setMessageError(assistantMessageId, {
        type: "agent_error",
        message: err instanceof Error ? err.message : String(err),
      })
      this.publishMessageParts(assistantMessageId)
      this.events.publish(
        createEvent("session.error", {
          sessionID: sessionId,
          messageID: assistantMessageId,
          error: {
            name: "UnknownError",
            data: { message: err instanceof Error ? err.message : String(err) },
          },
        }),
      )
      this.publishMessage(assistantMessageId)
      this.publishStatus(sessionId, "idle")
    }
  }

  async promptWithSubtasks(
    sessionId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    subtaskParts: Array<{
      prompt: string
      description: string
      agent: string
      model?: { providerID: string; modelID: string }
    }>,
    mode: "sequential" | "parallel" | "chain" = "sequential",
    model?: { providerID: string; modelID: string },
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    try {
      await this.globalQueue.run(sessionId, async () => {
        this.abortedSessions.delete(sessionId)
        if (mode === "parallel") {
          await this.runParallelSubtasks(sessionId, text, userMessageId, assistantMessageId, subtaskParts, model)
        } else if (mode === "chain") {
          await this.runChainSubtasks(sessionId, text, userMessageId, assistantMessageId, subtaskParts, model)
        } else {
          await this.runSequentialSubtasks(sessionId, text, userMessageId, assistantMessageId, subtaskParts, model)
        }
      })
    } catch (err) {
      this.logger.error("Subtask prompt failed", { sessionId, error: err instanceof Error ? err.message : String(err) })
      this.sessions.setStatus(sessionId, "idle")
      this.messages.setMessageError(assistantMessageId, {
        type: "agent_error",
        message: err instanceof Error ? err.message : String(err),
      })
      this.publishMessageParts(assistantMessageId)
      this.publishMessage(assistantMessageId)
      this.publishStatus(sessionId, "idle")
    }
  }

  private createToolPartForSubtask(
    sessionId: string,
    userMessageId: string,
    st: { prompt: string; description: string; agent: string },
  ): { toolPart: ToolPart; subAssistantMsg: { id: string } } {
    const subAssistantMsg = this.messages.createAssistantMessage(sessionId, userMessageId, st.agent)

    const callID = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
    const toolInput = { prompt: st.prompt, description: st.description, subagent_type: st.agent }
    const toolPart = this.messages.createPart(sessionId, subAssistantMsg.id, "tool", {
      callID,
      tool: "task",
      state: {
        status: "running",
        input: toolInput,
        raw: JSON.stringify(toolInput),
        title: st.description,
        time: { start: Date.now() },
      },
    }) as ToolPart

    this.publishMessage(subAssistantMsg.id)
    this.publishPart(toolPart.id)

    return { toolPart, subAssistantMsg }
  }

  private finalizeToolPart(
    sessionId: string,
    toolPart: ToolPart,
    subAssistantMsgId: string,
    childSessionId: string | null,
    agent: string,
    description: string,
    subText: string,
    subStatus: "completed" | "failed" | "aborted",
    usage?: {
      cost?: number
      input?: number
      output?: number
      cacheRead?: number
      cacheWrite?: number
      contextTokens?: number
      turns?: number
    },
  ): void {
    const now = Date.now()
    const toolState = toolPart.state
    const startTime = toolState.time?.start ?? now
    const updatedState = {
      ...toolState,
      status:
        subStatus === "completed"
          ? ("completed" as const)
          : subStatus === "aborted"
            ? ("aborted" as const)
            : ("error" as const),
      output: subText,
      error: subStatus !== "completed" ? subText : undefined,
      metadata: {
        ...(toolState.metadata ?? {}),
        parentSessionId: sessionId,
        sessionId: childSessionId,
        agent,
        description,
        subtaskStatus: subStatus,
        ...(usage ? { usage } : {}),
      },
      time: { start: startTime, end: now },
    }
    this.messages.updatePart(toolPart.id, { state: updatedState })

    this.publishPart(toolPart.id)

    this.messages.completeMessage(subAssistantMsgId, subStatus === "completed" ? "stop" : "error")
    this.publishMessage(subAssistantMsgId)
  }

  private async runSequentialSubtasks(
    sessionId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    subtaskParts: Array<{
      prompt: string
      description: string
      agent: string
      model?: { providerID: string; modelID: string }
    }>,
    parentModel?: { providerID: string; modelID: string },
  ): Promise<void> {
    const subtaskResults: string[] = []

    for (const st of subtaskParts) {
      const { toolPart, subAssistantMsg } = this.createToolPartForSubtask(sessionId, userMessageId, st)

      let subText = ""
      let subStatus: "completed" | "failed" | "aborted" = "completed"
      let childSessionId: string | null = null
      let usage:
        | {
            cost?: number
            input?: number
            output?: number
            cacheRead?: number
            cacheWrite?: number
            contextTokens?: number
            turns?: number
          }
        | undefined

      try {
        const handle = this.subtaskManager.start({
          parentSessionId: sessionId,
          parentToolPartId: toolPart.id,
          parentAssistantMessageId: subAssistantMsg.id,
          prompt: st.prompt,
          description: st.description,
          agent: st.agent,
          model: st.model,
        })

        childSessionId = handle.childSessionId
        const result: SubtaskResult = await handle.result

        subText = result.output ?? ""
        subStatus = result.status
        usage = result.usage

        if (result.status === "failed" && result.error) {
          subText = subText || `Error: ${result.error.message}`
        }
      } catch (err) {
        this.logger.error("Subtask failed to start", {
          error: err instanceof Error ? err.message : String(err),
          agent: st.agent,
        })
        subText = `Error: ${err instanceof Error ? err.message : String(err)}`
        subStatus = "failed"
      }

      subtaskResults.push(subText)
      this.finalizeToolPart(
        sessionId,
        toolPart,
        subAssistantMsg.id,
        childSessionId,
        st.agent,
        st.description,
        subText,
        subStatus,
        usage,
      )
    }

    await this.finishParentPrompt(sessionId, text, userMessageId, assistantMessageId, subtaskResults, parentModel)
  }

  private async runParallelSubtasks(
    sessionId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    subtaskParts: Array<{
      prompt: string
      description: string
      agent: string
      model?: { providerID: string; modelID: string }
    }>,
    parentModel?: { providerID: string; modelID: string },
  ): Promise<void> {
    const entries = subtaskParts.map((st) => {
      const { toolPart, subAssistantMsg } = this.createToolPartForSubtask(sessionId, userMessageId, st)
      return { st, toolPart, subAssistantMsg }
    })

    const handles = entries.map(({ st, toolPart, subAssistantMsg }) => {
      try {
        const handle = this.subtaskManager.start({
          parentSessionId: sessionId,
          parentToolPartId: toolPart.id,
          parentAssistantMessageId: subAssistantMsg.id,
          prompt: st.prompt,
          description: st.description,
          agent: st.agent,
          model: st.model,
        })
        return { handle, toolPart, subAssistantMsg, st, error: null as string | null }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { handle: null, toolPart, subAssistantMsg, st, error: errMsg }
      }
    })

    const results = await Promise.allSettled(
      handles.map(async (h) => {
        if (h.error || !h.handle) {
          return { subText: `Error: ${h.error}`, subStatus: "failed" as const, childSessionId: null, usage: undefined }
        }
        const result: SubtaskResult = await h.handle.result
        return {
          subText: result.output ?? (result.error ? `Error: ${result.error.message}` : ""),
          subStatus: result.status,
          childSessionId: h.handle.childSessionId,
          usage: result.usage,
        }
      }),
    )

    const subtaskResults: string[] = []
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i]!
      const r = results[i]!
      let subText: string
      let subStatus: "completed" | "failed" | "aborted"
      let childSessionId: string | null = null
      let usage:
        | {
            cost?: number
            input?: number
            output?: number
            cacheRead?: number
            cacheWrite?: number
            contextTokens?: number
            turns?: number
          }
        | undefined

      if (r.status === "fulfilled") {
        subText = r.value.subText
        subStatus = r.value.subStatus
        childSessionId = r.value.childSessionId
        usage = r.value.usage
      } else {
        subText = `Error: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`
        subStatus = "failed"
      }

      subtaskResults.push(subText)
      this.finalizeToolPart(
        sessionId,
        h.toolPart,
        h.subAssistantMsg.id,
        childSessionId,
        h.st.agent,
        h.st.description,
        subText,
        subStatus,
        usage,
      )
    }

    await this.finishParentPrompt(sessionId, text, userMessageId, assistantMessageId, subtaskResults, parentModel)
  }

  private async runChainSubtasks(
    sessionId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    subtaskParts: Array<{
      prompt: string
      description: string
      agent: string
      model?: { providerID: string; modelID: string }
    }>,
    parentModel?: { providerID: string; modelID: string },
  ): Promise<void> {
    const subtaskResults: string[] = []
    let previousOutput = ""

    for (let i = 0; i < subtaskParts.length; i++) {
      const st = subtaskParts[i]!
      const effectivePrompt = st.prompt.replace(/\{previous\}/g, previousOutput)

      const { toolPart, subAssistantMsg } = this.createToolPartForSubtask(sessionId, userMessageId, {
        ...st,
        prompt: effectivePrompt,
      })

      let subText = ""
      let subStatus: "completed" | "failed" | "aborted" = "completed"
      let childSessionId: string | null = null
      let usage:
        | {
            cost?: number
            input?: number
            output?: number
            cacheRead?: number
            cacheWrite?: number
            contextTokens?: number
            turns?: number
          }
        | undefined

      try {
        const handle = this.subtaskManager.start({
          parentSessionId: sessionId,
          parentToolPartId: toolPart.id,
          parentAssistantMessageId: subAssistantMsg.id,
          prompt: effectivePrompt,
          description: st.description,
          agent: st.agent,
          model: st.model,
        })

        childSessionId = handle.childSessionId
        const result: SubtaskResult = await handle.result

        subText = result.output ?? ""
        subStatus = result.status
        usage = result.usage

        if (result.status === "failed" && result.error) {
          subText = subText || `Error: ${result.error.message}`
        }

        if (subStatus === "completed") {
          previousOutput = subText
        } else {
          subtaskResults.push(subText)
          this.finalizeToolPart(
            sessionId,
            toolPart,
            subAssistantMsg.id,
            childSessionId,
            st.agent,
            st.description,
            subText,
            subStatus,
            usage,
          )
          break
        }
      } catch (err) {
        this.logger.error("Chain step failed to start", {
          error: err instanceof Error ? err.message : String(err),
          agent: st.agent,
          step: i + 1,
        })
        subText = `Error: ${err instanceof Error ? err.message : String(err)}`
        subStatus = "failed"
      }

      subtaskResults.push(subText)
      this.finalizeToolPart(
        sessionId,
        toolPart,
        subAssistantMsg.id,
        childSessionId,
        st.agent,
        st.description,
        subText,
        subStatus,
        usage,
      )
    }

    await this.finishParentPrompt(sessionId, text, userMessageId, assistantMessageId, subtaskResults, parentModel)
  }

  private async finishParentPrompt(
    sessionId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    subtaskResults: string[],
    model?: { providerID: string; modelID: string },
  ): Promise<void> {
    if (this.abortedSessions.has(sessionId)) {
      this.sessions.setStatus(sessionId, "idle")
      this.publishStatus(sessionId, "idle")
      this.messages.completeMessage(assistantMessageId, "aborted")
      this.publishMessage(assistantMessageId)
      return
    }

    if (text) {
      let effectiveText = text
      if (subtaskResults.length > 0) {
        const contextParts = subtaskResults.map(
          (result) => `<task state="completed"><task_result>${result}</task_result></task>`,
        )
        effectiveText = [
          "The delegated tasks below were already completed by the server.",
          "Do not call a task or subagent tool for them again; answer using their completed results.",
          contextParts.join("\n\n"),
          text,
        ].join("\n\n")
      }
      await this.promptInternal(sessionId, effectiveText, userMessageId, assistantMessageId, model)
    } else {
      this.sessions.setStatus(sessionId, "idle")
      this.publishStatus(sessionId, "idle")
      this.events.publish(createEvent("session.idle", { sessionID: sessionId }))
      this.messages.completeMessage(assistantMessageId, "stop")
      this.publishMessage(assistantMessageId)
    }
  }

  async abort(sessionId: string): Promise<void> {
    this.cancelPendingStarts(sessionId)
    const session = this.sessions.get(sessionId)
    if (!session) return

    const childRun = Array.from(this.runtimeSubtasks.values()).find((run) => run.childSessionId === sessionId)
    if (childRun) {
      await this.abort(childRun.parentSessionId)
      return
    }

    this.abortedSessions.add(sessionId)
    await this.subtaskManager.abortByParentSession(sessionId, "User aborted parent session")

    const pool = this.pools.get(session.agent)
    if (pool) {
      const runtime = await pool.get(sessionId)
      if (runtime) {
        try {
          await runtime.abort()
          pool.scheduleIdleCheck(sessionId)
        } catch (error) {
          this.logger.error("Agent abort failed; invalidating Runtime", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
          await this.invalidateRuntime(sessionId, runtime, session.agent, "abort_failed")
        }
      }
    }

    this.finishRuntimeSubtasksByParent(sessionId, "aborted", "Delegated task was aborted with its parent session.")
    this.sessions.setStatus(sessionId, "idle")
    this.publishStatus(sessionId, "idle")
    this.events.publish(createEvent("session.idle", { sessionID: sessionId }))
  }

  async stopSession(sessionId: string): Promise<void> {
    this.cancelPendingStarts(sessionId)
    const session = this.sessions.get(sessionId)
    if (!session) return

    const childRun = Array.from(this.runtimeSubtasks.values()).find((run) => run.childSessionId === sessionId)
    if (childRun) {
      await this.stopSession(childRun.parentSessionId)
      return
    }

    await this.subtaskManager.abortByParentSession(sessionId, "Session stopped")

    const pool = this.pools.get(session.agent)
    if (pool) {
      await pool.stop(sessionId, "session_stopped")
    }
    this.finishRuntimeSubtasksByParent(sessionId, "aborted", "Delegated task stopped with its parent session.")

    this.partIdMap.delete(sessionId)
    this.sessionModels.delete(sessionId)
    this.sessionRuntimeAdapters.delete(sessionId)
    this.sessionRuntimeRevisions.delete(sessionId)
    this.abortedSessions.delete(sessionId)
  }

  async respondToPermission(
    sessionId: string,
    permissionId: string,
    action: "allow" | "deny",
    reason?: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const pool = this.pools.get(session.agent)
    if (pool) {
      const runtime = await pool.get(sessionId)
      if (runtime) {
        await runtime.respondToPermission(
          permissionId,
          action === "allow" ? { type: "allow" } : { type: "deny", reason },
        )
        return
      }
    }

    await this.subtaskManager.respondToPermission(sessionId, permissionId, action, reason)
  }

  async closeAll(): Promise<void> {
    for (const sessionId of this.pendingStarts.keys()) this.cancelPendingStarts(sessionId)
    await Promise.allSettled(this.registry.list().map((adapter) => adapter.close?.()))
    await this.subtaskManager.closeAll()

    for (const pool of this.pools.values()) {
      await pool.closeAll()
    }
    this.pools.clear()
    this.globalQueue.clearAll()
    this.partIdMap.clear()
    this.streamedPartText.clear()
    this.sessionModels.clear()
    this.sessionRuntimeAdapters.clear()
    this.sessionRuntimeRevisions.clear()
    this.abortedSessions.clear()
    this.titleJobs.clear()
    this.runtimeSubtasks.clear()
    this.pendingStarts.clear()
  }

  recoverOnStartup(): void {
    this.subtaskManager.recoverOnStartup()

    const orphanedTools = this.messages.recoverOpenToolParts(
      "The server restarted before the agent emitted a terminal tool result.",
    )

    // No agent runtime survives a server restart. Any incomplete assistant message
    // is therefore orphaned, even when an older build happened to persist the
    // session itself as idle before it crashed.
    const openMessages = this.db
      .prepare(
        "SELECT id, session_id FROM messages WHERE role = 'assistant' AND completed_at IS NULL ORDER BY created_at ASC, rowid ASC",
      )
      .all() as Array<{ id: string; session_id: string }>
    for (const message of openMessages) {
      this.messages.setMessageError(message.id, {
        type: "interrupted",
        message: "The server restarted before the agent turn reached a terminal state.",
      })
    }

    // Persisted parent sessions left busy would otherwise make Desktop render
    // "thinking" forever, even though no process can publish a future idle event.
    const orphanedSessions = this.sessions
      .listByStatuses(["running", "busy", "waiting_permission"])
      .filter((session) => !session.parentID)
    const now = Date.now()
    for (const session of orphanedSessions) {
      this.sessions.setStatus(session.id, "idle")
    }
    const permissions = this.db
      .prepare("UPDATE permissions SET status = 'deny', response = ?, responded_at = ? WHERE status = 'pending'")
      .run(JSON.stringify({ action: "deny", reason: "Server restarted" }), now)
    if (openMessages.length > 0 || orphanedTools > 0 || orphanedSessions.length > 0 || permissions.changes > 0) {
      this.logger.warn("Recovered orphaned runtime state on startup", {
        openMessages: openMessages.length,
        openTools: orphanedTools,
        busySessions: orphanedSessions.length,
        pendingPermissions: permissions.changes,
      })
    }
  }

  private publishPart(partId: string): void {
    const part = this.messages.getPart(partId)
    if (!part) return
    this.events.publish(
      createEvent("message.part.updated", {
        sessionID: part.sessionID,
        part,
        time: Date.now(),
      }),
    )
  }

  private publishPartDelta(sessionId: string, messageId: string, partId: string, field: string, delta: string): void {
    this.events.publish(
      createEvent("message.part.delta", {
        sessionID: sessionId,
        messageID: messageId,
        partID: partId,
        field,
        delta,
      }),
    )
  }

  private flushStreamedMessageParts(messageId: string): void {
    for (const part of this.messages.listParts(messageId)) {
      const text = this.streamedPartText.get(part.id)
      if (text === undefined || (part.type !== "text" && part.type !== "reasoning")) continue
      this.messages.updatePart(part.id, {
        text,
        time: { start: part.time?.start ?? Date.now(), end: Date.now() },
      })
      this.streamedPartText.delete(part.id)
    }
  }

  private publishMessage(messageId: string): void {
    const info = this.messages.getMessage(messageId)
    if (!info) return
    this.events.publish(
      createEvent("message.updated", {
        sessionID: info.sessionID,
        info,
      }),
    )
  }

  private publishMessageParts(messageId: string): void {
    for (const part of this.messages.listParts(messageId)) {
      this.events.publish(
        createEvent("message.part.updated", {
          sessionID: part.sessionID,
          part,
          time: Date.now(),
        }),
      )
    }
  }

  private publishStatus(
    sessionId: string,
    status:
      | "busy"
      | "idle"
      | {
          type: "retry"
          attempt: number
          message: string
          next: number
        },
  ): void {
    this.events.publish(
      createEvent("session.status", {
        sessionID: sessionId,
        status: typeof status === "string" ? { type: status } : status,
      }),
    )
  }

  private async invalidateRuntime(
    sessionId: string,
    expectedRuntime?: AgentRuntime,
    agentId?: string,
    reason = "invalidated",
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    const pool = this.pools.get(agentId ?? session?.agent ?? "")
    if (pool) {
      if (expectedRuntime) await pool.invalidate(sessionId, expectedRuntime, reason)
      else await pool.stop(sessionId, reason)
    }
    this.partIdMap.delete(sessionId)
    this.sessionModels.delete(sessionId)
    this.sessionRuntimeRevisions.delete(sessionId)
  }

  private ensureRuntimeSubtask(
    parentSessionId: string,
    parentToolPartId: string,
    callId: string,
    parentAssistantMessageId: string,
    input: Record<string, unknown>,
  ): RuntimeSubtask | undefined {
    const key = runtimeSubtaskKey(parentSessionId, callId)
    const existing = this.runtimeSubtasks.get(key)
    if (existing) return existing

    const parent = this.sessions.get(parentSessionId)
    if (!parent) return undefined

    const prompt = typeof input.prompt === "string" ? input.prompt : typeof input.task === "string" ? input.task : ""
    if (!prompt.trim()) return undefined
    const description =
      typeof input.description === "string" && input.description.trim()
        ? input.description.trim()
        : prompt.slice(0, 80) || "Delegated task"
    const agent =
      typeof input.subagent_type === "string" && input.subagent_type.trim()
        ? input.subagent_type.trim()
        : typeof input.agent === "string" && input.agent.trim()
          ? input.agent.trim()
          : "general"
    const parentMessage = this.messages.getMessage(parentAssistantMessageId)
    const model =
      parentMessage?.role === "assistant"
        ? { providerID: parentMessage.providerID, modelID: parentMessage.modelID }
        : this.sessionModels.get(parentSessionId)
    const child = this.sessions.create({
      directory: parent.directory,
      title: subagentSessionTitle(description, agent),
      agent,
      parentId: parentSessionId,
      model: model ? { id: model.modelID, providerID: model.providerID } : undefined,
    })
    this.sessions.setStatus(child.id, "busy")

    const childUserMessage = this.messages.createUserMessage(child.id, agent, model)
    const childPromptPart = this.messages.createPart(child.id, childUserMessage.id, "text", {
      text: prompt,
      time: { start: Date.now(), end: Date.now() },
    })

    const childAssistantMessage = this.messages.createAssistantMessage(child.id, childUserMessage.id, agent, model)

    const run: RuntimeSubtask = {
      parentSessionId,
      parentToolPartId,
      callId,
      childSessionId: child.id,
      childUserMessageId: childUserMessage.id,
      childPromptPartId: childPromptPart.id,
      childAssistantMessageId: childAssistantMessage.id,
      published: false,
    }
    this.runtimeSubtasks.set(key, run)
    this.logger.info("Mirroring delegated task into OpenCode child session", {
      parentSessionId,
      childSessionId: child.id,
      callId,
      agent,
    })
    return run
  }

  /**
   * Publish the child only after the parent task part has been published with
   * both input.description and metadata.sessionId. Desktop can infer a child
   * ID from session.created before the task link arrives; if that happens it
   * temporarily renders the raw ID as the task subtitle.
   */
  private publishRuntimeSubtaskStarted(run: RuntimeSubtask): void {
    if (run.published) return
    run.published = true

    const childSession = this.sessions.get(run.childSessionId)
    const childUserMessage = this.messages.getMessage(run.childUserMessageId)
    const childPromptPart = this.messages.getPart(run.childPromptPartId)
    const childAssistantMessage = this.messages.getMessage(run.childAssistantMessageId)
    if (childSession) {
      this.events.publish(
        createEvent("session.created", {
          sessionID: run.childSessionId,
          info: childSession,
        }),
      )
    }
    if (childUserMessage) {
      this.events.publish(
        createEvent("message.updated", {
          sessionID: run.childSessionId,
          info: childUserMessage,
        }),
      )
    }
    if (childPromptPart) {
      this.events.publish(
        createEvent("message.part.updated", {
          sessionID: run.childSessionId,
          part: childPromptPart,
          time: Date.now(),
        }),
      )
    }
    if (childAssistantMessage) {
      this.events.publish(
        createEvent("message.updated", {
          sessionID: run.childSessionId,
          info: childAssistantMessage,
        }),
      )
    }
    this.publishStatus(run.childSessionId, "busy")
  }

  private runtimeSubtaskMetadata(run: RuntimeSubtask | undefined): Record<string, unknown> {
    if (!run) return {}
    const childMessage = this.messages.getMessage(run.childAssistantMessageId)
    const model =
      childMessage?.role === "assistant"
        ? { providerID: childMessage.providerID, modelID: childMessage.modelID }
        : undefined
    return {
      parentSessionId: run.parentSessionId,
      sessionId: run.childSessionId,
      ...(model ? { model } : {}),
    }
  }

  private handleRuntimeSubtaskEvent(event: Extract<AgentRuntimeEvent, { type: "subtask_event" }>): void {
    const partIds = this.getOrCreatePartIdMap(event.sessionId)
    let parentToolPartId = partIds.get(event.partId)
    const parentPart = parentToolPartId ? this.messages.getPart(parentToolPartId) : undefined
    if (!parentToolPartId || parentPart?.type !== "tool") {
      const recovered = this.messages.createPart(event.sessionId, event.messageId, "tool", {
        callID: event.callId,
        tool: "task",
        state: {
          status: "running",
          input: event.input,
          raw: JSON.stringify(event.input),
          time: { start: Date.now() },
        },
      }) as ToolPart
      parentToolPartId = recovered.id
      partIds.set(event.partId, recovered.id)
      this.logger.warn("Recovered OpenCode task part from a Pi subtask event without a projected start", {
        sessionId: event.sessionId,
        messageId: event.messageId,
        callId: event.callId,
        agentPartId: event.partId,
      })
      this.publishPart(recovered.id)
    }
    const run = this.ensureRuntimeSubtask(event.sessionId, parentToolPartId, event.callId, event.messageId, event.input)
    if (!run) {
      this.logger.warn("Agent event produced no OpenCode event", {
        sessionId: event.sessionId,
        agentEvent: event.event.type,
        stage: "subtask_projection",
        reason: "Task input did not contain enough data to create an OpenCode child session",
      })
      return
    }
    this.publishRuntimeSubtaskStarted(run)
    this.handleAgentEvent(
      retargetRuntimeEvent(event.event, run.childSessionId, run.childAssistantMessageId),
      run.childSessionId,
    )
  }

  private finishRuntimeSubtask(
    parentSessionId: string,
    callId: string,
    status: "completed" | "failed" | "aborted",
    output: string,
    error?: string,
    metadata?: Record<string, unknown>,
  ): void {
    const key = runtimeSubtaskKey(parentSessionId, callId)
    const run = this.runtimeSubtasks.get(key)
    if (!run) return

    const usage = metadata?.usage as
      | {
          input?: number
          output?: number
          cacheRead?: number
          cacheWrite?: number
          totalTokens?: number
          cost?: { total?: number }
        }
      | undefined
    if (usage) {
      this.messages.updateMessageUsage(run.childAssistantMessageId, {
        cost: usage.cost?.total,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        total: usage.totalTokens,
      })
    }

    const childParts = this.messages.listParts(run.childAssistantMessageId)
    if (output && !childParts.some((part) => part.type === "text" && part.text.trim())) {
      this.messages.createPart(run.childSessionId, run.childAssistantMessageId, "text", {
        text: output,
        time: { start: Date.now(), end: Date.now() },
      })
    }

    const childMessage = this.messages.getMessage(run.childAssistantMessageId)
    if (status === "completed") {
      if (childMessage?.role === "assistant" && childMessage.time.completed === undefined && !childMessage.error) {
        this.messages.completeMessage(run.childAssistantMessageId, "stop")
      }
      this.sessions.setStatus(run.childSessionId, "idle")
    } else {
      this.messages.setMessageError(run.childAssistantMessageId, {
        type: status === "aborted" ? "aborted" : "subagent_error",
        message: error || output || (status === "aborted" ? "Delegated task was aborted" : "Delegated task failed"),
      })
      this.sessions.setStatus(run.childSessionId, status)
    }

    this.publishMessageParts(run.childAssistantMessageId)
    this.publishMessage(run.childAssistantMessageId)
    this.publishStatus(run.childSessionId, "idle")
    this.events.publish(createEvent("session.idle", { sessionID: run.childSessionId }))
    this.runtimeSubtasks.delete(key)
  }

  private finishRuntimeSubtasksByParent(parentSessionId: string, status: "failed" | "aborted", message: string): void {
    const runs = Array.from(this.runtimeSubtasks.values()).filter((run) => run.parentSessionId === parentSessionId)
    for (const run of runs) {
      this.finishRuntimeSubtask(parentSessionId, run.callId, status, "", message)
    }
  }

  private handleAgentEvent(
    event: AgentRuntimeEvent,
    sessionId: string,
    runtime?: AgentRuntime,
    agentId?: string,
  ): void {
    try {
      const partIdMap = this.getOrCreatePartIdMap(sessionId)

      switch (event.type) {
        case "text_started": {
          const part = this.messages.createPart(sessionId, event.messageId, "text", {
            text: "",
            time: { start: Date.now() },
          })
          partIdMap.set(event.partId, part.id)
          this.streamedPartText.set(part.id, "")
          this.publishPart(part.id)
          break
        }

        case "text_delta": {
          let dbPartId = partIdMap.get(event.partId)
          const existing = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || existing?.type !== "text") {
            const part = this.messages.createPart(sessionId, event.messageId, "text", {
              text: event.text,
              time: { start: Date.now() },
            })
            dbPartId = part.id
            partIdMap.set(event.partId, part.id)
            this.logger.warn("Recovered OpenCode text part from a Pi delta without a projected start", {
              sessionId,
              messageId: event.messageId,
              agentPartId: event.partId,
            })
            this.publishPart(part.id)
          } else {
            this.publishPartDelta(sessionId, event.messageId, dbPartId, "text", event.delta)
          }
          this.streamedPartText.set(dbPartId, event.text)
          break
        }

        case "text_snapshot": {
          let dbPartId = partIdMap.get(event.partId)
          let part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "text") {
            part = this.messages.createPart(sessionId, event.messageId, "text", {
              text: event.text,
              time: { start: Date.now() },
            })
            dbPartId = part.id
            partIdMap.set(event.partId, part.id)
            this.logger.warn("Recovered OpenCode text part from a Pi snapshot without a projected start", {
              sessionId,
              messageId: event.messageId,
              agentPartId: event.partId,
            })
          } else if (part.text !== event.text) {
            this.messages.updatePart(dbPartId, { text: event.text })
          }
          this.streamedPartText.set(dbPartId, event.text)
          this.publishPart(dbPartId)
          break
        }

        case "text_ended": {
          let dbPartId = partIdMap.get(event.partId)
          const part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "text") {
            const recovered = this.messages.createPart(sessionId, event.messageId, "text", {
              text: event.text,
              time: { start: Date.now(), end: Date.now() },
            })
            dbPartId = recovered.id
            partIdMap.set(event.partId, recovered.id)
            this.logger.warn("Recovered OpenCode text part from a Pi end without a projected start", {
              sessionId,
              messageId: event.messageId,
              agentPartId: event.partId,
            })
          } else {
            this.messages.updatePart(dbPartId, {
              text: event.text,
              time: { start: part.time?.start ?? Date.now(), end: Date.now() },
            })
          }
          this.streamedPartText.delete(dbPartId)
          this.publishPart(dbPartId)
          break
        }

        case "reasoning_started": {
          const part = this.messages.createPart(sessionId, event.messageId, "reasoning", {
            text: "",
            time: { start: Date.now() },
          })
          partIdMap.set(event.partId, part.id)
          this.streamedPartText.set(part.id, "")
          this.publishPart(part.id)
          break
        }

        case "reasoning_delta": {
          let dbPartId = partIdMap.get(event.partId)
          const existing = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || existing?.type !== "reasoning") {
            const part = this.messages.createPart(sessionId, event.messageId, "reasoning", {
              text: event.text,
              time: { start: Date.now() },
            })
            dbPartId = part.id
            partIdMap.set(event.partId, part.id)
            this.logger.warn("Recovered OpenCode reasoning part from a Pi delta without a projected start", {
              sessionId,
              messageId: event.messageId,
              agentPartId: event.partId,
            })
            this.publishPart(part.id)
          } else {
            this.publishPartDelta(sessionId, event.messageId, dbPartId, "text", event.delta)
          }
          this.streamedPartText.set(dbPartId, event.text)
          break
        }

        case "reasoning_snapshot": {
          let dbPartId = partIdMap.get(event.partId)
          let part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "reasoning") {
            part = this.messages.createPart(sessionId, event.messageId, "reasoning", {
              text: event.text,
              time: { start: Date.now() },
            })
            dbPartId = part.id
            partIdMap.set(event.partId, part.id)
            this.logger.warn("Recovered OpenCode reasoning part from a Pi snapshot without a projected start", {
              sessionId,
              messageId: event.messageId,
              agentPartId: event.partId,
            })
          } else if (part.text !== event.text) {
            this.messages.updatePart(dbPartId, { text: event.text })
          }
          this.streamedPartText.set(dbPartId, event.text)
          this.publishPart(dbPartId)
          break
        }

        case "reasoning_ended": {
          let dbPartId = partIdMap.get(event.partId)
          const part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "reasoning") {
            const recovered = this.messages.createPart(sessionId, event.messageId, "reasoning", {
              text: event.text,
              time: { start: Date.now(), end: Date.now() },
            })
            dbPartId = recovered.id
            partIdMap.set(event.partId, recovered.id)
            this.logger.warn("Recovered OpenCode reasoning part from a Pi end without a projected start", {
              sessionId,
              messageId: event.messageId,
              agentPartId: event.partId,
            })
          } else {
            this.messages.updatePart(dbPartId, {
              text: event.text,
              time: { start: part.time?.start ?? Date.now(), end: Date.now() },
            })
          }
          this.streamedPartText.delete(dbPartId)
          this.publishPart(dbPartId)
          break
        }

        case "tool_call_started": {
          const part = this.messages.createPart(sessionId, event.messageId, "tool", {
            callID: event.callId,
            tool: event.tool,
            state: {
              status: "pending",
              input: event.input,
              raw: JSON.stringify(event.input),
            },
          }) as ToolPart
          partIdMap.set(event.partId, part.id)
          // toolcall_start may contain only a partially decoded JSON argument
          // object. In particular, task.prompt can arrive before
          // task.description. Linking a child session at this point makes
          // Desktop fall back to displaying metadata.sessionId as the task
          // subtitle until toolcall_end supplies the description. Create and
          // link the child from tool_call_running, where the backend has finalized the
          // arguments.
          this.publishPart(part.id)
          break
        }

        case "tool_call_delta": {
          let dbPartId = partIdMap.get(event.partId)
          let part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "tool") {
            part = this.messages.createPart(sessionId, event.messageId, "tool", {
              callID: event.callId,
              tool: "unknown",
              state: {
                status: "running",
                input: {},
                raw: event.delta,
                time: { start: Date.now() },
              },
            }) as ToolPart
            dbPartId = part.id
            partIdMap.set(event.partId, part.id)
            this.logger.warn("Recovered OpenCode tool part from a Pi delta without a projected start", {
              sessionId,
              messageId: event.messageId,
              callId: event.callId,
              agentPartId: event.partId,
            })
          } else {
            this.messages.updatePart(dbPartId, {
              state: {
                status: "running",
                input: part.state.input,
                metadata: part.state.metadata,
                time: { start: part.state.time?.start ?? Date.now() },
              },
            })
          }
          this.publishPart(dbPartId)
          break
        }

        case "tool_call_running": {
          let dbPartId = partIdMap.get(event.partId)
          let part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "tool") {
            part = this.messages.createPart(sessionId, event.messageId, "tool", {
              callID: event.callId,
              tool: event.tool,
              state: {
                status: "running",
                input: event.input,
                raw: JSON.stringify(event.input),
                time: { start: Date.now() },
              },
            }) as ToolPart
            dbPartId = part.id
            partIdMap.set(event.partId, part.id)
            this.logger.warn("Recovered OpenCode tool part from a Pi running event without a projected start", {
              sessionId,
              messageId: event.messageId,
              callId: event.callId,
              agentPartId: event.partId,
            })
          }
          const run =
            event.tool === "task"
              ? this.ensureRuntimeSubtask(sessionId, dbPartId, event.callId, event.messageId, event.input)
              : undefined
          this.messages.updatePart(dbPartId, {
            tool: event.tool || part.tool,
            state: {
              status: "running",
              input: event.input,
              title: part.state.title,
              metadata: {
                ...(part.state.metadata ?? {}),
                ...this.runtimeSubtaskMetadata(run),
              },
              time: { start: part.state.time?.start ?? Date.now() },
            },
          })
          this.publishPart(dbPartId)
          if (run) this.publishRuntimeSubtaskStarted(run)
          break
        }

        case "tool_call_progress": {
          let dbPartId = partIdMap.get(event.partId)
          let part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "tool") {
            part = this.messages.createPart(sessionId, event.messageId, "tool", {
              callID: event.callId,
              tool: "unknown",
              state: {
                status: "running",
                input: {},
                metadata: { ...(event.metadata ?? {}), partialOutput: event.output },
                time: { start: Date.now() },
              },
            }) as ToolPart
            dbPartId = part.id
            partIdMap.set(event.partId, part.id)
            this.logger.warn("Recovered OpenCode tool part from Pi progress without a projected start", {
              sessionId,
              messageId: event.messageId,
              callId: event.callId,
              agentPartId: event.partId,
            })
          } else {
            this.messages.updatePart(dbPartId, {
              state: {
                status: "running",
                input: part.state.input,
                title: part.state.title,
                metadata: {
                  ...(part.state.metadata ?? {}),
                  ...(event.metadata ?? {}),
                  partialOutput: event.output,
                },
                time: { start: part.state.time?.start ?? Date.now() },
              },
            })
          }
          this.publishPart(dbPartId)
          break
        }

        case "subtask_event": {
          this.handleRuntimeSubtaskEvent(event)
          break
        }

        case "tool_call_completed": {
          let dbPartId = partIdMap.get(event.partId)
          let part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "tool") {
            part = this.messages.createPart(sessionId, event.messageId, "tool", {
              callID: event.callId,
              tool: event.tool,
              state: {
                status: "pending",
                input: event.input,
                raw: JSON.stringify(event.input),
                time: { start: Date.now() },
              },
            }) as ToolPart
            dbPartId = part.id
            partIdMap.set(event.partId, part.id)
            this.logger.warn("Recovered OpenCode tool part from a Pi completion without a projected start", {
              sessionId,
              messageId: event.messageId,
              callId: event.callId,
              agentPartId: event.partId,
            })
          }
          const run =
            event.tool === "task"
              ? this.ensureRuntimeSubtask(sessionId, dbPartId, event.callId, event.messageId, event.input)
              : undefined
          const now = Date.now()
          const startTime = part.state.time?.start ?? now
          const updatedState = {
            status: "completed" as const,
            input: Object.keys(event.input).length > 0 ? event.input : part.state.input,
            output: event.output,
            title: event.title,
            metadata: {
              ...(part.state.metadata ?? {}),
              ...this.runtimeSubtaskMetadata(run),
              ...(event.metadata ?? {}),
            },
            time: { start: startTime, end: now },
          }
          this.messages.updatePart(dbPartId, {
            tool: event.tool || part.tool,
            state: updatedState,
          })
          this.publishPart(dbPartId)
          if (run) this.publishRuntimeSubtaskStarted(run)
          if (event.tool === "task") {
            this.finishRuntimeSubtask(sessionId, event.callId, "completed", event.output, undefined, event.metadata)
          }
          break
        }

        case "tool_call_error": {
          let dbPartId = partIdMap.get(event.partId)
          let part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "tool") {
            part = this.messages.createPart(sessionId, event.messageId, "tool", {
              callID: event.callId,
              tool: event.tool,
              state: {
                status: "pending",
                input: event.input,
                raw: JSON.stringify(event.input),
                time: { start: Date.now() },
              },
            }) as ToolPart
            dbPartId = part.id
            partIdMap.set(event.partId, part.id)
            this.logger.warn("Recovered OpenCode tool part from a Pi error without a projected start", {
              sessionId,
              messageId: event.messageId,
              callId: event.callId,
              agentPartId: event.partId,
            })
          }
          const run =
            event.tool === "task"
              ? this.ensureRuntimeSubtask(sessionId, dbPartId, event.callId, event.messageId, event.input)
              : undefined
          const now = Date.now()
          const startTime = part.state.time?.start ?? now
          const updatedState = {
            status: "error" as const,
            input: Object.keys(event.input).length > 0 ? event.input : part.state.input,
            error: event.error,
            metadata: {
              ...(part.state.metadata ?? {}),
              ...this.runtimeSubtaskMetadata(run),
              ...(event.metadata ?? {}),
            },
            time: { start: startTime, end: now },
          }
          this.messages.updatePart(dbPartId, {
            tool: event.tool || part.tool,
            state: updatedState,
          })
          this.publishPart(dbPartId)
          if (run) this.publishRuntimeSubtaskStarted(run)
          if (event.tool === "task") {
            const status = event.metadata?.status === "aborted" ? "aborted" : "failed"
            this.finishRuntimeSubtask(sessionId, event.callId, status, "", event.error, event.metadata)
          }
          break
        }

        case "permission_requested": {
          const permId = event.permissionId
          const now = Date.now()
          const expiresAt = now + 120_000
          this.db
            .prepare(
              "INSERT INTO permissions (id, session_id, tool, input, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
            )
            .run(permId, sessionId, event.tool, JSON.stringify(event.input), now, expiresAt)

          this.events.publish(
            createEvent("permission.asked", {
              id: permId,
              sessionID: sessionId,
              permission: event.tool,
              patterns: [],
              metadata: event.input,
              always: [],
            }),
          )
          break
        }

        case "compaction_started": {
          this.events.publish(
            createEvent("session.compaction.started", {
              sessionID: sessionId,
              reason: event.reason,
              backendReason: event.backendReason,
            }),
          )
          break
        }

        case "compaction_completed": {
          this.events.publish(
            createEvent("session.compaction.completed", {
              sessionID: sessionId,
              reason: event.reason,
              backendReason: event.backendReason,
              result: event.result,
              willRetry: event.willRetry ?? false,
            }),
          )
          this.events.publish(createEvent("session.compacted", { sessionID: sessionId }))
          break
        }

        case "compaction_failed": {
          this.events.publish(
            createEvent("session.compaction.failed", {
              sessionID: sessionId,
              reason: event.reason,
              backendReason: event.backendReason,
              error: event.error,
              aborted: event.aborted ?? false,
              willRetry: event.willRetry ?? false,
            }),
          )
          break
        }

        case "session_busy": {
          this.sessions.setStatus(sessionId, "busy")
          this.publishStatus(sessionId, "busy")
          break
        }

        case "session_retry": {
          // Keep the persisted status busy so reconnecting clients do not see a
          // false idle boundary, while live Desktop clients receive OpenCode's
          // richer retry state and countdown.
          this.sessions.setStatus(sessionId, "busy")
          this.publishStatus(sessionId, {
            type: "retry",
            attempt: event.attempt,
            message: event.message,
            next: event.next,
          })
          break
        }

        case "session_title_changed": {
          const updated = this.sessions.update(sessionId, { title: event.title })
          if (!updated) {
            throw new Error(`Cannot apply backend session title: OpenCode session '${sessionId}' does not exist`)
          }
          this.events.publish(createEvent("session.updated", { sessionID: sessionId, info: updated }))
          break
        }

        case "session_idle": {
          if (this.globalQueue.pendingCount(sessionId) > 1) {
            this.sessions.setStatus(sessionId, "busy")
            this.publishStatus(sessionId, "busy")
            break
          }
          this.sessions.setStatus(sessionId, "idle")
          this.publishStatus(sessionId, "idle")
          this.events.publish(createEvent("session.idle", { sessionID: sessionId }))
          break
        }

        case "session_error": {
          if (event.fatal === false) {
            this.events.publish(
              createEvent("session.error", {
                sessionID: sessionId,
                messageID: event.messageId,
                error: {
                  name: "UnknownError",
                  data: { message: event.error.message },
                },
              }),
            )
            break
          }
          if (!event.messageId) {
            this.sessions.setStatus(sessionId, "idle")
            this.events.publish(
              createEvent("session.error", {
                sessionID: sessionId,
                error: {
                  name: "UnknownError",
                  data: { message: event.error.message },
                },
              }),
            )
            this.publishStatus(sessionId, "idle")
            void this.invalidateRuntime(sessionId, runtime, agentId, "session_error")
            break
          }
          this.flushStreamedMessageParts(event.messageId)
          this.messages.setMessageError(event.messageId, event.error)
          this.sessions.setStatus(sessionId, "idle")
          this.publishMessageParts(event.messageId)
          this.events.publish(
            createEvent("session.error", {
              sessionID: sessionId,
              messageID: event.messageId,
              error: {
                name: "UnknownError",
                data: { message: event.error.message },
              },
            }),
          )
          this.publishMessage(event.messageId)
          this.publishStatus(sessionId, "idle")
          void this.invalidateRuntime(sessionId, runtime, agentId, "session_error")
          break
        }

        case "runtime_fault": {
          // An active prompt rejects immediately after this event, and its catch
          // path owns message finalization and the client-facing error. An idle
          // Runtime has no prompt owner, so publish that fault here.
          if (!event.messageId) {
            this.sessions.setStatus(sessionId, "idle")
            this.events.publish(
              createEvent("session.error", {
                sessionID: sessionId,
                error: {
                  name: "UnknownError",
                  data: { message: event.error.message },
                },
              }),
            )
            this.publishStatus(sessionId, "idle")
          }
          void this.invalidateRuntime(sessionId, runtime, agentId, "runtime_fault")
          break
        }

        case "message_completed": {
          // Older/custom backends can omit text_end/reasoning_end. Flush the
          // in-memory accumulator before closing the message so history and a
          // reconnect see exactly the same content as the live delta stream.
          this.flushStreamedMessageParts(event.messageId)
          if (event.usage) {
            this.messages.updateMessageUsage(event.messageId, event.usage)
          }
          this.messages.completeMessage(event.messageId, event.finish ?? "stop")
          // completeMessage closes any unterminated text/reasoning parts in the
          // database. Publish those snapshots before the terminal message/status
          // events so Desktop cannot retain a local part with no time.end.
          this.publishMessageParts(event.messageId)
          this.publishMessage(event.messageId)
          break
        }

        case "session_started":
        case "session_stopped":
          this.logger.debug("Agent Runtime lifecycle event has no OpenCode projection", {
            type: event.type,
            sessionId,
          })
          break

        default:
          this.logger.warn("Agent event produced no OpenCode event", {
            sessionId,
            agentEvent: (event as { type: string }).type,
            stage: "opencode_projection",
            reason: "AgentService has no projection for this AgentRuntimeEvent",
          })
      }
    } catch (error) {
      throw error
    }
  }

  private handleAgentEventProjectionError(
    sessionId: string,
    _runtime: AgentRuntime,
    _agentId: string,
    event: AgentRuntimeEvent,
    error: unknown,
  ): void {
    const messageId = "messageId" in event && typeof event.messageId === "string" ? event.messageId : undefined
    try {
      if (messageId) {
        this.flushStreamedMessageParts(messageId)
        this.messages.setMessageError(messageId, {
          type: "event_projection_error",
          message: error instanceof Error ? error.message : String(error),
        })
        this.publishMessageParts(messageId)
        this.publishMessage(messageId)
      }
      this.sessions.setStatus(sessionId, "idle")
      this.events.publish(
        createEvent("session.error", {
          sessionID: sessionId,
          ...(messageId ? { messageID: messageId } : {}),
          error: {
            name: "UnknownError",
            data: {
              message: `Failed to persist an agent event: ${error instanceof Error ? error.message : String(error)}`,
            },
          },
        }),
      )
      this.publishStatus(sessionId, "idle")
    } catch (recoveryError) {
      this.logger.error("Could not persist agent event projection failure", {
        sessionId,
        type: event.type,
        error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      })
    }
  }
}
