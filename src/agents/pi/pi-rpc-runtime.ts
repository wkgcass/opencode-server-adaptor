import type {
  AgentRuntime,
  AgentCompactionResult,
  AgentForkResult,
  AgentRuntimeContext,
  AgentRuntimeEvent,
  PermissionResponse,
  PromptInput,
} from "../agent-adapter.ts"
import { PiRpcTransport } from "./pi-rpc-transport.ts"
import { PiToOpenCodeEventMapper } from "./pi-event-mapper.ts"
import type { PiRpcMessage, PiEvent } from "./types.ts"
import { createHash } from "node:crypto"
import { createPartId } from "../../id/index.ts"
import type { PiConversationSessionState, PiConversationStore } from "./pi-conversation-store.ts"

export interface PiRpcRuntimeOptions {
  cliPath: string
  args?: string[]
  sessionDir: string
  rpcTimeoutMs: number
  startTimeoutMs: number
  agentDir?: string
  beforeStart?: () => void
  provider?: string
  model?: string
  systemPrompt?: string
  extensionPaths?: string[]
  planMode?: boolean
  planModeFallback?: boolean
  conversationStore?: PiConversationStore
}

interface PiSessionState {
  sessionId: string
  sessionFile?: string
}

interface PiSessionEntry {
  id?: unknown
  type?: unknown
  message?: {
    role?: unknown
  }
}

export class PiRpcRuntime implements AgentRuntime {
  private transport: PiRpcTransport | null = null
  private readonly listeners = new Set<(event: AgentRuntimeEvent) => void>()
  private readonly context: AgentRuntimeContext
  private readonly options: PiRpcRuntimeOptions
  private readonly logger: AgentRuntimeContext["logger"]
  private mapper: PiToOpenCodeEventMapper | null = null
  private currentAssistantMessageId: string | null = null
  private currentPromptCompleted = false
  private promptGeneration = 0
  private terminalFallbackTimer: ReturnType<typeof setTimeout> | null = null
  private readonly piSessionId: string
  private currentPromptSettlement: {
    generation: number
    resolve: () => void
    reject: (error: Error) => void
    failure?: Error
  } | null = null
  private currentPromptStarted = false
  private terminalStateCheckFailures = 0
  private compactionEventsSeen = 0
  private readonly pendingUiRequests = new Map<
    string,
    {
      method: string
      options?: string[]
      placeholder?: string
      prefill?: string
    }
  >()

  constructor(context: AgentRuntimeContext, options: PiRpcRuntimeOptions) {
    this.context = context
    this.options = options
    this.logger = context.logger
    const hex = createHash("sha256").update(context.sessionId).digest("hex")
    const deterministicId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    this.piSessionId = options.conversationStore?.getSession(context.sessionId).activeSessionId ?? deterministicId
  }

  async start(): Promise<void> {
    if (this.transport) {
      throw new Error("Runtime already started")
    }

    this.options.beforeStart?.()
    const args = this.options.args ?? ["--mode", "rpc"]
    if (!this.options.args) {
      if (this.options.provider) args.push("--provider", this.options.provider)
      if (this.options.model) args.push("--model", this.options.model)
      if (this.options.systemPrompt?.trim()) {
        args.push("--append-system-prompt", this.options.systemPrompt)
      }
      for (const extensionPath of this.options.extensionPaths ?? []) {
        args.push("--extension", extensionPath)
      }
      if (this.options.planMode) args.push("--plan")
      if (this.options.planModeFallback) args.push("--tools", "read,grep,find,ls")
      const persisted = this.options.conversationStore?.getSession(this.context.sessionId)
      args.push("--session-dir", this.options.sessionDir)
      if (persisted?.activeSessionFile) {
        args.push("--session", persisted.activeSessionFile)
      } else {
        args.push("--session-id", this.piSessionId)
      }
    }

    this.transport = new PiRpcTransport({
      cliPath: this.options.cliPath,
      args,
      cwd: this.context.directory,
      env: {
        ...(this.options.agentDir ? { PI_CODING_AGENT_DIR: this.options.agentDir } : {}),
        ...(this.logger.isVerbose?.() ? { OPENCODE_ADAPTOR_VERBOSE: "1" } : {}),
      },
      rpcTimeoutMs: this.options.rpcTimeoutMs,
      startTimeoutMs: this.options.startTimeoutMs,
      logger: this.logger,
    })

    // Subscribe before spawning Pi. The subprocess can emit valid session or
    // extension events immediately after stdout becomes readable; subscribing
    // after start creates a race where verbose wire logs show an event that no
    // OpenCode projector ever received.
    this.transport.subscribe((message: PiRpcMessage) => {
      if (message.type !== "response") {
        this.handlePiEvent(message as PiEvent)
      }
    })
    this.transport.subscribeExit((error) => {
      this.handleTransportExit(error)
    })

    await this.transport.start()

    const state = await this.getPiSessionState()
    this.persistActiveSession(state)

    this.emit({ type: "session_started", sessionId: this.context.sessionId })
  }

  async stop(): Promise<void> {
    this.clearTerminalFallback()
    const settlement = this.currentPromptSettlement
    if (settlement) {
      const error = settlement.failure ?? new Error("Pi Runtime stopped before the current prompt settled")
      settlement.failure = error
      settlement.reject(error)
    }
    if (this.transport) {
      await this.transport.stop()
      this.transport = null
    }
    this.emit({ type: "session_stopped", sessionId: this.context.sessionId })
  }

  async prompt(input: PromptInput): Promise<void> {
    this.setupMapper(input.assistantMessageId)
    const generation = this.promptGeneration
    const settled = new Promise<void>((resolve, reject) => {
      this.currentPromptSettlement = { generation, resolve, reject }
    })
    // Pi can exit while post-response bookkeeping is still running. Attach a
    // rejection handler immediately so the process fault is not reported as an
    // unhandled rejection before this method reaches `await settled`.
    void settled.catch(() => undefined)

    try {
      const entryIdsBefore = this.options.conversationStore ? await this.getEntryIds() : new Set<string>()
      await this.transport!.send({
        type: "prompt",
        message: input.text,
      })
      // `prompt` only acknowledges Pi preflight. Keep an independent liveness
      // watchdog for custom/older builds that omit either terminal event.
      this.scheduleTerminalFallback()
      try {
        await this.capturePromptEntrySoon(input.messageId, entryIdsBefore)
        await this.settlePromptWithoutAgentRun(generation)
      } catch (error) {
        // Preserve the authoritative subprocess-exit error instead of a later
        // "Transport not started" error from bookkeeping RPCs.
        const failure =
          this.currentPromptSettlement?.generation === generation ? this.currentPromptSettlement.failure : undefined
        if (failure) throw failure
        if (this.transport?.isClosed) await settled
        throw error
      }
      await settled
      if (!this.options.conversationStore?.getMessageEntryId(input.messageId)) {
        await this.capturePromptEntry(input.messageId, entryIdsBefore, true)
      }
    } finally {
      if (this.currentPromptSettlement?.generation === generation) {
        this.currentPromptSettlement = null
      }
    }
  }

  async fork(input: { messageId: string }): Promise<AgentForkResult> {
    if (!this.transport) throw new Error("Runtime is not started")
    const store = this.options.conversationStore
    if (!store) throw new Error("Pi conversation persistence is not configured")
    const entryId = store.getMessageEntryId(input.messageId)
    if (!entryId) {
      throw new Error(`Pi entry mapping is missing for OpenCode message '${input.messageId}'`)
    }

    const previous = await this.getPiSessionState()
    if (!previous.sessionFile) throw new Error("Pi session file is unavailable; the conversation cannot be forked")
    const response = await this.transport.send({ type: "fork", entryId })
    const data = response.data as { cancelled?: boolean } | undefined
    if (data?.cancelled === true) throw new Error("Pi cancelled the conversation fork")

    const forked = await this.getPiSessionState()
    if (!forked.sessionFile) throw new Error("Pi did not return a session file after forking")
    const existing = store.getSession(this.context.sessionId)
    const original = existing.revert
      ? {
          sessionId: existing.revert.previousSessionId,
          sessionFile: existing.revert.previousSessionFile,
        }
      : previous
    store.setSession(this.context.sessionId, {
      activeSessionId: forked.sessionId,
      activeSessionFile: forked.sessionFile,
      revert: {
        previousSessionId: original.sessionId,
        previousSessionFile: original.sessionFile!,
        forkedSessionId: forked.sessionId,
        forkedSessionFile: forked.sessionFile,
      },
    })
    return { backendSessionId: forked.sessionId }
  }

  async restoreFork(): Promise<AgentForkResult> {
    if (!this.transport) throw new Error("Runtime is not started")
    const store = this.options.conversationStore
    if (!store) throw new Error("Pi conversation persistence is not configured")
    const persisted = store.getSession(this.context.sessionId)
    if (!persisted.revert) throw new Error("No Pi conversation fork is available to restore")

    const response = await this.transport.send({
      type: "switch_session",
      sessionPath: persisted.revert.previousSessionFile,
    })
    const data = response.data as { cancelled?: boolean } | undefined
    if (data?.cancelled === true) throw new Error("Pi cancelled restoring the previous conversation")

    const restored = await this.getPiSessionState()
    store.setSession(this.context.sessionId, {
      activeSessionId: restored.sessionId,
      activeSessionFile: restored.sessionFile ?? persisted.revert.previousSessionFile,
    })
    return { backendSessionId: restored.sessionId }
  }

  async commitFork(): Promise<void> {
    const store = this.options.conversationStore
    if (!store) return
    const persisted = store.getSession(this.context.sessionId)
    if (!persisted.revert) return
    store.setSession(this.context.sessionId, {
      activeSessionId: persisted.activeSessionId,
      activeSessionFile: persisted.activeSessionFile,
    })
  }

  async abort(): Promise<void> {
    if (!this.transport) return
    await this.transport.send({ type: "abort" })
    if (this.currentPromptSettlement) {
      this.finishCurrentPrompt("aborted")
    } else {
      this.emit({ type: "session_idle", sessionId: this.context.sessionId })
    }
  }

  async compact(input?: { customInstructions?: string }): Promise<AgentCompactionResult> {
    if (!this.transport) throw new Error("Runtime is not started")
    const seenBefore = this.compactionEventsSeen
    const response = await this.transport.send({
      type: "compact",
      ...(input?.customInstructions?.trim() ? { customInstructions: input.customInstructions.trim() } : {}),
    })
    const result = this.normalizeCompactionResult(response.data)
    if (this.compactionEventsSeen === seenBefore) {
      this.emit({
        type: "compaction_started",
        sessionId: this.context.sessionId,
        reason: "manual",
        backendReason: "manual",
      })
      this.emit({
        type: "compaction_completed",
        sessionId: this.context.sessionId,
        reason: "manual",
        backendReason: "manual",
        result,
      })
    }
    return result
  }

  async respondToPermission(requestId: string, response: PermissionResponse): Promise<void> {
    const request = this.pendingUiRequests.get(requestId)
    const cmd: Record<string, unknown> = {
      type: "extension_ui_response",
      id: requestId,
    }
    if (response.type !== "allow") {
      cmd.cancelled = true
    } else if (request?.method === "confirm") {
      cmd.confirmed = true
    } else if (request?.method === "select") {
      const options = request.options ?? []
      cmd.value =
        options.find((option) => /^(allow|yes|continue|approve|ok)$/i.test(option.trim())) ?? options[0] ?? "Allow"
    } else if (request?.method === "input") {
      cmd.value = request.placeholder ?? ""
    } else if (request?.method === "editor") {
      cmd.value = request.prefill ?? ""
    } else {
      cmd.value = "Allow"
    }
    await this.transport!.notify(cmd as { type: string; id: string })
    this.pendingUiRequests.delete(requestId)
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setupMapper(assistantMessageId: string): void {
    this.clearTerminalFallback()
    this.promptGeneration++
    this.currentAssistantMessageId = assistantMessageId
    this.currentPromptCompleted = false
    this.currentPromptStarted = false
    this.terminalStateCheckFailures = 0
    this.mapper = new PiToOpenCodeEventMapper({
      sessionId: this.context.sessionId,
      assistantMessageId,
      partIdMap: new Map(),
      generatePartId: () => createPartId(),
      onUnmapped: (event, reason) => this.warnUnprojectedPiEvent(event, "mapping", reason),
    })
  }

  private handlePiEvent(event: PiEvent): void {
    if (event.type === "compaction_start") {
      this.compactionEventsSeen++
      const backendReason = typeof event.reason === "string" ? event.reason : "manual"
      const delivered = this.emit({
        type: "compaction_started",
        sessionId: this.context.sessionId,
        reason: backendReason === "manual" ? "manual" : "auto",
        backendReason,
      })
      if (!delivered) {
        this.warnUnprojectedPiEvent(event, "runtime_delivery", "Pi Runtime has no accepting event subscriber")
      }
      return
    }
    if (event.type === "compaction_end") {
      this.compactionEventsSeen++
      const backendReason = typeof event.reason === "string" ? event.reason : "manual"
      const reason = backendReason === "manual" ? "manual" : "auto"
      if (event.result && typeof event.result === "object") {
        const delivered = this.emit({
          type: "compaction_completed",
          sessionId: this.context.sessionId,
          reason,
          backendReason,
          result: this.normalizeCompactionResult(event.result),
          willRetry: event.willRetry === true,
        })
        if (!delivered) {
          this.warnUnprojectedPiEvent(event, "runtime_delivery", "Pi Runtime has no accepting event subscriber")
        }
      } else {
        const delivered = this.emit({
          type: "compaction_failed",
          sessionId: this.context.sessionId,
          reason,
          backendReason,
          error:
            typeof event.errorMessage === "string"
              ? event.errorMessage
              : event.aborted === true
                ? "Compaction was aborted"
                : "Compaction failed",
          aborted: event.aborted === true,
          willRetry: event.willRetry === true,
        })
        if (!delivered) {
          this.warnUnprojectedPiEvent(event, "runtime_delivery", "Pi Runtime has no accepting event subscriber")
        }
      }
      return
    }
    if (event.type === "extension_error") {
      const delivered = this.emit({
        type: "session_error",
        sessionId: this.context.sessionId,
        ...(this.currentPromptSettlement && this.currentAssistantMessageId
          ? { messageId: this.currentAssistantMessageId }
          : {}),
        error: {
          type: "extension_error",
          message: typeof event.error === "string" ? event.error : "Extension error",
        },
        fatal: false,
      })
      if (!delivered) {
        this.warnUnprojectedPiEvent(event, "runtime_delivery", "Pi Runtime has no accepting event subscriber")
      }
      return
    }
    if (event.type === "session_info_changed") {
      const title = typeof event.name === "string" ? event.name.trim() : ""
      if (!title) {
        this.warnUnprojectedPiEvent(event, "mapping", "Pi session metadata did not contain a non-empty name")
        return
      }
      const delivered = this.emit({
        type: "session_title_changed",
        sessionId: this.context.sessionId,
        title,
      })
      if (!delivered) {
        this.warnUnprojectedPiEvent(event, "runtime_delivery", "Pi Runtime has no accepting event subscriber")
      }
      return
    }
    if (event.type === "extension_ui_request") {
      const id = typeof event.id === "string" ? event.id : ""
      const method = typeof event.method === "string" ? event.method : ""
      if (id && ["select", "confirm", "input", "editor"].includes(method)) {
        this.pendingUiRequests.set(id, {
          method,
          options: Array.isArray(event.options)
            ? event.options.filter((option): option is string => typeof option === "string")
            : undefined,
          placeholder: typeof event.placeholder === "string" ? event.placeholder : undefined,
          prefill: typeof event.prefill === "string" ? event.prefill : undefined,
        })
      }
    }
    if (!this.mapper) {
      this.warnUnprojectedPiEvent(event, "mapping", "No active OpenCode assistant message mapper")
      return
    }

    if (event.type === "agent_start") {
      this.currentPromptStarted = true
    }
    let events: AgentRuntimeEvent[]
    try {
      events = this.mapper.map(event)
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error))
      this.warnUnprojectedPiEvent(event, "mapping_error", cause.message)
      this.failRuntime(new Error(`Failed to map Pi event '${event.type}': ${cause.message}`), "event_mapping_failed")
      return
    }
    if (events.some((mapped) => mapped.type === "message_completed")) {
      this.currentPromptCompleted = true
    }

    if (event.type === "agent_settled" && !this.currentPromptCompleted && this.currentAssistantMessageId) {
      // agent_settled is the authoritative idle boundary. A terminal agent_end
      // can be absent on older/custom Pi builds, so never leave the OpenCode
      // assistant message open when Pi itself declares the run settled.
      events.unshift({
        type: "message_completed",
        sessionId: this.context.sessionId,
        messageId: this.currentAssistantMessageId,
        finish: "stop",
      })
      this.currentPromptCompleted = true
    }

    let delivered = false
    for (const e of events) {
      delivered = this.emit(e) || delivered
    }
    if (events.length > 0 && !delivered) {
      this.warnUnprojectedPiEvent(event, "runtime_delivery", "Pi Runtime has no accepting event subscriber")
    }

    if (event.type === "agent_settled") {
      this.clearTerminalFallback()
      this.currentPromptSettlement?.resolve()
      return
    }

    if (event.type === "agent_end" && event.willRetry !== true) {
      this.scheduleTerminalFallback()
    }
  }

  private clearTerminalFallback(): void {
    if (!this.terminalFallbackTimer) return
    clearTimeout(this.terminalFallbackTimer)
    this.terminalFallbackTimer = null
  }

  private scheduleTerminalFallback(): void {
    this.clearTerminalFallback()
    const generation = this.promptGeneration
    this.terminalFallbackTimer = setTimeout(() => {
      this.terminalFallbackTimer = null
      void this.recoverMissingAgentSettled(generation)
    }, 1000)
  }

  private async recoverMissingAgentSettled(generation: number): Promise<void> {
    if (generation !== this.promptGeneration || !this.currentPromptSettlement) return

    try {
      const state = await this.transport?.send({ type: "get_state" })
      this.terminalStateCheckFailures = 0
      const data = state?.data as { isStreaming?: boolean; pendingMessageCount?: number } | undefined
      if (data?.isStreaming === true || (data?.pendingMessageCount ?? 0) > 0) {
        // An agent_end extension queued more work. Pi will eventually emit the
        // real agent_settled event. Keep the compatibility watchdog armed so a
        // custom/older Pi build cannot leave this prompt pending forever after
        // the queued continuation later becomes idle.
        this.scheduleTerminalFallback()
        return
      }
    } catch (err) {
      if (this.transport?.isClosed) return
      this.terminalStateCheckFailures++
      this.logger.warn("Could not verify Pi idle state while waiting for prompt settlement", {
        attempt: this.terminalStateCheckFailures,
        error: err instanceof Error ? err.message : String(err),
      })
      if (this.terminalStateCheckFailures >= 3) {
        this.failRuntime(
          new Error(
            `Pi state probe failed ${this.terminalStateCheckFailures} times: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
          "state_probe_failed",
        )
      } else {
        this.scheduleTerminalFallback()
      }
      return
    }

    this.finishCurrentPrompt("stop")
    this.logger.warn("Recovered missing Pi agent_settled event", {
      sessionId: this.context.sessionId,
      messageId: this.currentAssistantMessageId,
    })
  }

  private async settlePromptWithoutAgentRun(generation: number): Promise<void> {
    let consecutiveIdleChecks = 0
    for (let attempt = 0; attempt < 3; attempt++) {
      if (
        generation !== this.promptGeneration ||
        this.currentPromptStarted ||
        !this.currentPromptSettlement ||
        this.currentPromptSettlement.generation !== generation
      ) {
        return
      }
      await Bun.sleep(10)
      const response = await this.transport?.send({ type: "get_state" })
      const data = response?.data as { isStreaming?: boolean; pendingMessageCount?: number } | undefined
      if (data?.isStreaming === true || (data?.pendingMessageCount ?? 0) > 0) return
      consecutiveIdleChecks++
      if (consecutiveIdleChecks >= 2) {
        this.finishCurrentPrompt("stop")
        this.logger.debug("Pi prompt completed without starting an agent run", {
          sessionId: this.context.sessionId,
          messageId: this.currentAssistantMessageId,
        })
        return
      }
    }
  }

  private finishCurrentPrompt(finish: string): void {
    this.clearTerminalFallback()
    this.terminalStateCheckFailures = 0
    if (!this.currentPromptCompleted && this.currentAssistantMessageId) {
      this.emit({
        type: "message_completed",
        sessionId: this.context.sessionId,
        messageId: this.currentAssistantMessageId,
        finish,
      })
      this.currentPromptCompleted = true
    }
    this.emit({ type: "session_idle", sessionId: this.context.sessionId })
    this.currentPromptSettlement?.resolve()
  }

  private handleTransportExit(error: Error): void {
    this.failRuntime(error, "transport_exit")
  }

  private failRuntime(error: Error, type: string): void {
    this.clearTerminalFallback()
    const settlement = this.currentPromptSettlement
    if (settlement) settlement.failure = error
    this.emit({
      type: "runtime_fault",
      sessionId: this.context.sessionId,
      messageId: settlement ? (this.currentAssistantMessageId ?? undefined) : undefined,
      error: { type, message: error.message },
    })
    settlement?.reject(error)
  }

  private warnUnprojectedPiEvent(event: PiEvent, stage: string, reason: string): void {
    const update =
      event.type === "message_update"
        ? (event.assistantMessageEvent as { type?: unknown } | undefined)?.type
        : undefined
    const role =
      event.type === "message_start" || event.type === "message_end"
        ? (event.message as { role?: unknown } | undefined)?.role
        : undefined
    this.logger.warn("Pi event produced no OpenCode event", {
      sessionId: this.context.sessionId,
      piEvent: event.type,
      ...(typeof update === "string" ? { piUpdate: update } : {}),
      ...(typeof role === "string" ? { piRole: role } : {}),
      stage,
      reason,
    })
  }

  private emit(event: AgentRuntimeEvent): boolean {
    let delivered = 0
    for (const listener of this.listeners) {
      try {
        listener(event)
        delivered++
      } catch {}
    }
    return delivered > 0
  }

  private async getPiSessionState(): Promise<PiSessionState> {
    if (!this.transport) throw new Error("Runtime is not started")
    const response = await this.transport.send({ type: "get_state" })
    const data = response.data as { sessionId?: unknown; sessionFile?: unknown } | undefined
    if (typeof data?.sessionId !== "string" || !data.sessionId) {
      throw new Error("Pi get_state response did not contain a sessionId")
    }
    return {
      sessionId: data.sessionId,
      sessionFile: typeof data.sessionFile === "string" && data.sessionFile ? data.sessionFile : undefined,
    }
  }

  private persistActiveSession(state: PiSessionState): void {
    const store = this.options.conversationStore
    if (!store) return
    const existing = store.getSession(this.context.sessionId)
    const next: PiConversationSessionState = {
      activeSessionId: state.sessionId,
      activeSessionFile: state.sessionFile,
      ...(existing.revert ? { revert: existing.revert } : {}),
    }
    store.setSession(this.context.sessionId, next)
  }

  private async getEntries(): Promise<PiSessionEntry[]> {
    if (!this.transport) throw new Error("Runtime is not started")
    const response = await this.transport.send({ type: "get_entries" })
    const data = response.data as { entries?: unknown } | undefined
    return Array.isArray(data?.entries) ? (data.entries as PiSessionEntry[]) : []
  }

  private async getEntryIds(): Promise<Set<string>> {
    return new Set(
      (await this.getEntries())
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    )
  }

  private async capturePromptEntry(messageId: string, before: Set<string>, warnIfMissing: boolean): Promise<boolean> {
    const store = this.options.conversationStore
    if (!store || store.getMessageEntryId(messageId)) return true
    const entry = (await this.getEntries()).find(
      (candidate) =>
        typeof candidate.id === "string" &&
        !before.has(candidate.id) &&
        candidate.type === "message" &&
        candidate.message?.role === "user",
    )
    if (!entry || typeof entry.id !== "string") {
      if (warnIfMissing) {
        this.logger.warn("Could not map OpenCode user message to a Pi session entry", {
          sessionId: this.context.sessionId,
          messageId,
        })
      }
      return false
    }
    store.setMessageEntryId(messageId, entry.id)
    return true
  }

  private async capturePromptEntrySoon(messageId: string, before: Set<string>): Promise<void> {
    if (!this.options.conversationStore) return
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await this.capturePromptEntry(messageId, before, false)) return
      await Bun.sleep(10)
    }
  }

  private normalizeCompactionResult(value: unknown): AgentCompactionResult {
    const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
    const usage = input.usage && typeof input.usage === "object" ? (input.usage as Record<string, unknown>) : undefined
    const cost = usage?.cost && typeof usage.cost === "object" ? (usage.cost as Record<string, unknown>) : undefined
    return {
      summary: typeof input.summary === "string" ? input.summary : "",
      firstKeptEntryId: typeof input.firstKeptEntryId === "string" ? input.firstKeptEntryId : undefined,
      tokensBefore: typeof input.tokensBefore === "number" ? input.tokensBefore : undefined,
      estimatedTokensAfter: typeof input.estimatedTokensAfter === "number" ? input.estimatedTokensAfter : undefined,
      usage: usage
        ? {
            input: typeof usage.input === "number" ? usage.input : undefined,
            output: typeof usage.output === "number" ? usage.output : undefined,
            cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : undefined,
            cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined,
            total: typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
            cost: typeof cost?.total === "number" ? cost.total : undefined,
          }
        : undefined,
      details:
        input.details && typeof input.details === "object" && !Array.isArray(input.details)
          ? (input.details as Record<string, unknown>)
          : undefined,
    }
  }
}
