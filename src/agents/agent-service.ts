import type { AgentAdapterRegistry } from "../agents/registry.ts"
import { RuntimePool } from "../runtime/runtime-pool.ts"
import type { SessionRepository } from "../session/index.ts"
import type { AssistantMessage, MessageRepository, Part, ToolPart } from "../message/index.ts"
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
import type { SkillCatalogSnapshot, SkillService } from "../skill/skill-service.ts"
import { SubtaskManager, type SubtaskResult } from "../agents/subtask-manager.ts"
import { subagentSessionTitle } from "./subagents/subagent-session.ts"
import { AssistantPartProjector } from "./assistant-part-projector.ts"
import type { SessionEventStore } from "../event/session-event-store.ts"
import {
  publishMessageRemovedLegacy,
  publishSessionCompactedLegacy,
  publishSessionErrorLegacy,
  publishSessionIdleLegacy,
  publishSessionStatusLegacy,
} from "../event/session-events-legacy.ts"
import { eventIdForMessageId } from "../id/index.ts"

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

interface SubtaskPrompt {
  prompt: string
  description: string
  agent: string
  model?: AgentModel
}

interface SubtaskExecution {
  request: SubtaskPrompt
  toolPart: ToolPart
  assistantMessageId: string
  handle?: ReturnType<SubtaskManager["start"]>
  startError?: string
}

interface SubtaskOutcome {
  text: string
  status: SubtaskResult["status"]
  childSessionId: string | null
  usage?: SubtaskResult["usage"]
}

interface PendingCompactionProjection {
  compactionMessageId: string
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
  private readonly skills: SkillService
  private readonly sessionEvents: SessionEventStore
  private readonly globalQueue = new SessionQueue()
  private readonly partIdMap = new Map<string, Map<string, string>>()
  /**
   * OpenCode streams text deltas from memory and persists the complete part at
   * the block boundary. Rewriting the entire JSON part synchronously for every
   * provider token stalls the runtime's event reader and turns a short burst into an
   * increasingly expensive O(n²) database workload.
   */
  private readonly streamedPartText = new Map<string, string>()
  private readonly assistantParts: AssistantPartProjector
  private readonly subtaskManager: SubtaskManager
  private readonly sessionModels = new Map<string, AgentModel>()
  private readonly sessionRuntimeAdapters = new Map<string, string>()
  private readonly sessionRuntimeRevisions = new Map<string, string | number | undefined>()
  private readonly abortedSessions = new Set<string>()
  private readonly titleJobs = new Set<string>()
  private readonly runtimeSubtasks = new Map<string, RuntimeSubtask>()
  private readonly pendingStarts = new Map<string, Set<ReturnType<typeof setTimeout>>>()
  private readonly pendingCompactions = new Map<string, PendingCompactionProjection>()
  private readonly startedAssistantSteps = new Set<string>()
  private readonly recoveredAssistantSteps = new Set<string>()
  private readonly settledAssistantSteps = new Set<string>()
  private readonly startedContentParts = new Set<string>()
  private readonly endedContentParts = new Set<string>()
  private readonly startedToolInputs = new Set<string>()
  private readonly calledTools = new Set<string>()
  private readonly settledTools = new Set<string>()
  private readonly activeExecutions = new Set<string>()
  private suppressCurrentEventBroadcast = false

  constructor(
    registry: AgentAdapterRegistry,
    sessions: SessionRepository,
    messages: MessageRepository,
    events: EventBus,
    logger: Logger,
    config: AppConfig,
    skills: SkillService,
    sessionEvents: SessionEventStore,
    options?: { encapsulateMessageParts?: boolean },
  ) {
    this.registry = registry
    this.sessions = sessions
    this.messages = messages
    this.events = events
    this.logger = logger
    this.config = config
    this.skills = skills
    this.sessionEvents = sessionEvents

    this.assistantParts = new AssistantPartProjector(messages, {
      encapsulateParts: options?.encapsulateMessageParts,
    })
    this.subtaskManager = new SubtaskManager(
      registry,
      sessions,
      messages,
      events,
      logger,
      config,
      this.assistantParts,
      {
        childStarted: (sessionId, userMessageId, prompt, assistantMessageId) => {
          const user = this.messages.getMessage(userMessageId)
          this.publishCurrentSessionEvent(
            sessionId,
            "session.input.admitted",
            {
              sessionID: sessionId,
              inputID: userMessageId,
              input: { type: "user", delivery: "steer", data: { text: prompt } },
            },
            { created: user?.time.created ?? Date.now() },
          )
          this.publishCurrentSessionEvent(sessionId, "session.input.promoted", {
            sessionID: sessionId,
            inputID: userMessageId,
          })
          this.startExecution(sessionId)
          this.startAssistantStep(assistantMessageId)
        },
        runtimeEvent: (event, sessionId, assistantMessageId) => {
          const retargeted = retargetRuntimeEvent(event, sessionId, assistantMessageId)
          if (
            retargeted.type === "session_busy" ||
            retargeted.type === "session_idle" ||
            retargeted.type === "session_started" ||
            retargeted.type === "session_stopped"
          ) {
            return
          }
          if (retargeted.type === "session_error" && retargeted.fatal !== false) {
            this.projectManagedSubtaskError(retargeted)
            return
          }
          this.handleAgentEvent(retargeted, sessionId)
        },
        parentToolProgress: (partId, metadata) => this.projectToolProgress(partId, metadata),
        parentToolOutput: (partId, delta) => this.appendToolOutput(partId, delta),
        childSettled: (sessionId, messageIds, terminalMessageId, status, error) => {
          for (const messageId of messageIds) this.publishUnterminatedContent(messageId)
          this.settleAssistantSteps(messageIds)
          this.settleExecution(
            sessionId,
            status === "completed"
              ? "session.execution.succeeded"
              : status === "aborted"
                ? "session.execution.interrupted"
                : "session.execution.failed",
            error ? { error: { type: "unknown", message: error } } : {},
          )
          publishSessionIdleLegacy(this.events, sessionId)
          this.clearProjectionTracking(sessionId)
        },
      },
    )
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
    subtaskParts: SubtaskPrompt[],
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

  private async restartRuntimeIfConfigurationChanged(
    sessionId: string,
    adapter: AgentAdapter,
    model: AgentModel | undefined,
    pool: RuntimePool,
    directory: string,
    skills: SkillCatalogSnapshot,
  ): Promise<void> {
    const current = this.sessionModels.get(sessionId)
    const currentAdapterId = this.sessionRuntimeAdapters.get(sessionId)
    const currentRevision = this.sessionRuntimeRevisions.get(sessionId)
    const modelChanged = Boolean(
      model && (!current || current.providerID !== model.providerID || current.modelID !== model.modelID),
    )
    const nextRevision = adapter.getRuntimeRevision?.({ model, directory, skills })
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
    await this.globalQueue.run(sessionId, async () => {
      this.abortedSessions.delete(sessionId)
      await this.executePrompt(sessionId, text, userMessageId, assistantMessageId, model)
    })
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

      const skills = await this.skills.snapshot(current.directory)
      await this.restartRuntimeIfConfigurationChanged(
        sessionId,
        adapter,
        selectedModel,
        pool,
        current.directory,
        skills,
      )
      const runtime = await pool.getOrCreate({
        sessionId,
        directory: current.directory,
        logger: this.logger.child({ sessionId, agent: current.agent }),
        config: await this.runtimeConfig(adapter, selectedModel),
        skills,
      })
      if (!runtime.compact) {
        throw new Error(`Agent '${current.agent}' does not support session compaction`)
      }
      this.sessions.setStatus(sessionId, "busy")
      this.startExecution(sessionId)
      try {
        const result = await runtime.compact({ customInstructions })
        this.settleExecution(sessionId, "session.execution.succeeded")
        return result
      } catch (error) {
        this.settleExecution(sessionId, "session.execution.failed", {
          error: { type: "unknown", message: error instanceof Error ? error.message : String(error) },
        })
        throw error
      } finally {
        this.sessions.setStatus(sessionId, "idle")
        pool.scheduleIdleCheck(sessionId)
        publishSessionIdleLegacy(this.events, sessionId)
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
    const skills = await this.skills.snapshot(session.directory)
    await this.restartRuntimeIfConfigurationChanged(sessionId, adapter, model, pool, session.directory, skills)
    const runtime = await pool.getOrCreate({
      sessionId,
      directory: session.directory,
      logger: this.logger.child({ sessionId, agent: session.agent }),
      config: await this.runtimeConfig(adapter, model),
      skills,
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

  async createSessionFork(sourceSessionId: string, targetSessionId: string, messageId?: string): Promise<void> {
    await this.globalQueue.run(sourceSessionId, async () => {
      const source = this.sessions.get(sourceSessionId)
      if (!source) throw new AgentConversationError(`Session not found: ${sourceSessionId}`, 404)
      const target = this.sessions.get(targetSessionId)
      if (!target) throw new AgentConversationError(`Session not found: ${targetSessionId}`, 404)
      if (["busy", "running", "waiting_permission"].includes(source.status)) {
        throw new AgentConversationError("Session is busy", 409)
      }

      const { runtime, pool } = await this.getConversationRuntime(sourceSessionId)
      if (!runtime.createSessionFork) {
        throw new AgentConversationError(`Agent '${source.agent}' does not support session forks`)
      }
      try {
        await runtime.createSessionFork({ targetSessionId, ...(messageId ? { messageId } : {}) })
      } catch (error) {
        await pool.invalidate(sourceSessionId, runtime, "session_fork_failed")
        throw new AgentConversationError(error instanceof Error ? error.message : String(error))
      }
      pool.scheduleIdleCheck(sourceSessionId)
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
        publishMessageRemovedLegacy(this.events, sessionId, removedMessageId)
      }
      if (updated) {
        this.events.publish(createEvent("session.updated", { sessionID: sessionId, info: updated }))
      }
      pool.scheduleIdleCheck(sessionId)
    })
  }

  private async executePrompt(
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
      const skills = await this.skills.snapshot(session.directory)
      await this.restartRuntimeIfConfigurationChanged(sessionId, adapter, model, pool, session.directory, skills)

      const runtime = await pool.getOrCreate({
        sessionId,
        directory: session.directory,
        logger: this.logger.child({ sessionId, agent: agentId }),
        config: await this.runtimeConfig(adapter, model),
        skills,
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
      this.logger.error("Agent prompt failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      this.sessions.setStatus(sessionId, "idle")
      const failed = this.assistantParts.fail(assistantMessageId, {
        type: "agent_error",
        message: err instanceof Error ? err.message : String(err),
      })
      for (const messageId of failed.messageIds) this.publishUnterminatedContent(messageId)
      this.settleAssistantSteps(failed.messageIds)
      this.settleExecution(sessionId, "session.execution.failed", {
        error: { type: "unknown", message: err instanceof Error ? err.message : String(err) },
      })
      publishSessionErrorLegacy(this.events, {
        sessionID: sessionId,
        messageID: failed.terminalMessageId,
        error: {
          name: "UnknownError",
          data: { message: err instanceof Error ? err.message : String(err) },
        },
      })
      this.releaseSessionProjection(sessionId)
    }
  }

  async promptWithSubtasks(
    sessionId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    subtaskParts: SubtaskPrompt[],
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
      const failed = this.assistantParts.fail(assistantMessageId, {
        type: "agent_error",
        message: err instanceof Error ? err.message : String(err),
      })
      for (const messageId of failed.messageIds) this.publishUnterminatedContent(messageId)
      this.settleAssistantSteps(failed.messageIds)
      this.settleExecution(sessionId, "session.execution.failed", {
        error: { type: "unknown", message: err instanceof Error ? err.message : String(err) },
      })
      this.releaseSessionProjection(sessionId)
    }
  }

  private createToolPartForSubtask(
    sessionId: string,
    userMessageId: string,
    st: SubtaskPrompt,
  ): { toolPart: ToolPart; subAssistantMsg: { id: string } } {
    const subAssistantMsg = this.messages.createAssistantMessage(sessionId, userMessageId, st.agent)

    const callID = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
    const toolInput = { prompt: st.prompt, description: st.description, subagent_type: st.agent }
    const toolPart = this.assistantParts.createPart(sessionId, subAssistantMsg.id, "tool", {
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

    this.publishToolInputStarted(toolPart)
    this.publishToolCalled(toolPart, toolInput)

    return { toolPart, subAssistantMsg }
  }

  private startSubtaskExecution(sessionId: string, userMessageId: string, request: SubtaskPrompt): SubtaskExecution {
    const { toolPart, subAssistantMsg } = this.createToolPartForSubtask(sessionId, userMessageId, request)
    try {
      return {
        request,
        toolPart,
        assistantMessageId: subAssistantMsg.id,
        handle: this.subtaskManager.start({
          parentSessionId: sessionId,
          parentToolPartId: toolPart.id,
          parentAssistantMessageId: subAssistantMsg.id,
          prompt: request.prompt,
          description: request.description,
          agent: request.agent,
          model: request.model,
        }),
      }
    } catch (error) {
      const startError = error instanceof Error ? error.message : String(error)
      this.logger.error("Subtask failed to start", { agent: request.agent, error: startError })
      return { request, toolPart, assistantMessageId: subAssistantMsg.id, startError }
    }
  }

  private async settleSubtask(execution: SubtaskExecution): Promise<SubtaskOutcome> {
    if (!execution.handle) {
      return {
        text: `Error: ${execution.startError ?? "Subtask did not start"}`,
        status: "failed",
        childSessionId: null,
      }
    }
    try {
      const result = await execution.handle.result
      return {
        text: result.output ?? (result.error ? `Error: ${result.error.message}` : ""),
        status: result.status,
        childSessionId: execution.handle.childSessionId,
        usage: result.usage,
      }
    } catch (error) {
      return {
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        status: "failed",
        childSessionId: execution.handle.childSessionId,
      }
    }
  }

  private finalizeSubtaskExecution(sessionId: string, execution: SubtaskExecution, outcome: SubtaskOutcome): void {
    this.finalizeToolPart(
      sessionId,
      execution.toolPart,
      execution.assistantMessageId,
      outcome.childSessionId,
      execution.request.agent,
      execution.request.description,
      outcome.text,
      outcome.status,
      outcome.usage,
    )
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
    const updated = this.messages.getPart(toolPart.id)
    if (!updated || updated.type !== "tool") throw new Error(`Tool part not found: ${toolPart.id}`)
    if (subStatus === "completed") this.publishToolSuccess(updated, subText, updatedState.metadata)
    else this.publishToolFailed(updated, subText, updatedState.metadata)

    this.messages.completeMessage(subAssistantMsgId, subStatus === "completed" ? "stop" : "error")
    this.settleAssistantStep(subAssistantMsgId)
  }

  private async runSequentialSubtasks(
    sessionId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    subtaskParts: SubtaskPrompt[],
    parentModel?: { providerID: string; modelID: string },
  ): Promise<void> {
    const subtaskResults: string[] = []

    for (const request of subtaskParts) {
      const execution = this.startSubtaskExecution(sessionId, userMessageId, request)
      const outcome = await this.settleSubtask(execution)
      subtaskResults.push(outcome.text)
      this.finalizeSubtaskExecution(sessionId, execution, outcome)
    }

    await this.finishParentPrompt(sessionId, text, userMessageId, assistantMessageId, subtaskResults, parentModel)
  }

  private async runParallelSubtasks(
    sessionId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    subtaskParts: SubtaskPrompt[],
    parentModel?: { providerID: string; modelID: string },
  ): Promise<void> {
    const executions = subtaskParts.map((request) => this.startSubtaskExecution(sessionId, userMessageId, request))
    const outcomes = await Promise.all(executions.map((execution) => this.settleSubtask(execution)))

    const subtaskResults: string[] = []
    for (let index = 0; index < executions.length; index++) {
      const execution = executions[index]!
      const outcome = outcomes[index]!
      subtaskResults.push(outcome.text)
      this.finalizeSubtaskExecution(sessionId, execution, outcome)
    }

    await this.finishParentPrompt(sessionId, text, userMessageId, assistantMessageId, subtaskResults, parentModel)
  }

  private async runChainSubtasks(
    sessionId: string,
    text: string,
    userMessageId: string,
    assistantMessageId: string,
    subtaskParts: SubtaskPrompt[],
    parentModel?: { providerID: string; modelID: string },
  ): Promise<void> {
    const subtaskResults: string[] = []
    let previousOutput = ""

    for (const request of subtaskParts) {
      const execution = this.startSubtaskExecution(sessionId, userMessageId, {
        ...request,
        prompt: request.prompt.replace(/\{previous\}/g, previousOutput),
      })
      const outcome = await this.settleSubtask(execution)
      subtaskResults.push(outcome.text)
      this.finalizeSubtaskExecution(sessionId, execution, outcome)
      if (outcome.status !== "completed") break
      previousOutput = outcome.text
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
      this.messages.completeMessage(assistantMessageId, "aborted")
      this.settleAssistantStep(assistantMessageId)
      this.settleExecution(sessionId, "session.execution.interrupted")
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
      await this.executePrompt(sessionId, effectiveText, userMessageId, assistantMessageId, model)
    } else {
      this.sessions.setStatus(sessionId, "idle")
      publishSessionIdleLegacy(this.events, sessionId)
      this.messages.completeMessage(assistantMessageId, "stop")
      this.settleAssistantStep(assistantMessageId)
      this.settleExecution(sessionId, "session.execution.succeeded")
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
    this.settleExecution(sessionId, "session.execution.interrupted")
    publishSessionIdleLegacy(this.events, sessionId)
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
    this.releaseSessionProjection(sessionId)
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
    this.assistantParts.clear()
  }

  recoverOnStartup(): void {
    this.subtaskManager.recoverOnStartup()

    const orphanedTools = this.messages.recoverOpenToolParts(
      "The server restarted before the agent emitted a terminal tool result.",
    )

    // No agent runtime survives a server restart. Any incomplete assistant message
    // is therefore orphaned, even when an older build happened to persist the
    // session itself as idle before it crashed.
    const openMessages = this.messages.recoverOpenAssistantMessages(
      "The server restarted before the agent turn reached a terminal state.",
    )

    // Persisted parent sessions left busy would otherwise make Desktop render
    // "thinking" forever, even though no process can publish a future idle event.
    const orphanedSessions = this.sessions
      .listByStatuses(["running", "busy", "waiting_permission"])
      .filter((session) => !session.parentID)
    for (const session of orphanedSessions) {
      this.sessions.setStatus(session.id, "idle")
    }
    this.suppressCurrentEventBroadcast = true
    try {
      for (const session of this.sessions.list()) this.recoverDurableLifecycle(session.id)
    } finally {
      this.suppressCurrentEventBroadcast = false
    }
    if (openMessages > 0 || orphanedTools > 0 || orphanedSessions.length > 0) {
      this.logger.warn("Recovered orphaned runtime state on startup", {
        openMessages,
        openTools: orphanedTools,
        busySessions: orphanedSessions.length,
      })
    }
  }

  private recoverDurableLifecycle(sessionId: string): void {
    const events = this.sessionEvents.listByTypes(sessionId, [
      "session.execution.started",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.step.started",
      "session.step.ended",
      "session.step.failed",
      "session.text.started",
      "session.text.ended",
      "session.reasoning.started",
      "session.reasoning.ended",
      "session.tool.input.started",
      "session.tool.called",
      "session.tool.success",
      "session.tool.failed",
    ])
    if (events.length === 0) return

    const key = (data: Record<string, unknown>) => `${data.assistantMessageID ?? ""}:${data.callID ?? ""}`
    const contentKey = (data: Record<string, unknown>, type: string) =>
      `${type}:${data.assistantMessageID ?? ""}:${data.ordinal ?? ""}`
    const terminalSteps = new Set(
      events
        .filter((event) => event.type === "session.step.ended" || event.type === "session.step.failed")
        .map((event) => String(event.data.assistantMessageID ?? "")),
    )
    const startedSteps = new Set(
      events
        .filter((event) => event.type === "session.step.started")
        .map((event) => String(event.data.assistantMessageID ?? "")),
    )
    const terminalTools = new Set(
      events
        .filter((event) => event.type === "session.tool.success" || event.type === "session.tool.failed")
        .map((event) => key(event.data)),
    )
    const inputStartedTools = new Set(
      events.filter((event) => event.type === "session.tool.input.started").map((event) => key(event.data)),
    )
    const calledTools = new Set(
      events.filter((event) => event.type === "session.tool.called").map((event) => key(event.data)),
    )
    const startedContent = new Set(
      events
        .filter((event) => event.type === "session.text.started" || event.type === "session.reasoning.started")
        .map((event) => contentKey(event.data, event.type.includes("text") ? "text" : "reasoning")),
    )
    const endedContent = new Set(
      events
        .filter((event) => event.type === "session.text.ended" || event.type === "session.reasoning.ended")
        .map((event) => contentKey(event.data, event.type.includes("text") ? "text" : "reasoning")),
    )

    for (const item of this.messages.listMessages(sessionId)) {
      if (item.info.role !== "assistant") continue
      const ordinals = { text: 0, reasoning: 0 }
      for (const part of item.parts) {
        if (part.type === "text" || part.type === "reasoning") {
          const ordinal = ordinals[part.type]++
          const persistedKey = `${part.type}:${part.messageID}:${ordinal}`
          if (startedContent.has(persistedKey)) this.startedContentParts.add(part.id)
          if (endedContent.has(persistedKey)) this.endedContentParts.add(part.id)
          if (startedContent.has(persistedKey) && !endedContent.has(persistedKey)) {
            this.publishContentEnded(part, part.text)
          }
          continue
        }
        if (part.type !== "tool") continue
        const persistedKey = `${part.messageID}:${part.callID}`
        if (inputStartedTools.has(persistedKey)) this.startedToolInputs.add(part.id)
        if (calledTools.has(persistedKey)) this.calledTools.add(part.id)
        if (terminalTools.has(persistedKey)) this.settledTools.add(part.id)
        if (
          (inputStartedTools.has(persistedKey) || calledTools.has(persistedKey)) &&
          !terminalTools.has(persistedKey)
        ) {
          this.projectToolTerminal(part.id)
        }
      }

      if (startedSteps.has(item.info.id) && !terminalSteps.has(item.info.id)) {
        this.startAssistantStep(item.info.id)
        this.settleAssistantStep(item.info.id)
      }
    }

    const lastExecutionStart = events.findLast((event) => event.type === "session.execution.started")
    const lastExecutionTerminal = events.findLast(
      (event) =>
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted",
    )
    if (
      lastExecutionStart &&
      (!lastExecutionTerminal || lastExecutionTerminal.durable.seq < lastExecutionStart.durable.seq)
    ) {
      this.publishCurrentSessionEvent(sessionId, "session.execution.interrupted", {
        sessionID: sessionId,
        reason: "shutdown",
      })
    }
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

  private flushProjectedMessageParts(messageId: string): void {
    for (const projectedMessageId of this.assistantParts.messageIds(messageId)) {
      this.flushStreamedMessageParts(projectedMessageId)
    }
  }

  private clearProjectionTracking(sessionId: string): void {
    for (const message of this.messages.listMessages(sessionId)) {
      this.startedAssistantSteps.delete(message.info.id)
      this.recoveredAssistantSteps.delete(message.info.id)
      this.settledAssistantSteps.delete(message.info.id)
      for (const part of message.parts) {
        this.streamedPartText.delete(part.id)
        this.startedContentParts.delete(part.id)
        this.endedContentParts.delete(part.id)
        this.startedToolInputs.delete(part.id)
        this.calledTools.delete(part.id)
        this.settledTools.delete(part.id)
      }
    }
    this.partIdMap.delete(sessionId)
    this.activeExecutions.delete(sessionId)
  }

  private releaseSessionProjection(sessionId: string): void {
    this.assistantParts.releaseSession(sessionId)
    this.clearProjectionTracking(sessionId)
  }

  private publishCurrentSessionEvent(
    sessionId: string,
    type: string,
    data: Record<string, unknown>,
    options?: { id?: string; created?: number; metadata?: Record<string, unknown>; version?: number },
  ): ReturnType<SessionEventStore["append"]> {
    const session = this.sessions.get(sessionId)
    const event = this.sessionEvents.append(
      sessionId,
      type,
      data,
      session ? { directory: session.directory } : undefined,
      options,
    )
    if (!this.suppressCurrentEventBroadcast) {
      this.events.publish(
        {
          id: event.id,
          created: event.created,
          type: event.type,
          metadata: event.metadata,
          durable: event.durable,
          properties: event.data,
        },
        session?.directory,
      )
    }
    return event
  }

  private publishLiveCurrentSessionEvent(
    sessionId: string,
    type: string,
    data: Record<string, unknown>,
    created = Date.now(),
  ): void {
    const session = this.sessions.get(sessionId)
    const event = createEvent(type, data)
    event.created = created
    this.events.publish(event, session?.directory)
  }

  private requireAssistantMessage(messageId: string): AssistantMessage {
    const message = this.messages.getMessage(messageId)
    if (!message || message.role !== "assistant") throw new Error(`Assistant message not found: ${messageId}`)
    return message
  }

  private activeAssistantMessageId(sessionId: string): string | undefined {
    return this.messages
      .listMessages(sessionId)
      .map((item) => item.info)
      .findLast((message): message is AssistantMessage => message.role === "assistant" && !message.time.completed)?.id
  }

  private contentOrdinal(part: Extract<Part, { type: "text" | "reasoning" }>): number {
    const ordinal = this.messages
      .listParts(part.messageID)
      .filter((item) => item.type === part.type)
      .findIndex((item) => item.id === part.id)
    if (ordinal < 0) throw new Error(`Cannot determine ${part.type} ordinal for part '${part.id}'`)
    return ordinal
  }

  startAssistantStep(messageId: string): void {
    if (this.startedAssistantSteps.has(messageId)) return
    const message = this.requireAssistantMessage(messageId)
    const eventId = eventIdForMessageId(message.id)
    const existing = this.sessionEvents.getById(eventId)
    if (existing) {
      if (
        existing.durable.aggregateID !== message.sessionID ||
        existing.type !== "session.step.started" ||
        existing.data.assistantMessageID !== message.id
      ) {
        throw new Error(
          `Session event ID '${eventId}' is already used by '${existing.type}' in session '${existing.durable.aggregateID}'`,
        )
      }
      this.startedAssistantSteps.add(messageId)
      this.recoveredAssistantSteps.add(messageId)
      return
    }
    this.startedAssistantSteps.add(messageId)
    try {
      this.publishCurrentSessionEvent(
        message.sessionID,
        "session.step.started",
        {
          sessionID: message.sessionID,
          assistantMessageID: message.id,
          agent: message.agent,
          model: { id: message.modelID, providerID: message.providerID },
        },
        { id: eventId, created: message.time.created },
      )
    } catch (error) {
      this.startedAssistantSteps.delete(messageId)
      throw error
    }
  }

  startExecution(sessionId: string): void {
    if (this.activeExecutions.has(sessionId)) return
    this.activeExecutions.add(sessionId)
    this.publishCurrentSessionEvent(sessionId, "session.execution.started", { sessionID: sessionId })
  }

  private settleExecution(
    sessionId: string,
    type: "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted",
    data: Record<string, unknown> = {},
  ): void {
    if (!this.activeExecutions.delete(sessionId)) return
    this.publishCurrentSessionEvent(sessionId, type, {
      sessionID: sessionId,
      ...(type === "session.execution.interrupted" && !("reason" in data) ? { reason: "user" } : {}),
      ...data,
    })
  }

  settleAssistantMessage(messageId: string): void {
    this.settleAssistantStep(messageId)
  }

  projectToolRunning(partId: string): void {
    const part = this.messages.getPart(partId)
    if (!part || part.type !== "tool") throw new Error(`Tool part not found: ${partId}`)
    const input = "input" in part.state && part.state.input ? part.state.input : {}
    this.publishToolInputStarted(part)
    this.publishToolCalled(part, input)
  }

  projectToolProgress(partId: string, metadata: Record<string, unknown>): void {
    const part = this.messages.getPart(partId)
    if (!part || part.type !== "tool") throw new Error(`Tool part not found: ${partId}`)
    this.publishToolProgress(part, metadata)
  }

  appendToolOutput(partId: string, delta: string): void {
    const part = this.messages.getPart(partId)
    if (!part || part.type !== "tool") throw new Error(`Tool part not found: ${partId}`)
    const output = `${part.state.output ?? ""}${delta}`
    const metadata = { ...(part.state.metadata ?? {}), output, partialOutput: output }
    this.messages.updatePart(partId, { state: { ...part.state, output, metadata } })
    const current = this.messages.getPart(partId)
    if (current?.type === "tool") this.publishToolProgress(current, metadata)
  }

  projectToolTerminal(partId: string): void {
    const part = this.messages.getPart(partId)
    if (!part || part.type !== "tool") throw new Error(`Tool part not found: ${partId}`)
    if (part.state.status === "completed") {
      this.publishToolSuccess(part, part.state.output ?? "", part.state.metadata)
      return
    }
    if (part.state.status === "error" || part.state.status === "aborted") {
      this.publishToolFailed(part, part.state.error ?? "Tool execution failed", part.state.metadata)
    }
  }

  succeedExecution(sessionId: string): void {
    this.settleExecution(sessionId, "session.execution.succeeded")
  }

  failExecution(sessionId: string, message: string): void {
    this.settleExecution(sessionId, "session.execution.failed", {
      error: { type: "unknown", message },
    })
  }

  private publishContentStarted(part: Extract<Part, { type: "text" | "reasoning" }>): void {
    if (this.startedContentParts.has(part.id)) return
    this.startedContentParts.add(part.id)
    this.startAssistantStep(part.messageID)
    const ordinal = this.contentOrdinal(part)
    this.publishCurrentSessionEvent(
      part.sessionID,
      part.type === "text" ? "session.text.started" : "session.reasoning.started",
      {
        sessionID: part.sessionID,
        assistantMessageID: part.messageID,
        ordinal,
      },
      { created: part.time?.start ?? Date.now() },
    )
  }

  private publishContentDelta(part: Extract<Part, { type: "text" | "reasoning" }>, delta: string): void {
    this.publishLiveCurrentSessionEvent(
      part.sessionID,
      part.type === "text" ? "session.text.delta" : "session.reasoning.delta",
      {
        sessionID: part.sessionID,
        assistantMessageID: part.messageID,
        ordinal: this.contentOrdinal(part),
        delta,
      },
    )
  }

  private publishContentEnded(part: Extract<Part, { type: "text" | "reasoning" }>, text: string): void {
    if (this.endedContentParts.has(part.id)) return
    this.endedContentParts.add(part.id)
    this.publishCurrentSessionEvent(
      part.sessionID,
      part.type === "text" ? "session.text.ended" : "session.reasoning.ended",
      {
        sessionID: part.sessionID,
        assistantMessageID: part.messageID,
        ordinal: this.contentOrdinal(part),
        text,
      },
      { created: part.time?.end ?? Date.now() },
    )
  }

  private publishToolInputStarted(part: ToolPart): void {
    if (this.startedToolInputs.has(part.id)) return
    this.startedToolInputs.add(part.id)
    this.startAssistantStep(part.messageID)
    this.publishCurrentSessionEvent(
      part.sessionID,
      "session.tool.input.started",
      {
        sessionID: part.sessionID,
        assistantMessageID: part.messageID,
        callID: part.callID,
        name: part.tool,
      },
      { created: part.state.time?.start ?? Date.now() },
    )
  }

  private publishToolCalled(part: ToolPart, input: Record<string, unknown>): void {
    this.publishToolInputStarted(part)
    if (this.calledTools.has(part.id)) return
    this.calledTools.add(part.id)
    this.publishCurrentSessionEvent(part.sessionID, "session.tool.input.ended", {
      sessionID: part.sessionID,
      assistantMessageID: part.messageID,
      callID: part.callID,
      text: JSON.stringify(input),
    })
    this.publishCurrentSessionEvent(part.sessionID, "session.tool.called", {
      sessionID: part.sessionID,
      assistantMessageID: part.messageID,
      callID: part.callID,
      input,
      executed: true,
    })
  }

  private publishToolInputDelta(part: ToolPart, delta: string): void {
    this.publishToolInputStarted(part)
    this.publishLiveCurrentSessionEvent(part.sessionID, "session.tool.input.delta", {
      sessionID: part.sessionID,
      assistantMessageID: part.messageID,
      callID: part.callID,
      delta,
    })
  }

  private publishToolProgress(part: ToolPart, metadata: Record<string, unknown>): void {
    const input = "input" in part.state && part.state.input ? part.state.input : {}
    this.publishToolCalled(part, input)
    this.publishLiveCurrentSessionEvent(part.sessionID, "session.tool.progress", {
      sessionID: part.sessionID,
      assistantMessageID: part.messageID,
      callID: part.callID,
      metadata,
    })
  }

  private publishToolSuccess(part: ToolPart, output: string, metadata?: Record<string, unknown>): void {
    if (this.settledTools.has(part.id)) return
    const input = "input" in part.state && part.state.input ? part.state.input : {}
    this.publishToolCalled(part, input)
    this.settledTools.add(part.id)
    this.publishCurrentSessionEvent(
      part.sessionID,
      "session.tool.success",
      {
        sessionID: part.sessionID,
        assistantMessageID: part.messageID,
        callID: part.callID,
        content: [{ type: "text", text: output }],
        metadata: metadata ?? {},
        executed: true,
      },
      { created: part.state.time?.end ?? Date.now(), version: 2 },
    )
  }

  private publishToolFailed(part: ToolPart, error: string, metadata?: Record<string, unknown>): void {
    if (this.settledTools.has(part.id)) return
    const input = "input" in part.state && part.state.input ? part.state.input : {}
    this.publishToolCalled(part, input)
    this.settledTools.add(part.id)
    this.publishCurrentSessionEvent(
      part.sessionID,
      "session.tool.failed",
      {
        sessionID: part.sessionID,
        assistantMessageID: part.messageID,
        callID: part.callID,
        error: { type: "unknown", message: error },
        metadata: metadata ?? {},
        executed: true,
      },
      { created: part.state.time?.end ?? Date.now(), version: 2 },
    )
  }

  private publishUnterminatedContent(messageId: string): void {
    for (const part of this.messages.listParts(messageId)) {
      if (part.type !== "text" && part.type !== "reasoning") continue
      if (this.endedContentParts.has(part.id)) continue
      this.publishContentStarted(part)
      this.publishContentEnded(part, part.text)
    }
  }

  private settleAssistantStep(messageId: string): void {
    if (this.settledAssistantSteps.has(messageId)) return
    const message = this.requireAssistantMessage(messageId)
    this.startAssistantStep(messageId)
    if (this.recoveredAssistantSteps.has(messageId)) {
      const existing = this.sessionEvents
        .listByTypes(message.sessionID, ["session.step.ended", "session.step.failed"])
        .find((event) => event.data.assistantMessageID === message.id)
      if (existing) {
        this.settledAssistantSteps.add(messageId)
        return
      }
    }
    this.publishUnterminatedContent(messageId)
    this.settledAssistantSteps.add(messageId)
    if (message.error) {
      this.publishCurrentSessionEvent(
        message.sessionID,
        "session.step.failed",
        {
          sessionID: message.sessionID,
          assistantMessageID: message.id,
          error: { type: "unknown", message: message.error.data.message },
          cost: message.cost,
          tokens: message.tokens,
        },
        { created: message.time.completed ?? Date.now() },
      )
      return
    }
    this.publishCurrentSessionEvent(
      message.sessionID,
      "session.step.ended",
      {
        sessionID: message.sessionID,
        assistantMessageID: message.id,
        finish: normalizeStepFinish(message.finish),
        cost: message.cost,
        tokens: message.tokens,
      },
      { created: message.time.completed ?? Date.now() },
    )
  }

  private settleAssistantSteps(messageIds: readonly string[]): void {
    for (const messageId of messageIds) this.settleAssistantStep(messageId)
  }

  private projectManagedSubtaskError(event: Extract<AgentRuntimeEvent, { type: "session_error" }>): void {
    if (!event.messageId) return
    this.flushProjectedMessageParts(event.messageId)
    const failed = this.assistantParts.fail(event.messageId, event.error, event.usage)
    for (const messageId of failed.messageIds) this.publishUnterminatedContent(messageId)
    this.settleAssistantSteps(failed.messageIds)
    this.settleExecution(event.sessionId, "session.execution.failed", {
      error: { type: "unknown", message: event.error.message },
    })
    publishSessionErrorLegacy(this.events, {
      sessionID: event.sessionId,
      messageID: failed.terminalMessageId,
      error: { name: "UnknownError", data: { message: event.error.message } },
    })
  }

  private startCompactionProjection(
    sessionId: string,
    reason: "auto" | "manual",
    backendReason: string,
  ): PendingCompactionProjection | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const existing = this.pendingCompactions.get(sessionId)
    if (existing) return existing

    const model =
      this.sessionModels.get(sessionId) ??
      (session.model ? { providerID: session.model.providerID, modelID: session.model.id } : undefined)
    const projection = this.messages.startCompactionProjection({
      sessionId,
      agent: session.agent,
      model,
      reason,
    })
    const pending = {
      compactionMessageId: projection.compaction.id,
    }
    this.pendingCompactions.set(sessionId, pending)

    this.publishCurrentSessionEvent(
      sessionId,
      "session.synthetic",
      {
        sessionID: sessionId,
        text: projection.synthetic.text,
        description: projection.synthetic.description,
        metadata: projection.synthetic.metadata,
      },
      {
        id: eventIdForMessageId(projection.synthetic.id),
        created: projection.synthetic.time.created,
        metadata: { source: "compaction" },
      },
    )
    this.publishCurrentSessionEvent(
      sessionId,
      "session.compaction.started",
      {
        sessionID: sessionId,
        reason,
        recent: "",
        inputID: projection.compaction.id,
      },
      {
        id: eventIdForMessageId(projection.compaction.id),
        created: projection.compaction.time.created,
        metadata: { backendReason },
      },
    )
    return pending
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
      idFormat: this.sessions.getIdFormat(parentSessionId),
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
    const childPromptPart = this.messages.getPart(run.childPromptPartId)
    if (childSession) {
      this.events.publish(
        createEvent("session.created", {
          sessionID: run.childSessionId,
          info: childSession,
        }),
      )
    }
    if (childPromptPart?.type === "text") {
      this.publishCurrentSessionEvent(
        run.childSessionId,
        "session.input.admitted",
        {
          sessionID: run.childSessionId,
          inputID: run.childUserMessageId,
          input: { type: "user", delivery: "steer", data: { text: childPromptPart.text } },
        },
        { created: childPromptPart.time?.start ?? Date.now() },
      )
      this.publishCurrentSessionEvent(run.childSessionId, "session.input.promoted", {
        sessionID: run.childSessionId,
        inputID: run.childUserMessageId,
      })
    }
    this.startAssistantStep(run.childAssistantMessageId)
    this.startExecution(run.childSessionId)
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
      const recovered = this.assistantParts.createPart(event.sessionId, event.messageId, "tool", {
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
      this.publishToolInputStarted(recovered)
      this.publishToolCalled(recovered, event.input)
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
    const childEvent = retargetRuntimeEvent(event.event, run.childSessionId, run.childAssistantMessageId)
    if (childEvent.type === "session_idle") {
      // The nested Pi process settles before its enclosing task tool publishes
      // tool_call_completed/tool_call_error. That outer event is the durable
      // lifecycle boundary for the mirrored child session. Releasing the
      // assistant projection here loses the root-to-sibling mapping and makes
      // finishRuntimeSubtask incorrectly synthesize the task output again.
      return
    }
    if (childEvent.type === "session_error" && childEvent.fatal !== false) {
      // Persist and publish the child error, but keep its projection and busy
      // lifecycle owned by the enclosing task. The matching parent
      // tool_call_error will settle the mirrored child and release the group.
      this.flushProjectedMessageParts(run.childAssistantMessageId)
      const failed = this.assistantParts.fail(run.childAssistantMessageId, childEvent.error, childEvent.usage)
      for (const messageId of failed.messageIds) this.publishUnterminatedContent(messageId)
      this.settleAssistantSteps(failed.messageIds)
      this.settleExecution(run.childSessionId, "session.execution.failed", {
        error: { type: "unknown", message: childEvent.error.message },
      })
      publishSessionErrorLegacy(this.events, {
        sessionID: run.childSessionId,
        messageID: failed.terminalMessageId,
        error: {
          name: "UnknownError",
          data: { message: childEvent.error.message },
        },
      })
      return
    }
    this.handleAgentEvent(childEvent, run.childSessionId)
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
    const projectedUsage = usage
      ? {
          cost: usage.cost?.total,
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          total: usage.totalTokens,
        }
      : undefined

    const childRoot = this.messages.getMessage(run.childAssistantMessageId)
    const childParts = this.messages
      .listMessages(run.childSessionId)
      .filter(
        (message) =>
          message.info.role === "assistant" &&
          childRoot?.role === "assistant" &&
          message.info.parentID === childRoot.parentID,
      )
      .flatMap((message) => message.parts)
    if (output && !childParts.some((part) => part.type === "text" && part.text.trim())) {
      const synthetic = this.assistantParts.createPart(run.childSessionId, run.childAssistantMessageId, "text", {
        text: output,
        time: { start: Date.now(), end: Date.now() },
      })
      if (synthetic.type === "text") {
        this.publishContentStarted(synthetic)
        this.publishContentEnded(synthetic, output)
      }
    }

    let projected: { messageIds: string[]; terminalMessageId: string }
    if (status === "completed") {
      projected = this.assistantParts.complete(run.childAssistantMessageId, "stop", projectedUsage)
      this.sessions.setStatus(run.childSessionId, "idle")
    } else {
      if (projectedUsage) {
        this.messages.updateMessageUsage(
          this.assistantParts.terminalMessageId(run.childAssistantMessageId),
          projectedUsage,
        )
      }
      projected = this.assistantParts.fail(run.childAssistantMessageId, {
        type: status === "aborted" ? "aborted" : "subagent_error",
        message: error || output || (status === "aborted" ? "Delegated task was aborted" : "Delegated task failed"),
      })
      this.sessions.setStatus(run.childSessionId, status)
    }

    for (const messageId of projected.messageIds) this.publishUnterminatedContent(messageId)
    this.settleAssistantSteps(projected.messageIds)
    this.settleExecution(
      run.childSessionId,
      status === "completed"
        ? "session.execution.succeeded"
        : status === "aborted"
          ? "session.execution.interrupted"
          : "session.execution.failed",
      status === "failed" ? { error: { type: "unknown", message: error || output || "Delegated task failed" } } : {},
    )
    publishSessionIdleLegacy(this.events, run.childSessionId)
    this.releaseSessionProjection(run.childSessionId)
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
          const part = this.assistantParts.createPart(sessionId, event.messageId, "text", {
            text: "",
            time: { start: Date.now() },
          })
          partIdMap.set(event.partId, part.id)
          this.streamedPartText.set(part.id, "")
          if (part.type === "text") this.publishContentStarted(part)
          break
        }

        case "text_delta": {
          let dbPartId = partIdMap.get(event.partId)
          const existing = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || existing?.type !== "text") {
            const part = this.assistantParts.createPart(sessionId, event.messageId, "text", {
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
            if (part.type === "text") this.publishContentStarted(part)
          }
          const current = this.messages.getPart(dbPartId)
          if (current?.type === "text") this.publishContentDelta(current, event.delta)
          this.streamedPartText.set(dbPartId, event.text)
          break
        }

        case "text_snapshot": {
          let dbPartId = partIdMap.get(event.partId)
          let part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "text") {
            part = this.assistantParts.createPart(sessionId, event.messageId, "text", {
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
          }
          if (part.type !== "text") throw new Error(`Text part not found: ${dbPartId}`)
          const previous = this.streamedPartText.get(dbPartId) ?? part.text
          if (part.text !== event.text) {
            this.messages.updatePart(dbPartId, { text: event.text })
          }
          this.streamedPartText.set(dbPartId, event.text)
          const current = this.messages.getPart(dbPartId)
          if (current?.type === "text") {
            this.publishContentStarted(current)
            if (event.text.startsWith(previous)) this.publishContentDelta(current, event.text.slice(previous.length))
          }
          break
        }

        case "text_ended": {
          let dbPartId = partIdMap.get(event.partId)
          const part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "text") {
            const recovered = this.assistantParts.createPart(sessionId, event.messageId, "text", {
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
          const current = this.messages.getPart(dbPartId)
          if (current?.type === "text") {
            this.publishContentStarted(current)
            this.publishContentEnded(current, event.text)
          }
          break
        }

        case "reasoning_started": {
          const part = this.assistantParts.createPart(sessionId, event.messageId, "reasoning", {
            text: "",
            time: { start: Date.now() },
          })
          partIdMap.set(event.partId, part.id)
          this.streamedPartText.set(part.id, "")
          if (part.type === "reasoning") this.publishContentStarted(part)
          break
        }

        case "reasoning_delta": {
          let dbPartId = partIdMap.get(event.partId)
          const existing = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || existing?.type !== "reasoning") {
            const part = this.assistantParts.createPart(sessionId, event.messageId, "reasoning", {
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
            if (part.type === "reasoning") this.publishContentStarted(part)
          }
          const current = this.messages.getPart(dbPartId)
          if (current?.type === "reasoning") this.publishContentDelta(current, event.delta)
          this.streamedPartText.set(dbPartId, event.text)
          break
        }

        case "reasoning_snapshot": {
          let dbPartId = partIdMap.get(event.partId)
          let part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "reasoning") {
            part = this.assistantParts.createPart(sessionId, event.messageId, "reasoning", {
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
          }
          if (part.type !== "reasoning") throw new Error(`Reasoning part not found: ${dbPartId}`)
          const previous = this.streamedPartText.get(dbPartId) ?? part.text
          if (part.text !== event.text) {
            this.messages.updatePart(dbPartId, { text: event.text })
          }
          this.streamedPartText.set(dbPartId, event.text)
          const current = this.messages.getPart(dbPartId)
          if (current?.type === "reasoning") {
            this.publishContentStarted(current)
            if (event.text.startsWith(previous)) this.publishContentDelta(current, event.text.slice(previous.length))
          }
          break
        }

        case "reasoning_ended": {
          let dbPartId = partIdMap.get(event.partId)
          const part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "reasoning") {
            const recovered = this.assistantParts.createPart(sessionId, event.messageId, "reasoning", {
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
          const current = this.messages.getPart(dbPartId)
          if (current?.type === "reasoning") {
            this.publishContentStarted(current)
            this.publishContentEnded(current, event.text)
          }
          break
        }

        case "tool_call_started": {
          const part = this.assistantParts.createPart(sessionId, event.messageId, "tool", {
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
          this.publishToolInputStarted(part)
          break
        }

        case "tool_call_delta": {
          let dbPartId = partIdMap.get(event.partId)
          let part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "tool") {
            part = this.assistantParts.createPart(sessionId, event.messageId, "tool", {
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
          const current = this.messages.getPart(dbPartId)
          if (current?.type === "tool") this.publishToolInputDelta(current, event.delta)
          break
        }

        case "tool_call_running": {
          let dbPartId = partIdMap.get(event.partId)
          let part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "tool") {
            part = this.assistantParts.createPart(sessionId, event.messageId, "tool", {
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
          const current = this.messages.getPart(dbPartId)
          if (current?.type === "tool") {
            this.publishToolCalled(current, event.input)
            if (run) this.publishToolProgress(current, current.state.metadata ?? {})
          }
          if (run) this.publishRuntimeSubtaskStarted(run)
          break
        }

        case "tool_call_progress": {
          let dbPartId = partIdMap.get(event.partId)
          let part = dbPartId ? this.messages.getPart(dbPartId) : undefined
          if (!dbPartId || part?.type !== "tool") {
            part = this.assistantParts.createPart(sessionId, event.messageId, "tool", {
              callID: event.callId,
              tool: "unknown",
              state: {
                status: "running",
                output: event.output,
                input: {},
                metadata: { ...(event.metadata ?? {}), output: event.output, partialOutput: event.output },
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
                output: event.output,
                input: part.state.input,
                title: part.state.title,
                metadata: {
                  ...(part.state.metadata ?? {}),
                  ...(event.metadata ?? {}),
                  output: event.output,
                  partialOutput: event.output,
                },
                time: { start: part.state.time?.start ?? Date.now() },
              },
            })
          }
          const current = this.messages.getPart(dbPartId)
          if (current?.type === "tool") {
            this.publishToolProgress(current, {
              ...(event.metadata ?? {}),
              output: event.output,
              partialOutput: event.output,
            })
          }
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
            part = this.assistantParts.createPart(sessionId, event.messageId, "tool", {
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
          const current = this.messages.getPart(dbPartId)
          if (current?.type === "tool") this.publishToolSuccess(current, event.output, updatedState.metadata)
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
            part = this.assistantParts.createPart(sessionId, event.messageId, "tool", {
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
          const current = this.messages.getPart(dbPartId)
          if (current?.type === "tool") this.publishToolFailed(current, event.error, updatedState.metadata)
          if (run) this.publishRuntimeSubtaskStarted(run)
          if (event.tool === "task") {
            const status = event.metadata?.status === "aborted" ? "aborted" : "failed"
            this.finishRuntimeSubtask(sessionId, event.callId, status, "", event.error, event.metadata)
          }
          break
        }

        case "compaction_started": {
          this.startCompactionProjection(sessionId, event.reason, event.backendReason ?? event.reason)
          break
        }

        case "compaction_completed": {
          const pending =
            this.pendingCompactions.get(sessionId) ??
            this.startCompactionProjection(sessionId, event.reason, event.backendReason ?? event.reason)
          if (!pending) break
          const completed = this.messages.completeCompactionProjection(pending.compactionMessageId, {
            summary: event.result.summary,
            usage: event.result.usage,
          })
          if (!completed) {
            this.pendingCompactions.delete(sessionId)
            throw new Error(`Compaction projection not found: ${pending.compactionMessageId}`)
          }
          this.publishCurrentSessionEvent(
            sessionId,
            "session.compaction.ended",
            {
              sessionID: sessionId,
              reason: event.reason,
              text: completed.compaction.summary,
              recent: completed.compaction.recent,
            },
            {
              metadata: {
                backendReason: event.backendReason,
                willRetry: event.willRetry ?? false,
                firstKeptEntryId: event.result.firstKeptEntryId,
                tokensBefore: event.result.tokensBefore,
                estimatedTokensAfter: event.result.estimatedTokensAfter,
              },
            },
          )
          publishSessionCompactedLegacy(this.events, sessionId)
          this.pendingCompactions.delete(sessionId)
          break
        }

        case "compaction_failed": {
          const pending = this.pendingCompactions.get(sessionId)
          if (pending) this.messages.failCompactionProjection(pending.compactionMessageId, event.error)
          this.publishCurrentSessionEvent(
            sessionId,
            "session.compaction.failed",
            {
              sessionID: sessionId,
              reason: event.reason,
              error: { type: "unknown", message: event.error },
              inputID: pending?.compactionMessageId,
            },
            {
              metadata: {
                backendReason: event.backendReason,
                aborted: event.aborted ?? false,
                willRetry: event.willRetry ?? false,
              },
            },
          )
          // Current-protocol compaction failure updates the session source,
          // while the legacy session.error event is what Desktop surfaces in
          // its notification/error UI. Publish both projections from the same
          // application-layer failure boundary.
          publishSessionErrorLegacy(this.events, {
            sessionID: sessionId,
            error: {
              name: "UnknownError",
              data: { message: event.error },
            },
          })
          this.pendingCompactions.delete(sessionId)
          break
        }

        case "session_busy": {
          // A backend can flush an already-buffered busy/retry event after its
          // abort acknowledgement. The user-visible interrupt owns the
          // terminal state until another prompt explicitly clears this flag.
          if (this.abortedSessions.has(sessionId)) break
          this.sessions.setStatus(sessionId, "busy")
          // A retry resumes inside the same execution, so startExecution() is
          // intentionally idempotent and cannot clear Desktop's retry status.
          // Publish the compatible status transition explicitly.
          publishSessionStatusLegacy(this.events, sessionId, { type: "busy" })
          this.startExecution(sessionId)
          break
        }

        case "session_retry": {
          if (this.abortedSessions.has(sessionId)) break
          this.sessions.setStatus(sessionId, "busy")
          this.startExecution(sessionId)
          publishSessionStatusLegacy(this.events, sessionId, {
            type: "retry",
            attempt: event.attempt,
            message: event.message,
            next: event.next,
          })
          const assistantMessageID = this.activeAssistantMessageId(sessionId)
          if (assistantMessageID) {
            this.publishCurrentSessionEvent(sessionId, "session.retry.scheduled", {
              sessionID: sessionId,
              assistantMessageID,
              attempt: event.attempt,
              at: event.next,
              error: { type: "unknown", message: event.message },
            })
          }
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
            this.startExecution(sessionId)
            break
          }
          this.sessions.setStatus(sessionId, "idle")
          this.settleExecution(
            sessionId,
            this.abortedSessions.has(sessionId) ? "session.execution.interrupted" : "session.execution.succeeded",
          )
          publishSessionIdleLegacy(this.events, sessionId)
          this.releaseSessionProjection(sessionId)
          break
        }

        case "session_error": {
          if (event.fatal === false) {
            const diagnosticMessageId = event.messageId
              ? this.assistantParts.terminalMessageId(event.messageId)
              : undefined
            publishSessionErrorLegacy(this.events, {
              sessionID: sessionId,
              messageID: diagnosticMessageId,
              error: {
                name: "UnknownError",
                data: { message: event.error.message },
              },
            })
            break
          }
          // A session error terminates the model turn, not the Runtime. Pi still
          // owns the following agent_settled boundary; stopping it here rejects
          // the otherwise completed prompt and replaces the provider error with
          // "Runtime stopped before the current prompt settled". Only a
          // runtime_fault invalidates the pooled process.
          if (!event.messageId) {
            this.sessions.setStatus(sessionId, "idle")
            publishSessionStatusLegacy(this.events, sessionId, { type: "idle" })
            publishSessionErrorLegacy(this.events, {
              sessionID: sessionId,
              error: {
                name: "UnknownError",
                data: { message: event.error.message },
              },
            })
            this.settleExecution(sessionId, "session.execution.failed", {
              error: { type: "unknown", message: event.error.message },
            })
            break
          }
          this.flushProjectedMessageParts(event.messageId)
          const failed = this.assistantParts.fail(event.messageId, event.error, event.usage)
          this.sessions.setStatus(sessionId, "idle")
          publishSessionStatusLegacy(this.events, sessionId, { type: "idle" })
          for (const messageId of failed.messageIds) this.publishUnterminatedContent(messageId)
          this.settleAssistantSteps(failed.messageIds)
          publishSessionErrorLegacy(this.events, {
            sessionID: sessionId,
            messageID: failed.terminalMessageId,
            error: {
              name: "UnknownError",
              data: { message: event.error.message },
            },
          })
          this.settleExecution(sessionId, "session.execution.failed", {
            error: { type: "unknown", message: event.error.message },
          })
          this.releaseSessionProjection(sessionId)
          break
        }

        case "runtime_fault": {
          // An active prompt rejects immediately after this event, and its catch
          // path owns message finalization and the client-facing error. An idle
          // Runtime has no prompt owner, so publish that fault here.
          if (!event.messageId) {
            this.sessions.setStatus(sessionId, "idle")
            publishSessionErrorLegacy(this.events, {
              sessionID: sessionId,
              error: {
                name: "UnknownError",
                data: { message: event.error.message },
              },
            })
            this.settleExecution(sessionId, "session.execution.failed", {
              error: { type: "unknown", message: event.error.message },
            })
          }
          void this.invalidateRuntime(sessionId, runtime, agentId, "runtime_fault")
          break
        }

        case "message_completed": {
          // Older/custom backends can omit text_end/reasoning_end. Flush the
          // in-memory accumulator before closing the message so history and a
          // reconnect see exactly the same content as the live delta stream.
          this.flushProjectedMessageParts(event.messageId)
          const completed = this.assistantParts.complete(event.messageId, event.finish ?? "stop", event.usage)
          for (const messageId of completed.messageIds) this.publishUnterminatedContent(messageId)
          this.settleAssistantSteps(completed.messageIds)
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
        this.flushProjectedMessageParts(messageId)
        const failed = this.assistantParts.fail(messageId, {
          type: "event_projection_error",
          message: error instanceof Error ? error.message : String(error),
        })
        for (const failedMessageId of failed.messageIds) this.publishUnterminatedContent(failedMessageId)
        this.settleAssistantSteps(failed.messageIds)
      }
      this.sessions.setStatus(sessionId, "idle")
      publishSessionErrorLegacy(this.events, {
        sessionID: sessionId,
        ...(messageId ? { messageID: this.assistantParts.terminalMessageId(messageId) } : {}),
        error: {
          name: "UnknownError",
          data: {
            message: `Failed to persist an agent event: ${error instanceof Error ? error.message : String(error)}`,
          },
        },
      })
      this.settleExecution(sessionId, "session.execution.failed", {
        error: {
          type: "unknown",
          message: `Failed to persist an agent event: ${error instanceof Error ? error.message : String(error)}`,
        },
      })
      this.releaseSessionProjection(sessionId)
    } catch (recoveryError) {
      this.logger.error("Could not persist agent event projection failure", {
        sessionId,
        type: event.type,
        error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
      })
    }
  }
}

function normalizeStepFinish(
  finish: string | undefined,
): "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown" {
  switch (finish) {
    case "stop":
    case "length":
    case "tool-calls":
    case "content-filter":
    case "error":
      return finish
    case "end_turn":
      return "stop"
    case "tool_use":
      return "tool-calls"
    case "content_filter":
      return "content-filter"
    default:
      return "unknown"
  }
}
