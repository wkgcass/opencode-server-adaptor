import type { AgentService } from "../agents/agent-service.ts"
import { AgentConversationError } from "../agents/agent-service.ts"
import type { AppConfig } from "../config/index.ts"
import type { ProviderConfigStore } from "../config/provider-config.ts"
import type { EventBus, OpenCodeEvent } from "../event/index.ts"
import { createEvent } from "../event/index.ts"
import type { SessionEventStore } from "../event/session-event-store.ts"
import type { MessageRepository, MessageWithParts, Part } from "../message/index.ts"
import type { Session, SessionRepository } from "./index.ts"
import { buildDefaultProviderMap, buildProviders, type BuiltinProviderDefinition } from "../provider/index.ts"
import { runShellCommand } from "./shell-runner.ts"

export interface SessionPromptPartInput extends Record<string, unknown> {
  type: string
}

export interface SessionPromptRequest {
  messageID?: string
  model?: { providerID: string; modelID: string; variant?: string }
  agent?: string
  noReply?: boolean
  system?: string
  tools?: Record<string, boolean>
  parts: SessionPromptPartInput[]
  subtaskMode?: string
  directory?: string
  delivery?: "steer" | "queue"
  resume?: boolean
}

export interface SessionShellRequest {
  messageID?: string
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
  command: string
}

export interface SessionPromptAdmission {
  admittedSeq: number
  id: string
  sessionID: string
  prompt: {
    text: string
    files?: Array<{ uri: string; mime: string; name?: string; description?: string }>
    agents?: Array<{ name: string }>
  }
  delivery: "steer" | "queue"
  timeCreated: number
  promotedSeq?: number
  assistantMessageID?: string
}

export class SessionServiceError extends Error {
  constructor(
    readonly code: "invalid_request" | "not_found" | "message_not_found" | "conflict" | "unavailable",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "SessionServiceError"
  }
}

export class SessionService {
  private readonly unsubscribe: () => void
  private readonly projectedTerminalEvents = new Set<string>()

  constructor(
    readonly sessions: SessionRepository,
    readonly messages: MessageRepository,
    readonly events: EventBus,
    readonly sessionEvents: SessionEventStore,
    readonly agentService: AgentService,
    private readonly defaultAgent: string,
    private readonly config: AppConfig,
    private readonly providerConfig: ProviderConfigStore,
    private readonly builtinProviders: readonly BuiltinProviderDefinition[],
    private readonly startupSessionIds: ReadonlySet<string>,
  ) {
    this.unsubscribe = events.subscribeInternal((event) => this.projectRuntimeEvent(event))
  }

  close(): void {
    this.unsubscribe()
  }

  resolveModel(requested?: {
    providerID: string
    modelID: string
    variant?: string
  }): { providerID: string; modelID: string; variant?: string } | undefined {
    if (requested?.providerID && requested.modelID) return requested
    const configuredModel = this.providerConfig.snapshot().model
    if (configuredModel) {
      const separator = configuredModel.indexOf("/")
      if (separator > 0 && separator < configuredModel.length - 1) {
        return {
          providerID: configuredModel.slice(0, separator),
          modelID: configuredModel.slice(separator + 1),
        }
      }
    }
    const providers = buildProviders(this.providerConfig, [...this.builtinProviders])
    const defaults = buildDefaultProviderMap(providers)
    for (const provider of providers) {
      const modelID = defaults[provider.id]
      if (modelID) return { providerID: provider.id, modelID }
    }
    return undefined
  }

  create(input: {
    id?: string
    directory: string
    title?: string
    agent?: string
    parentID?: string
    model?: { id: string; providerID: string; variant?: string }
    metadata?: Record<string, unknown>
    permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
  }): Session {
    const agent = input.agent?.trim() || this.defaultAgent
    if (!this.agentService.hasAgent(agent)) {
      throw new SessionServiceError("invalid_request", `Agent not found: ${agent}`)
    }
    const session = this.sessions.create({ ...input, agent })
    this.events.publish(createEvent("session.created", { sessionID: session.id, info: session }))
    return session
  }

  update(
    sessionID: string,
    input: {
      title?: string
      status?: string
      directory?: string
      agent?: string
      model?: { id: string; providerID: string; variant?: string }
      time?: { archived?: number | null }
    },
  ): Session {
    if (input.agent && !this.agentService.hasAgent(input.agent)) {
      throw new SessionServiceError("invalid_request", `Agent not found: ${input.agent}`)
    }
    const previous = this.requireSession(sessionID)
    const updated = this.sessions.update(sessionID, input)
    if (!updated) throw new SessionServiceError("not_found", `Session not found: ${sessionID}`, { sessionID })
    this.events.publish(createEvent("session.updated", { sessionID, info: updated }))
    if (input.agent && input.agent !== previous.agent) {
      this.appendSessionEvent(sessionID, "session.next.agent.switched", {
        timestamp: Date.now(),
        sessionID,
        messageID: this.messages.nextMessageId(sessionID),
        agent: input.agent,
      })
    }
    if (
      input.model &&
      (input.model.id !== previous.model?.id || input.model.providerID !== previous.model?.providerID)
    ) {
      this.appendSessionEvent(sessionID, "session.next.model.switched", {
        timestamp: Date.now(),
        sessionID,
        messageID: this.messages.nextMessageId(sessionID),
        model: input.model,
      })
    }
    return updated
  }

  async delete(sessionID: string): Promise<void> {
    const session = this.requireSession(sessionID)
    await this.agentService.stopSession(sessionID)
    if (!this.sessions.delete(sessionID)) {
      throw new SessionServiceError("not_found", `Session not found: ${sessionID}`, { sessionID })
    }
    this.events.publish(createEvent("session.deleted", { sessionID, info: session }))
  }

  async interrupt(sessionID: string): Promise<void> {
    this.requireSession(sessionID)
    await this.agentService.abort(sessionID)
  }

  async compact(sessionID: string, customInstructions?: string): Promise<void> {
    const session = this.requireSession(sessionID)
    const model = this.resolveModel(
      session.model ? { providerID: session.model.providerID, modelID: session.model.id } : undefined,
    )
    if (!model) throw new SessionServiceError("invalid_request", "No model configured")
    try {
      await this.agentService.compact(sessionID, model, customInstructions)
    } catch (error) {
      throw this.conversationError(error)
    }
  }

  async wait(sessionID: string, signal?: AbortSignal): Promise<void> {
    this.requireSession(sessionID)
    const deadline = Date.now() + this.config.agentRpcTimeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new SessionServiceError("conflict", "Request aborted")
      const status = this.sessions.getStatus(sessionID)
      if (!status) throw new SessionServiceError("not_found", `Session not found: ${sessionID}`, { sessionID })
      if (!["busy", "running", "waiting_permission"].includes(status)) return
      await Bun.sleep(20)
    }
    throw new SessionServiceError("unavailable", "Timed out waiting for session", { service: "session.wait" })
  }

  async revert(sessionID: string, messageID: string, partID?: string): Promise<Session> {
    this.requireSession(sessionID)
    try {
      const session = await this.agentService.revert(sessionID, messageID, partID)
      this.appendSessionEvent(sessionID, "session.next.revert.staged", {
        timestamp: Date.now(),
        sessionID,
        revert: { messageID, ...(partID ? { partID } : {}) },
      })
      return session
    } catch (error) {
      throw this.conversationError(error)
    }
  }

  async clearRevert(sessionID: string): Promise<Session> {
    this.requireSession(sessionID)
    try {
      const session = await this.agentService.unrevert(sessionID)
      this.appendSessionEvent(sessionID, "session.next.revert.cleared", {
        timestamp: Date.now(),
        sessionID,
      })
      return session
    } catch (error) {
      throw this.conversationError(error)
    }
  }

  async commitRevert(sessionID: string): Promise<void> {
    this.requireSession(sessionID)
    try {
      await this.agentService.commitRevert(sessionID)
      this.appendSessionEvent(sessionID, "session.next.revert.committed", {
        timestamp: Date.now(),
        sessionID,
        messageID: this.messages.nextMessageId(sessionID),
      })
    } catch (error) {
      throw this.conversationError(error)
    }
  }

  async prompt(sessionID: string, input: SessionPromptRequest): Promise<SessionPromptAdmission> {
    let session = this.requireSession(sessionID)
    if (this.startupSessionIds.has(sessionID) && !this.events.hasSubscribers()) {
      throw new SessionServiceError(
        "conflict",
        "Cannot continue a session from a previous adaptor run before the client event stream is connected",
      )
    }
    if (input.directory && input.directory !== session.directory) {
      session = this.update(sessionID, { directory: input.directory })
    }
    if (input.messageID && this.messages.getMessage(input.messageID)) {
      throw new SessionServiceError("conflict", `Message already exists: ${input.messageID}`, {
        resource: input.messageID,
      })
    }
    this.enableWideIdsFromMessage(sessionID, input.messageID)

    const selectedModel =
      input.model ??
      (session.model
        ? {
            providerID: session.model.providerID,
            modelID: session.model.id,
            variant: session.model.variant,
          }
        : undefined)
    const model = this.resolveModel(selectedModel)
    if (!model) throw new SessionServiceError("invalid_request", "No model configured")
    const agent = input.agent?.trim() || session.agent
    if (!this.agentService.hasAgent(agent)) {
      throw new SessionServiceError("invalid_request", `Agent not found: ${agent}`)
    }
    try {
      await this.agentService.commitRevert(sessionID)
    } catch (error) {
      throw this.conversationError(error)
    }
    if (agent !== session.agent) session = this.update(sessionID, { agent })

    const isFirstUserMessage = !this.messages.listMessages(sessionID).some((message) => message.info.role === "user")
    const user = this.messages.createUserMessage(sessionID, agent, model, input.messageID, {
      system: input.system,
      tools: input.tools,
    })
    const promptSegments: string[] = []
    const files: NonNullable<SessionPromptAdmission["prompt"]["files"]> = []
    const agents: NonNullable<SessionPromptAdmission["prompt"]["agents"]> = []
    const subtasks: Array<{
      prompt: string
      description: string
      agent: string
      model?: { providerID: string; modelID: string }
    }> = []

    for (const part of input.parts) {
      if (part.type === "text") {
        const text = typeof part.text === "string" ? part.text : ""
        const time = part.time as { start?: number; end?: number } | undefined
        this.messages.createPart(
          sessionID,
          user.id,
          "text",
          {
            text,
            time: {
              start: typeof time?.start === "number" ? time.start : Date.now(),
              ...(typeof time?.end === "number" ? { end: time.end } : {}),
            },
            synthetic: typeof part.synthetic === "boolean" ? part.synthetic : undefined,
            ignored: typeof part.ignored === "boolean" ? part.ignored : undefined,
            metadata:
              typeof part.metadata === "object" && part.metadata
                ? (part.metadata as Record<string, unknown>)
                : undefined,
          },
          typeof part.id === "string" ? part.id : undefined,
        )
        if (text) promptSegments.push(text)
        continue
      }
      if (part.type === "file") {
        const url = typeof part.url === "string" ? part.url : typeof part.uri === "string" ? part.uri : ""
        const filename =
          typeof part.filename === "string" ? part.filename : typeof part.name === "string" ? part.name : undefined
        const mime = typeof part.mime === "string" ? part.mime : "application/octet-stream"
        this.messages.createPart(
          sessionID,
          user.id,
          "file",
          {
            mime,
            filename,
            url,
            source:
              typeof part.source === "object" && part.source ? (part.source as Record<string, unknown>) : undefined,
          },
          typeof part.id === "string" ? part.id : undefined,
        )
        if (url) {
          files.push({
            uri: url,
            mime,
            name: filename,
            description: typeof part.description === "string" ? part.description : undefined,
          })
          promptSegments.push(`[Attached file${filename ? ` ${filename}` : ""}: ${url}]`)
        }
        continue
      }
      if (part.type === "agent") {
        const name = typeof part.name === "string" ? part.name : ""
        const source =
          typeof part.source === "object" && part.source ? (part.source as Record<string, unknown>) : undefined
        this.messages.createPart(
          sessionID,
          user.id,
          "agent",
          { name, source },
          typeof part.id === "string" ? part.id : undefined,
        )
        if (name) {
          agents.push({ name })
          promptSegments.push(`@${name}`)
        }
        continue
      }
      if (part.type === "subtask") {
        const subtask = {
          prompt: typeof part.prompt === "string" ? part.prompt : "",
          description: typeof part.description === "string" ? part.description : "",
          agent: typeof part.agent === "string" ? part.agent : session.agent,
          model: part.model as { providerID: string; modelID: string } | undefined,
        }
        subtasks.push(subtask)
        this.messages.createPart(
          sessionID,
          user.id,
          "subtask",
          { ...subtask, command: typeof part.command === "string" ? part.command : undefined },
          typeof part.id === "string" ? part.id : undefined,
        )
      }
    }

    this.publishMessage(user)
    const prompt = {
      text: promptSegments.join("\n\n"),
      ...(files.length ? { files } : {}),
      ...(agents.length ? { agents } : {}),
    }
    const delivery = input.delivery ?? "steer"
    const admitted = this.appendSessionEvent(sessionID, "session.next.prompt.admitted", {
      timestamp: user.time.created,
      sessionID,
      messageID: user.id,
      prompt,
      delivery,
    })
    const admission: SessionPromptAdmission = {
      admittedSeq: admitted.durable.seq,
      id: user.id,
      sessionID,
      prompt,
      delivery,
      timeCreated: user.time.created,
    }
    if (input.resume === false) return admission

    const assistant = this.messages.createAssistantMessage(sessionID, user.id, agent, model)
    this.publishMessage(assistant)
    admission.assistantMessageID = assistant.id
    const promoted = this.appendSessionEvent(sessionID, "session.next.prompted", {
      timestamp: Date.now(),
      sessionID,
      messageID: user.id,
      prompt,
      delivery,
    })
    admission.promotedSeq = promoted.durable.seq

    if (input.noReply) {
      this.messages.completeMessage(assistant.id, "stop")
      this.publishMessage(this.messages.getMessage(assistant.id)!)
      return admission
    }

    const text = [input.system?.trim(), ...promptSegments].filter(Boolean).join("\n\n")
    if (isFirstUserMessage && text) {
      this.agentService.generateTitle(sessionID, promptSegments.join("\n\n") || text, model)
    }
    this.sessions.setStatus(sessionID, "busy")
    this.publishStatus(sessionID, "busy")
    const mode = input.subtaskMode === "parallel" ? "parallel" : input.subtaskMode === "chain" ? "chain" : "sequential"
    if (subtasks.length) {
      this.agentService.schedulePromptWithSubtasks(sessionID, text, user.id, assistant.id, subtasks, mode, model)
    } else {
      this.agentService.schedulePrompt(sessionID, text, user.id, assistant.id, model)
    }
    return admission
  }

  async promptAndWait(sessionID: string, input: SessionPromptRequest, signal?: AbortSignal): Promise<MessageWithParts> {
    const admitted = await this.prompt(sessionID, input)
    if (!admitted.assistantMessageID) {
      throw new SessionServiceError("conflict", "Prompt was admitted without execution")
    }
    try {
      await this.wait(sessionID, signal)
    } catch (error) {
      if (error instanceof SessionServiceError && error.code === "unavailable") {
        await this.agentService.abort(sessionID)
      }
      throw error
    }
    const terminal = this.messages
      .listMessages(sessionID)
      .findLast((message) => message.info.role === "assistant" && message.info.parentID === admitted.id)
    if (!terminal) throw new SessionServiceError("message_not_found", "Assistant message was not persisted")
    return terminal
  }

  /**
   * Execute a shell command directly (shell mode). The command never goes
   * through the model; it is recorded as an assistant `bash` tool part so it
   * renders in the Desktop timeline and persists for later context, mirroring
   * OpenCode's native `SessionPrompt.shell`. The Desktop client treats this
   * endpoint as fire-and-forget (204), so command execution continues after
   * the response is sent and progress is streamed via message events.
   */
  shell(sessionID: string, input: SessionShellRequest): void {
    if (typeof input.command !== "string" || input.command.trim().length === 0) {
      throw new SessionServiceError("invalid_request", "command is required")
    }
    const session = this.requireSession(sessionID)
    this.enableWideIdsFromMessage(sessionID, input.messageID)
    const selectedModel =
      input.model ??
      (session.model
        ? { providerID: session.model.providerID, modelID: session.model.id, variant: session.model.variant }
        : undefined)
    const model = this.resolveModel(selectedModel)
    if (!model) throw new SessionServiceError("invalid_request", "No model configured")
    const agent = input.agent?.trim() || session.agent
    if (!this.agentService.hasAgent(agent)) {
      throw new SessionServiceError("invalid_request", `Agent not found: ${agent}`)
    }

    const user = this.messages.createUserMessage(sessionID, agent, model, input.messageID)
    const userTextPart = this.messages.createPart(sessionID, user.id, "text", {
      text: "The following tool was executed by the user",
      time: { start: Date.now() },
      synthetic: true,
    })
    this.publishMessage(user)
    // Shell mode is fire-and-forget on the client (no optimistic message), so
    // the user-side text part must be streamed explicitly to render.
    this.publishPart(userTextPart.id)

    const assistant = this.messages.createAssistantMessage(sessionID, user.id, agent, model)
    this.publishMessage(assistant)

    const callID = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
    const started = Date.now()
    const toolPart = this.messages.createPart(sessionID, assistant.id, "tool", {
      callID,
      tool: "bash",
      state: {
        status: "running",
        input: { command: input.command },
        time: { start: started },
      },
    })
    this.publishPart(toolPart.id)

    void this.executeShell(assistant.id, toolPart.id, input.command, session.directory, started)
  }

  private async executeShell(
    assistantMessageId: string,
    toolPartId: string,
    command: string,
    cwd: string,
    started: number,
  ): Promise<void> {
    let lastPublish = 0
    const result = await runShellCommand(command, {
      cwd,
      onOutput: (_chunk, accumulated) => {
        const now = Date.now()
        if (now - lastPublish < 150) return
        lastPublish = now
        const current = this.messages.getPart(toolPartId)
        if (!current || current.type !== "tool") return
        this.messages.updatePart(toolPartId, {
          state: { ...current.state, output: accumulated, metadata: { output: accumulated } },
        })
        this.publishPart(toolPartId)
      },
    })

    const completed = Date.now()
    const current = this.messages.getPart(toolPartId)
    const baseState =
      current && current.type === "tool" ? current.state : { status: "running" as const, input: { command } }
    const failed = result.error !== undefined
    this.messages.updatePart(toolPartId, {
      state: {
        ...baseState,
        status: failed ? "error" : "completed",
        input: { command },
        output: result.output,
        ...(failed ? { error: result.error } : {}),
        metadata: { output: result.output, exitCode: result.exitCode },
        time: { start: started, end: completed },
      },
    })
    this.publishPart(toolPartId)
    this.messages.completeMessage(assistantMessageId, failed ? "error" : "stop")
    this.publishMessage(this.messages.getMessage(assistantMessageId)!)
  }

  private enableWideIdsFromMessage(sessionID: string, messageID: string | undefined): void {
    if (messageID?.startsWith("msg_-")) this.sessions.enableWideIds(sessionID)
  }

  requireSession(sessionID: string): Session {
    const session = this.sessions.get(sessionID)
    if (!session) throw new SessionServiceError("not_found", `Session not found: ${sessionID}`, { sessionID })
    return session
  }

  requireMessage(sessionID: string, messageID: string): MessageWithParts {
    this.requireSession(sessionID)
    const info = this.messages.getMessage(messageID)
    if (!info || info.sessionID !== sessionID) {
      throw new SessionServiceError("message_not_found", `Message not found: ${messageID}`, {
        sessionID,
        messageID,
      })
    }
    return { info, parts: this.messages.listParts(messageID) }
  }

  private publishMessage(info: MessageWithParts["info"]): void {
    this.events.publish(createEvent("message.updated", { sessionID: info.sessionID, info }))
  }

  private publishPart(partId: string): void {
    const part = this.messages.getPart(partId)
    if (!part) return
    this.events.publish(createEvent("message.part.updated", { sessionID: part.sessionID, part, time: Date.now() }))
  }

  private publishStatus(sessionID: string, status: "busy" | "idle"): void {
    this.events.publish(createEvent("session.status", { sessionID, status: { type: status } }))
    if (status === "idle") this.events.publish(createEvent("session.idle", { sessionID }))
  }

  private appendSessionEvent(sessionID: string, type: string, data: Record<string, unknown>) {
    const session = this.sessions.get(sessionID)
    return this.sessionEvents.append(sessionID, type, data, session ? { directory: session.directory } : undefined)
  }

  private projectRuntimeEvent(event: OpenCodeEvent): void {
    const properties = event.properties as {
      sessionID?: string
      info?: MessageWithParts["info"]
      part?: Part
    }
    const sessionID = properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
    if (!sessionID) return
    if (event.type === "message.updated" && properties.info?.role === "assistant") {
      const info = properties.info
      if (info.time.completed === undefined && !info.error) return
      const key = `${info.id}:terminal`
      if (this.projectedTerminalEvents.has(key)) return
      this.projectedTerminalEvents.add(key)
      if (info.error) {
        this.appendSessionEvent(sessionID, "session.next.step.failed", {
          timestamp: info.time.completed ?? Date.now(),
          sessionID,
          assistantMessageID: info.id,
          error: { type: "unknown", message: info.error.data.message },
        })
        return
      }
      this.appendSessionEvent(sessionID, "session.next.step.ended", {
        timestamp: info.time.completed ?? Date.now(),
        sessionID,
        assistantMessageID: info.id,
        finish: info.finish ?? "stop",
        cost: info.cost,
        tokens: info.tokens,
      })
      return
    }
    if (event.type !== "message.part.updated" || !properties.part) return
    const part = properties.part
    if (part.type !== "text" && part.type !== "reasoning") return
    if (part.time?.end === undefined) return
    const key = `${part.id}:terminal`
    if (this.projectedTerminalEvents.has(key)) return
    this.projectedTerminalEvents.add(key)
    this.appendSessionEvent(
      sessionID,
      part.type === "text" ? "session.next.text.ended" : "session.next.reasoning.ended",
      {
        timestamp: part.time.end,
        sessionID,
        assistantMessageID: part.messageID,
        ...(part.type === "text" ? { textID: part.id } : { reasoningID: part.id }),
        text: part.text,
      },
    )
  }

  private conversationError(error: unknown): SessionServiceError {
    if (error instanceof SessionServiceError) return error
    if (error instanceof AgentConversationError) {
      const code = error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : "invalid_request"
      return new SessionServiceError(code, error.message)
    }
    return new SessionServiceError("invalid_request", error instanceof Error ? error.message : String(error))
  }
}
