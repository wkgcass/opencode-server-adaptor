import type { SessionRepository } from "../session/index.ts"
import type { MessageRepository } from "../message/index.ts"
import type { EventBus } from "../event/index.ts"
import type { Logger } from "../logging/index.ts"
import { createEvent } from "../event/index.ts"
import type { AppConfig } from "../config/index.ts"
import type { AgentAdapterRegistry } from "./registry.ts"
import type { SubagentRunner, SubagentUsage } from "./subagent-adapter.ts"
import type { AgentRuntimeEvent } from "./agent-adapter.ts"
import { subagentSessionTitle } from "./subagents/subagent-session.ts"
import { AssistantPartProjector } from "./assistant-part-projector.ts"

export interface StartSubtaskInput {
  parentSessionId: string
  parentToolPartId: string
  parentAssistantMessageId: string

  prompt: string
  description: string
  agent: string

  model?: { providerID: string; modelID: string }
}

export interface SubtaskResult {
  status: "completed" | "failed" | "aborted"
  childSessionId: string
  output?: string
  error?: { name: string; message: string }
  usage?: SubagentUsage
}

export interface SubtaskHandle {
  childSessionId: string
  result: Promise<SubtaskResult>
  abort(reason?: string): Promise<void>
}

interface RunningSubtask {
  handle: SubtaskHandle
  parentSessionId: string
  parentToolPartId: string
  abortController: AbortController
  aborted: boolean
  runner: SubagentRunner
}

export interface SubtaskProjection {
  childStarted(sessionId: string, userMessageId: string, prompt: string, assistantMessageId: string): void
  runtimeEvent(event: AgentRuntimeEvent, sessionId: string, assistantMessageId: string): void
  parentToolProgress(partId: string, metadata: Record<string, unknown>): void
  parentToolOutput(partId: string, delta: string): void
  childSettled(
    sessionId: string,
    messageIds: string[],
    terminalMessageId: string,
    status: "completed" | "failed" | "aborted",
    error?: string,
  ): void
}

export class SubtaskManager {
  private readonly registry: AgentAdapterRegistry
  private readonly sessions: SessionRepository
  private readonly messages: MessageRepository
  private readonly events: EventBus
  private readonly logger: Logger
  private readonly config: AppConfig
  private readonly assistantParts: AssistantPartProjector
  private readonly projection: SubtaskProjection
  private readonly running = new Map<string, RunningSubtask>()

  constructor(
    registry: AgentAdapterRegistry,
    sessions: SessionRepository,
    messages: MessageRepository,
    events: EventBus,
    logger: Logger,
    config: AppConfig,
    assistantParts: AssistantPartProjector | undefined,
    projection: SubtaskProjection,
  ) {
    this.registry = registry
    this.sessions = sessions
    this.messages = messages
    this.events = events
    this.logger = logger
    this.config = config
    this.assistantParts = assistantParts ?? new AssistantPartProjector(messages)
    this.projection = projection
  }

  getGlobalRunningCount(): number {
    return this.running.size
  }

  getParentRunningCount(parentSessionId: string): number {
    let count = 0
    for (const sub of this.running.values()) {
      if (sub.parentSessionId === parentSessionId) count++
    }
    return count
  }

  start(input: StartSubtaskInput): SubtaskHandle {
    const { parentSessionId } = input

    const depth = this.sessions.getDepth(parentSessionId)
    if (depth >= this.config.maxSubtaskDepth) {
      throw new SubtaskLimitError(`Max subtask depth (${this.config.maxSubtaskDepth}) exceeded`)
    }

    if (this.getGlobalRunningCount() >= this.config.maxGlobalConcurrentSubtasks) {
      throw new SubtaskLimitError(
        `Global concurrent subtask limit (${this.config.maxGlobalConcurrentSubtasks}) reached`,
      )
    }

    if (this.getParentRunningCount(parentSessionId) >= this.config.maxConcurrentSubtasksPerParent) {
      throw new SubtaskLimitError(
        `Per-parent concurrent subtask limit (${this.config.maxConcurrentSubtasksPerParent}) reached`,
      )
    }

    const parentSession = this.sessions.get(parentSessionId)
    if (!parentSession) {
      throw new Error(`Parent session not found: ${parentSessionId}`)
    }
    const runner = this.registry.get(parentSession.agent).subagents
    if (!runner) {
      throw new Error(`Agent '${parentSession.agent}' does not support subagents`)
    }

    const childSession = this.sessions.create({
      directory: parentSession.directory,
      title: subagentSessionTitle(input.description, input.agent),
      agent: input.agent,
      parentId: parentSessionId,
      idFormat: this.sessions.getIdFormat(parentSessionId),
      model: input.model
        ? {
            id: input.model.modelID,
            providerID: input.model.providerID,
          }
        : undefined,
    })
    const childSessionId = childSession.id
    this.sessions.setStatus(childSessionId, "busy")

    const parentToolPart = this.messages.getPart(input.parentToolPartId)
    if (parentToolPart?.type === "tool") {
      const linkedPart = this.messages.updatePart(parentToolPart.id, {
        state: {
          ...parentToolPart.state,
          metadata: {
            ...(parentToolPart.state.metadata ?? {}),
            parentSessionId,
            sessionId: childSessionId,
            ...(input.model ? { model: input.model } : {}),
          },
        },
      })
      if (linkedPart?.type === "tool") {
        this.projection.parentToolProgress(linkedPart.id, linkedPart.state.metadata ?? {})
      }
    }

    const abortController = new AbortController()
    const timeoutId = setTimeout(
      () => abortController.abort(new SubtaskTimeoutError(`Subtask timed out after ${this.config.subtaskTimeoutMs}ms`)),
      this.config.subtaskTimeoutMs,
    )

    const resultPromise = this.executeSubtask(
      input,
      childSessionId,
      parentSession.directory,
      runner,
      abortController.signal,
    )

    const handle: SubtaskHandle = {
      childSessionId,
      result: resultPromise.finally(() => clearTimeout(timeoutId)),
      abort: async (reason?: string) => {
        await this.abortByChildSession(childSessionId, reason)
      },
    }

    this.running.set(childSessionId, {
      handle,
      parentSessionId,
      parentToolPartId: input.parentToolPartId,
      abortController,
      aborted: false,
      runner,
    })

    return handle
  }

  private async executeSubtask(
    input: StartSubtaskInput,
    childSessionId: string,
    directory: string,
    runner: SubagentRunner,
    signal: AbortSignal,
  ): Promise<SubtaskResult> {
    const { parentSessionId, parentToolPartId } = input

    this.logger.info("Subtask started", {
      parentSessionId,
      childSessionId,
      parentToolPartId,
      agent: input.agent,
    })

    this.events.publish(
      createEvent("session.created", {
        sessionID: childSessionId,
        info: this.sessions.get(childSessionId),
      }),
    )
    const childUserMsg = this.messages.createUserMessage(childSessionId, input.agent, input.model)
    this.messages.createPart(childSessionId, childUserMsg.id, "text", {
      text: input.prompt,
      time: { start: Date.now() },
    })
    const childAssistantMsg = this.messages.createAssistantMessage(
      childSessionId,
      childUserMsg.id,
      input.agent,
      input.model,
    )
    this.projection.childStarted(childSessionId, childUserMsg.id, input.prompt, childAssistantMsg.id)

    try {
      const result = await runner.run(
        {
          parentSessionId,
          childSessionId,
          childAssistantMessageId: childAssistantMsg.id,
          agent: input.agent,
          task: input.prompt,
          cwd: directory,
          signal,
          model: input.model,
        },
        {
          onUpdate: (update) => {
            if (update.type === "event") {
              this.projection.runtimeEvent(update.event, childSessionId, childAssistantMsg.id)
            } else if (update.type === "output_delta") {
              this.projection.parentToolOutput(parentToolPartId, update.delta)
            }
          },
        },
      )

      if (result.status === "aborted") {
        this.sessions.setStatus(childSessionId, "aborted")
        const completed = this.assistantParts.complete(childAssistantMsg.id, "aborted", this.usage(result.usage))
        this.projection.childSettled(childSessionId, completed.messageIds, completed.terminalMessageId, "aborted")
        this.assistantParts.releaseSession(childSessionId)

        const output = result.output
        this.running.delete(childSessionId)

        return {
          status: "aborted",
          childSessionId,
          output: output || undefined,
          usage: result.usage,
        }
      }

      if (result.status === "failed") {
        this.sessions.setStatus(childSessionId, "failed")
        const errorMsg = result.error?.message ?? result.output ?? "Subtask failed"
        this.persistUsage(this.assistantParts.terminalMessageId(childAssistantMsg.id), result.usage)
        const failed = this.assistantParts.fail(childAssistantMsg.id, {
          type: "subagent_error",
          message: errorMsg,
        })
        this.projection.childSettled(childSessionId, failed.messageIds, failed.terminalMessageId, "failed", errorMsg)
        this.assistantParts.releaseSession(childSessionId)

        const output = result.output || errorMsg
        this.running.delete(childSessionId)

        return {
          status: "failed",
          childSessionId,
          output,
          error: { name: "SubagentError", message: errorMsg },
          usage: result.usage,
        }
      }

      this.sessions.setStatus(childSessionId, "idle")
      const completed = this.assistantParts.complete(childAssistantMsg.id, "stop", this.usage(result.usage))
      this.projection.childSettled(childSessionId, completed.messageIds, completed.terminalMessageId, "completed")
      this.assistantParts.releaseSession(childSessionId)

      const output = result.output || "(Subtask completed with no text output)"
      this.running.delete(childSessionId)

      this.logger.info("Subtask completed", {
        parentSessionId,
        childSessionId,
        outputLength: output.length,
        usage: result.usage,
      })

      return {
        status: "completed",
        childSessionId,
        output,
        usage: result.usage,
      }
    } catch (err) {
      this.logger.error("Subtask execution failed", {
        childSessionId,
        parentSessionId,
        error: err instanceof Error ? err.message : String(err),
      })

      const isAborted =
        err instanceof SubtaskAbortedError ||
        err instanceof SubtaskTimeoutError ||
        (err instanceof Error && err.message.includes("aborted"))

      this.sessions.setStatus(childSessionId, isAborted ? "aborted" : "failed")
      const failed = this.assistantParts.fail(childAssistantMsg.id, {
        type: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
      })
      this.projection.childSettled(
        childSessionId,
        failed.messageIds,
        failed.terminalMessageId,
        isAborted ? "aborted" : "failed",
        err instanceof Error ? err.message : String(err),
      )
      this.assistantParts.releaseSession(childSessionId)

      this.running.delete(childSessionId)

      return {
        status: isAborted ? "aborted" : "failed",
        childSessionId,
        error: {
          name: err instanceof Error ? err.name : "Error",
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  private persistUsage(assistantMessageId: string, usage: SubagentUsage): void {
    try {
      this.messages.updateMessageUsage(assistantMessageId, {
        cost: usage.cost,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        total: usage.contextTokens,
      })
    } catch (err) {
      this.logger.warn("Failed to persist usage", {
        assistantMessageId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private usage(usage: SubagentUsage): Parameters<MessageRepository["updateMessageUsage"]>[1] {
    return {
      cost: usage.cost,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      total: usage.contextTokens,
    }
  }

  async abortByChildSession(childSessionId: string, reason?: string): Promise<void> {
    const sub = this.running.get(childSessionId)
    if (!sub) return
    if (sub.aborted) return
    sub.aborted = true

    this.logger.info("Aborting subtask", { childSessionId, reason })
    sub.abortController.abort(new SubtaskAbortedError(reason ?? "Aborted"))
  }

  async abortByParentSession(parentSessionId: string, reason?: string): Promise<void> {
    const subtasks: RunningSubtask[] = []
    for (const sub of this.running.values()) {
      if (sub.parentSessionId === parentSessionId) {
        subtasks.push(sub)
      }
    }
    await Promise.allSettled(
      subtasks.map(async (sub) => {
        await this.abortByChildSession(sub.handle.childSessionId, reason)
        await sub.handle.result
      }),
    )
  }

  async respondToPermission(
    childSessionId: string,
    permissionId: string,
    action: "allow" | "deny",
    reason?: string,
  ): Promise<void> {
    const sub = this.running.get(childSessionId)
    if (!sub) {
      this.logger.warn("Permission response for non-running subtask", { childSessionId, permissionId })
      return
    }

    if (sub.runner.respondToPermission) {
      await sub.runner.respondToPermission(childSessionId, permissionId, action, reason)
      return
    }
    this.logger.warn("The selected subagent runner does not support interactive permissions", {
      childSessionId,
      permissionId,
      action,
      reason,
    })
  }

  async closeAll(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const childSessionId of this.running.keys()) {
      promises.push(this.abortByChildSession(childSessionId, "Server shutting down"))
    }
    await Promise.allSettled(promises)
  }

  recoverOnStartup(): void {
    const statuses = ["running", "busy", "waiting_permission"]
    const sessions = this.sessions.listByStatuses(statuses)
    for (const session of sessions) {
      if (session.parentID) {
        this.logger.info("Marking orphaned subtask session as interrupted", {
          sessionId: session.id,
          parentId: session.parentID,
          oldStatus: session.status,
        })
        this.sessions.setStatus(session.id, "interrupted")
      }
    }
  }
}

export class SubtaskLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SubtaskLimitError"
  }
}

export class SubtaskTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SubtaskTimeoutError"
  }
}

export class SubtaskAbortedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SubtaskAbortedError"
  }
}
