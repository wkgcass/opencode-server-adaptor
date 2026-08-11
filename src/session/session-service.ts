import type { AgentService } from "../agents/agent-service.ts"
import { AgentConversationError } from "../agents/agent-service.ts"
import type { AppConfig } from "../config/index.ts"
import type { ProviderConfigStore } from "../config/provider-config.ts"
import type { EventBus } from "../event/index.ts"
import { createEvent } from "../event/index.ts"
import type { SessionEventStore } from "../event/session-event-store.ts"
import { publishSessionIdleLegacy } from "../event/session-events-legacy.ts"
import { eventIdForMessageId, orderedIdFormat } from "../id/index.ts"
import type { MessageRepository, MessageWithParts } from "../message/index.ts"
import type { Session, SessionRepository } from "./index.ts"
import { buildDefaultProviderMap, buildProviders, type BuiltinProviderDefinition } from "../provider/index.ts"
import { runShellCommand } from "./shell-runner.ts"
import type { CommandService } from "../skill/command-service.ts"
import { CommandNotFoundError } from "../skill/command-service.ts"

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

export interface SessionCommandRequest {
  messageID?: string
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
  command: string
  arguments: string
  files?: Array<{
    uri: string
    mime?: string
    name?: string
    description?: string
    source?: Record<string, unknown>
  }>
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

function forkedSessionTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (!match) return `${title} (fork #1)`
  return `${match[1]} (fork #${Number(match[2]) + 1})`
}

export class SessionService {
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
    private readonly commands: CommandService,
  ) {}

  close(): void {}

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
      const messageID = this.messages.nextMessageId(sessionID)
      this.publishCurrentSessionEvent(
        sessionID,
        "session.agent.selected",
        {
          sessionID,
          agent: input.agent,
        },
        { id: eventIdForMessageId(messageID) },
      )
    }
    if (
      input.model &&
      (input.model.id !== previous.model?.id || input.model.providerID !== previous.model?.providerID)
    ) {
      const messageID = this.messages.nextMessageId(sessionID)
      this.publishCurrentSessionEvent(
        sessionID,
        "session.model.selected",
        {
          sessionID,
          model: input.model,
        },
        { id: eventIdForMessageId(messageID) },
      )
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

  async fork(sessionID: string, messageID?: string): Promise<Session> {
    const source = this.requireSession(sessionID)
    if (["busy", "running", "waiting_permission"].includes(source.status)) {
      throw new SessionServiceError("conflict", "Session is busy")
    }
    if (messageID) {
      const message = this.messages.getMessage(messageID)
      if (!message || message.sessionID !== sessionID) {
        throw new SessionServiceError("message_not_found", `Message not found: ${messageID}`, { messageID })
      }
      if (message.role !== "user") {
        throw new SessionServiceError("invalid_request", "Session forks require a user message", { messageID })
      }
    }

    const target = this.sessions.create({
      directory: source.directory,
      title: forkedSessionTitle(source.title),
      agent: source.agent,
      model: source.model ? { ...source.model } : undefined,
      metadata: source.metadata ? structuredClone(source.metadata) : undefined,
      permission: source.permission ? structuredClone(source.permission) : undefined,
      idFormat: this.sessions.getIdFormat(source.id),
    })

    try {
      this.messages.cloneMessagesBefore(source.id, target.id, messageID)
      await this.agentService.createSessionFork(source.id, target.id, messageID)
    } catch (error) {
      this.sessions.delete(target.id)
      throw this.conversationError(error)
    }

    const forked = this.requireSession(target.id)
    this.events.publish(createEvent("session.created", { sessionID: forked.id, info: forked }))
    this.events.publish(
      createEvent("session.forked", {
        sessionID: forked.id,
        sourceSessionID: source.id,
        ...(messageID ? { messageID } : {}),
      }),
    )
    return forked
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
      this.publishCurrentSessionEvent(sessionID, "session.revert.staged", {
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
      this.publishCurrentSessionEvent(sessionID, "session.revert.cleared", {
        sessionID,
      })
      return session
    } catch (error) {
      throw this.conversationError(error)
    }
  }

  async commitRevert(sessionID: string): Promise<void> {
    const target = this.requireSession(sessionID).revert?.messageID
    try {
      await this.agentService.commitRevert(sessionID)
      if (!target) return
      this.publishCurrentSessionEvent(sessionID, "session.revert.committed", {
        sessionID,
        to: target,
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
    await this.commitRevert(sessionID)
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

    const prompt = {
      text: promptSegments.join("\n\n"),
      ...(files.length ? { files } : {}),
      ...(agents.length ? { agents } : {}),
    }
    const delivery = input.delivery ?? "steer"
    const admitted = this.publishCurrentSessionEvent(
      sessionID,
      "session.input.admitted",
      {
        sessionID,
        inputID: user.id,
        input: { type: "user", delivery, data: prompt },
      },
      { created: user.time.created },
    )
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
    admission.assistantMessageID = assistant.id
    const promoted = this.publishCurrentSessionEvent(sessionID, "session.input.promoted", {
      sessionID,
      inputID: user.id,
    })
    admission.promotedSeq = promoted.durable.seq

    if (input.noReply) {
      this.messages.completeMessage(assistant.id, "stop")
      this.agentService.startAssistantStep(assistant.id)
      this.agentService.settleAssistantMessage(assistant.id)
      return admission
    }

    const text = [input.system?.trim(), ...promptSegments].filter(Boolean).join("\n\n")
    if (isFirstUserMessage && text) {
      this.agentService.generateTitle(sessionID, promptSegments.join("\n\n") || text, model)
    }
    this.sessions.setStatus(sessionID, "busy")
    this.agentService.startExecution(sessionID)
    this.agentService.startAssistantStep(assistant.id)
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

  async command(sessionID: string, input: SessionCommandRequest): Promise<SessionPromptAdmission> {
    const session = this.requireSession(sessionID)
    let command
    try {
      command = await this.commands.require(session.directory, input.command, input.arguments)
    } catch (error) {
      if (error instanceof CommandNotFoundError) {
        throw new SessionServiceError("invalid_request", error.message, {
          command: error.commandName,
          available: error.available,
        })
      }
      throw error
    }

    const model = command.model
      ? { providerID: command.model.providerID, modelID: command.model.id, variant: command.model.variant }
      : input.model
    return this.prompt(sessionID, {
      messageID: input.messageID,
      agent: command.agent ?? input.agent,
      model,
      parts: [
        {
          type: "text",
          text: command.template,
          metadata: {
            command: {
              name: command.name,
              source: command.source,
              revision: command.revision,
            },
          },
        },
        ...(input.files ?? []).map((file) => ({
          type: "file",
          uri: file.uri,
          mime: file.mime ?? "application/octet-stream",
          name: file.name,
          description: file.description,
          source: file.source,
        })),
      ],
    })
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

    const created = Date.now()
    const shellPrompt = "The following tool was executed by the user"
    const user = this.messages.createUserMessage(sessionID, agent, model, input.messageID)
    this.messages.createPart(sessionID, user.id, "text", {
      text: shellPrompt,
      time: { start: created, end: created },
      synthetic: true,
    })
    this.publishCurrentSessionEvent(
      sessionID,
      "session.input.admitted",
      {
        sessionID,
        inputID: user.id,
        input: { type: "user", delivery: "steer", data: { text: shellPrompt } },
      },
      { created: user.time.created },
    )
    this.publishCurrentSessionEvent(sessionID, "session.input.promoted", { sessionID, inputID: user.id })

    const assistant = this.messages.createAssistantMessage(sessionID, user.id, agent, model)

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
    this.sessions.setStatus(sessionID, "busy")
    this.agentService.startExecution(sessionID)
    this.agentService.startAssistantStep(assistant.id)
    this.agentService.projectToolRunning(toolPart.id)

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
        this.agentService.projectToolProgress(toolPartId, { output: accumulated })
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
    this.agentService.projectToolTerminal(toolPartId)
    this.messages.completeMessage(assistantMessageId, failed ? "error" : "stop")
    this.agentService.settleAssistantMessage(assistantMessageId)
    const assistant = this.messages.getMessage(assistantMessageId)
    const sessionID = current?.sessionID ?? assistant?.sessionID
    if (sessionID) {
      if (failed) this.agentService.failExecution(sessionID, result.error ?? "Shell command failed")
      else this.agentService.succeedExecution(sessionID)
      this.sessions.setStatus(sessionID, "idle")
      publishSessionIdleLegacy(this.events, sessionID)
    }
  }

  private enableWideIdsFromMessage(sessionID: string, messageID: string | undefined): void {
    if (orderedIdFormat(messageID) === "wide") this.sessions.enableWideIds(sessionID)
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

  private publishCurrentSessionEvent(
    sessionID: string,
    type: string,
    data: Record<string, unknown>,
    options?: { id?: string; created?: number; metadata?: Record<string, unknown>; version?: number },
  ) {
    const session = this.sessions.get(sessionID)
    const event = this.sessionEvents.append(
      sessionID,
      type,
      data,
      session ? { directory: session.directory } : undefined,
      options,
    )
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
    return event
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
