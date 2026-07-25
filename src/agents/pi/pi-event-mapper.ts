import type { PiEvent } from "./types.ts"
import type { AgentRuntimeEvent } from "../agent-adapter.ts"

export const OPENCODE_SUBTASK_EVENT_KEY = "__opencode_adaptor_subtask_event"

interface MappingContext {
  sessionId: string
  assistantMessageId: string
  partIdMap: Map<string, string>
  generatePartId: () => string
  onUnmapped?: (event: PiEvent, reason: string) => void
}

function unmappedPiEventReason(event: PiEvent): string {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent as { type?: unknown } | undefined
    if (update?.type === "done") return "Pi stream boundary is redundant with message_end"
    if (update?.type === "error") return "Provider error is deferred until Pi decides whether it will retry"
    if (update?.type === "toolcall_delta") return "Tool-call delta arrived without a known tool-call start"
    if (update?.type === "toolcall_start" || update?.type === "toolcall_end") {
      return "Tool-call boundary did not contain a usable call id and tool name"
    }
    if (!update?.type) return "message_update did not contain an assistantMessageEvent type"
    return `Unsupported Pi assistant message update '${String(update.type)}'`
  }
  if (event.type === "message_start") return "OpenCode already owns message creation"
  if (event.type === "message_end") {
    const message = event.message as { role?: unknown; content?: unknown } | undefined
    if (!message || !Array.isArray(message.content)) return "message_end did not contain a valid message content array"
    if (message.role === "user") return "OpenCode persisted the user message before sending the Pi prompt"
    if (message.role === "assistant") return "Assistant snapshot did not add content beyond the streamed state"
    return `Pi message role '${String(message.role)}' has no OpenCode projection`
  }
  if (event.type === "agent_end" && event.willRetry === true) {
    return "Pi will retry; the OpenCode assistant message must remain open"
  }
  if (event.type === "auto_retry_end" && event.success !== true) {
    return "The terminal agent_end event owns the final OpenCode error"
  }
  if (event.type === "turn_start" || event.type === "turn_end") {
    return "OpenCode has no separate turn lifecycle inside one assistant message"
  }
  if (event.type === "queue_update") return "OpenCode has no Pi steering/follow-up queue event"
  if (event.type === "entry_appended") return "Pi session entries are persisted by Pi and are not OpenCode messages"
  if (event.type === "session_info_changed") return "Pi session metadata did not contain a non-empty name"
  if (event.type === "thinking_level_changed") return "OpenCode has no runtime thinking-level event"
  if (event.type === "bash_execution_update") return "The adaptor does not issue direct Pi RPC bash commands"
  if (event.type.startsWith("summarization_retry_")) {
    return "Pi summarization retry has no equivalent OpenCode compaction sub-event"
  }
  if (event.type === "extension_ui_request") return "Pi extension UI method has no OpenCode permission equivalent"
  return "No Pi-to-OpenCode mapping is defined for this event"
}

function normalizeTool(tool: string): string {
  if (tool === "ls") return "list"
  if (tool === "find") return "glob"
  if (tool === "subagent") return "task"
  return tool
}

function normalizeToolInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input }
  if ((tool === "read" || tool === "write" || tool === "edit") && typeof normalized.path === "string") {
    normalized.filePath = normalized.path
  }
  if (tool === "task") {
    if (typeof normalized.task === "string" && typeof normalized.prompt !== "string") {
      normalized.prompt = normalized.task
    }
    if (typeof normalized.agent === "string" && typeof normalized.subagent_type !== "string") {
      normalized.subagent_type = normalized.agent
    }
  }
  return normalized
}

function toolResultText(result: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
  return (
    result?.content
      ?.filter((content) => content.type === "text" && typeof content.text === "string")
      .map((content) => content.text)
      .join("\n") ?? ""
  )
}

function splitSubtaskDetails(details: Record<string, unknown> | undefined): {
  metadata: Record<string, unknown> | undefined
  childEvent: Record<string, unknown> | undefined
} {
  if (!details) return { metadata: undefined, childEvent: undefined }
  const { [OPENCODE_SUBTASK_EVENT_KEY]: rawChildEvent, ...metadata } = details
  const childEvent =
    rawChildEvent && typeof rawChildEvent === "object" && !Array.isArray(rawChildEvent)
      ? (rawChildEvent as Record<string, unknown>)
      : undefined
  return {
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    childEvent,
  }
}

export class PiToOpenCodeEventMapper {
  private readonly context: MappingContext
  private readonly toolCallByContentIndex = new Map<number, string>()
  private readonly toolCalls = new Map<
    string,
    {
      partId: string
      tool: string
      input: Record<string, unknown>
      output: string
      metadata?: Record<string, unknown>
      running: boolean
      terminal: boolean
    }
  >()
  private readonly textByContentIndex = new Map<number, { partId: string; text: string; ended: boolean }>()
  private readonly reasoningByContentIndex = new Map<number, { partId: string; text: string; ended: boolean }>()
  private readonly subtaskMappers = new Map<string, PiToOpenCodeEventMapper>()
  private pendingAssistantError: { type: string; message: string } | undefined

  constructor(context: MappingContext) {
    this.context = context
  }

  private mapSubtaskEvent(callId: string, event: Record<string, unknown>): AgentRuntimeEvent[] {
    let mapper = this.subtaskMappers.get(callId)
    if (!mapper) {
      mapper = new PiToOpenCodeEventMapper({
        sessionId: `subtask:${callId}`,
        assistantMessageId: `subtask-message:${callId}`,
        partIdMap: new Map(),
        generatePartId: this.context.generatePartId,
        onUnmapped: this.context.onUnmapped,
      })
      this.subtaskMappers.set(callId, mapper)
    }
    return mapper.map(event as PiEvent)
  }

  private ensureToolCall(
    callId: string,
    rawTool: string,
    rawInput: Record<string, unknown>,
    running: boolean,
  ): {
    toolCall: {
      partId: string
      tool: string
      input: Record<string, unknown>
      output: string
      metadata?: Record<string, unknown>
      running: boolean
      terminal: boolean
    }
    events: AgentRuntimeEvent[]
  } {
    const ctx = this.context
    const tool = normalizeTool(rawTool)
    const input = normalizeToolInput(tool, rawInput)
    let toolCall = this.toolCalls.get(callId)
    const events: AgentRuntimeEvent[] = []
    let snapshotChanged = false

    if (!toolCall) {
      const partId = ctx.partIdMap.get(`tool_${callId}`) ?? ctx.generatePartId()
      ctx.partIdMap.set(`tool_${callId}`, partId)
      toolCall = {
        partId,
        tool,
        input,
        output: "",
        running: false,
        terminal: false,
      }
      this.toolCalls.set(callId, toolCall)
      events.push({
        type: "tool_call_started",
        sessionId: ctx.sessionId,
        messageId: ctx.assistantMessageId,
        partId,
        callId,
        tool,
        input,
      })
    } else {
      if (tool && toolCall.tool !== tool) {
        toolCall.tool = tool
        snapshotChanged = true
      }
      if (Object.keys(input).length > 0 && JSON.stringify(toolCall.input) !== JSON.stringify(input)) {
        toolCall.input = input
        snapshotChanged = true
      }
    }

    if (running && !toolCall.running && !toolCall.terminal) {
      toolCall.running = true
      events.push({
        type: "tool_call_running",
        sessionId: ctx.sessionId,
        messageId: ctx.assistantMessageId,
        partId: toolCall.partId,
        callId,
        tool: toolCall.tool,
        input: toolCall.input,
      })
    } else if (running && !toolCall.terminal && snapshotChanged) {
      // Providers may only expose the complete arguments at toolcall_end or
      // tool_execution_start. Publish that snapshot even if the card is
      // already running so Desktop can replace its empty subtitle.
      events.push({
        type: "tool_call_running",
        sessionId: ctx.sessionId,
        messageId: ctx.assistantMessageId,
        partId: toolCall.partId,
        callId,
        tool: toolCall.tool,
        input: toolCall.input,
      })
    }

    return { toolCall, events }
  }

  private completeToolCall(
    callId: string,
    rawTool: string,
    rawInput: Record<string, unknown>,
    result:
      | {
          content?: Array<{ type?: string; text?: string }>
          details?: Record<string, unknown>
          isError?: boolean
        }
      | undefined,
    isError: boolean,
  ): AgentRuntimeEvent[] {
    const ctx = this.context
    const ensured = this.ensureToolCall(callId, rawTool, rawInput, true)
    const toolCall = ensured.toolCall
    if (toolCall.terminal) return ensured.events

    toolCall.terminal = true
    const output = toolResultText(result)
    toolCall.output = output
    toolCall.metadata = result?.details

    if (isError || result?.isError) {
      ensured.events.push({
        type: "tool_call_error",
        sessionId: ctx.sessionId,
        messageId: ctx.assistantMessageId,
        partId: toolCall.partId,
        callId,
        tool: toolCall.tool,
        input: toolCall.input,
        error: output || "Tool execution failed",
        metadata: result?.details,
      })
      return ensured.events
    }

    ensured.events.push({
      type: "tool_call_completed",
      sessionId: ctx.sessionId,
      messageId: ctx.assistantMessageId,
      partId: toolCall.partId,
      callId,
      tool: toolCall.tool,
      input: toolCall.input,
      output,
      title: toolCall.tool,
      metadata: result?.details,
    })
    return ensured.events
  }

  private finalizeOpenToolCalls(): AgentRuntimeEvent[] {
    const ctx = this.context
    const events: AgentRuntimeEvent[] = []
    for (const [callId, toolCall] of this.toolCalls) {
      if (toolCall.terminal) continue
      toolCall.terminal = true
      events.push({
        type: "tool_call_completed",
        sessionId: ctx.sessionId,
        messageId: ctx.assistantMessageId,
        partId: toolCall.partId,
        callId,
        tool: toolCall.tool,
        input: toolCall.input,
        output: toolCall.output,
        title: toolCall.tool,
        metadata: {
          ...(toolCall.metadata ?? {}),
          recovered: true,
          recoveryReason: "Pi reached a terminal boundary without a tool result event",
        },
      })
    }
    return events
  }

  map(event: PiEvent): AgentRuntimeEvent[] {
    const events = this.mapEvent(event)
    if (events.length === 0) {
      this.context.onUnmapped?.(event, unmappedPiEventReason(event))
    }
    return events
  }

  private mapEvent(event: PiEvent): AgentRuntimeEvent[] {
    const ctx = this.context

    switch (event.type) {
      case "agent_start": {
        // Pi starts a fresh agent run for an automatic retry. A provider error
        // from the previous attempt is not terminal and must not leak into the
        // successful attempt.
        this.pendingAssistantError = undefined
        this.toolCallByContentIndex.clear()
        this.textByContentIndex.clear()
        this.reasoningByContentIndex.clear()
        return [{ type: "session_busy", sessionId: ctx.sessionId }]
      }

      case "message_update": {
        const ame = event.assistantMessageEvent as
          | { type: string; delta?: string; content?: string; contentIndex?: number }
          | undefined
        if (!ame) return []

        switch (ame.type) {
          case "text_start": {
            const idx = ame.contentIndex ?? 0
            const partId = ctx.generatePartId()
            ctx.partIdMap.set(`text_${idx}`, partId)
            this.textByContentIndex.set(idx, { partId, text: "", ended: false })
            return [{ type: "text_started", sessionId: ctx.sessionId, messageId: ctx.assistantMessageId, partId }]
          }
          case "text_delta": {
            const idx = ame.contentIndex ?? 0
            const delta = ame.delta ?? ""
            let stream = this.textByContentIndex.get(idx)
            const result: AgentRuntimeEvent[] = []
            if (!stream) {
              const partId = ctx.generatePartId()
              stream = { partId, text: "", ended: false }
              this.textByContentIndex.set(idx, stream)
              ctx.partIdMap.set(`text_${idx}`, partId)
              result.push({ type: "text_started", sessionId: ctx.sessionId, messageId: ctx.assistantMessageId, partId })
            }
            stream.text += delta
            result.push({
              type: "text_delta",
              sessionId: ctx.sessionId,
              messageId: ctx.assistantMessageId,
              partId: stream.partId,
              delta,
              text: stream.text,
            })
            return result
          }
          case "text_end": {
            const idx = ame.contentIndex ?? 0
            const finalText = typeof ame.content === "string" ? ame.content : undefined
            let stream = this.textByContentIndex.get(idx)
            const result: AgentRuntimeEvent[] = []
            if (!stream) {
              const partId = ctx.generatePartId()
              stream = { partId, text: "", ended: false }
              this.textByContentIndex.set(idx, stream)
              ctx.partIdMap.set(`text_${idx}`, partId)
              result.push({ type: "text_started", sessionId: ctx.sessionId, messageId: ctx.assistantMessageId, partId })
            }
            if (finalText !== undefined && finalText !== stream.text) {
              stream.text = finalText
              result.push({
                type: "text_snapshot",
                sessionId: ctx.sessionId,
                messageId: ctx.assistantMessageId,
                partId: stream.partId,
                text: finalText,
              })
            }
            stream.ended = true
            result.push({
              type: "text_ended",
              sessionId: ctx.sessionId,
              messageId: ctx.assistantMessageId,
              partId: stream.partId,
              text: stream.text,
            })
            return result
          }
          case "thinking_start": {
            const idx = ame.contentIndex ?? 0
            const partId = ctx.generatePartId()
            ctx.partIdMap.set(`reasoning_${idx}`, partId)
            this.reasoningByContentIndex.set(idx, { partId, text: "", ended: false })
            return [{ type: "reasoning_started", sessionId: ctx.sessionId, messageId: ctx.assistantMessageId, partId }]
          }
          case "thinking_delta": {
            const idx = ame.contentIndex ?? 0
            const delta = ame.delta ?? ""
            let stream = this.reasoningByContentIndex.get(idx)
            const result: AgentRuntimeEvent[] = []
            if (!stream) {
              const partId = ctx.generatePartId()
              stream = { partId, text: "", ended: false }
              this.reasoningByContentIndex.set(idx, stream)
              ctx.partIdMap.set(`reasoning_${idx}`, partId)
              result.push({
                type: "reasoning_started",
                sessionId: ctx.sessionId,
                messageId: ctx.assistantMessageId,
                partId,
              })
            }
            stream.text += delta
            result.push({
              type: "reasoning_delta",
              sessionId: ctx.sessionId,
              messageId: ctx.assistantMessageId,
              partId: stream.partId,
              delta,
              text: stream.text,
            })
            return result
          }
          case "thinking_end": {
            const idx = ame.contentIndex ?? 0
            const finalText = typeof ame.content === "string" ? ame.content : undefined
            let stream = this.reasoningByContentIndex.get(idx)
            const result: AgentRuntimeEvent[] = []
            if (!stream) {
              const partId = ctx.generatePartId()
              stream = { partId, text: "", ended: false }
              this.reasoningByContentIndex.set(idx, stream)
              ctx.partIdMap.set(`reasoning_${idx}`, partId)
              result.push({
                type: "reasoning_started",
                sessionId: ctx.sessionId,
                messageId: ctx.assistantMessageId,
                partId,
              })
            }
            if (finalText !== undefined && finalText !== stream.text) {
              stream.text = finalText
              result.push({
                type: "reasoning_snapshot",
                sessionId: ctx.sessionId,
                messageId: ctx.assistantMessageId,
                partId: stream.partId,
                text: finalText,
              })
            }
            stream.ended = true
            result.push({
              type: "reasoning_ended",
              sessionId: ctx.sessionId,
              messageId: ctx.assistantMessageId,
              partId: stream.partId,
              text: stream.text,
            })
            return result
          }
          case "toolcall_start": {
            const ameFull = event.assistantMessageEvent as
              | {
                  toolCall?: { id: string; name: string; arguments: Record<string, unknown> }
                  partial?: {
                    content?: Array<{ type?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>
                  }
                  contentIndex?: number
                }
              | undefined
            let toolCall = ameFull?.toolCall
            if (!toolCall && ameFull?.partial?.content) {
              const tcEntry = ameFull.partial.content.find((c) => c.type === "toolCall")
              if (tcEntry) {
                toolCall = { id: tcEntry.id ?? "", name: tcEntry.name ?? "", arguments: tcEntry.arguments ?? {} }
              }
            }
            if (!toolCall?.id || !toolCall.name) return []
            this.toolCallByContentIndex.set(ameFull?.contentIndex ?? 0, toolCall.id)
            return this.ensureToolCall(toolCall.id, toolCall.name, toolCall.arguments ?? {}, false).events
          }
          case "toolcall_delta": {
            const delta = ame.delta ?? ""
            const callId = this.toolCallByContentIndex.get(ame.contentIndex ?? 0)
            const partId = callId ? ctx.partIdMap.get(`tool_${callId}`) : undefined
            if (callId && partId) {
              return [
                {
                  type: "tool_call_delta",
                  sessionId: ctx.sessionId,
                  messageId: ctx.assistantMessageId,
                  partId,
                  callId,
                  delta,
                },
              ]
            }
            return []
          }
          case "toolcall_end": {
            const full = event.assistantMessageEvent as {
              contentIndex?: number
              toolCall?: { id: string; name: string; arguments: Record<string, unknown> }
            }
            const toolCall = full.toolCall
            if (!toolCall?.id) return []
            this.toolCallByContentIndex.set(full.contentIndex ?? 0, toolCall.id)
            return this.ensureToolCall(toolCall.id, toolCall.name, toolCall.arguments ?? {}, true).events
          }
          case "done": {
            // Message complete
            return []
          }
          case "error": {
            const failed = (
              event.assistantMessageEvent as
                | {
                    reason?: string
                    error?: { errorMessage?: string }
                  }
                | undefined
            )?.error
            this.pendingAssistantError = {
              type: "pi_error",
              message: failed?.errorMessage ?? "Pi message error",
            }
            // Pi emits this for each failed provider attempt before it decides
            // whether auto-retry is possible. Wait for agent_end.willRetry so
            // a transient 5xx does not terminally error the OpenCode message.
            return []
          }
          default:
            return []
        }
      }

      case "message_end": {
        const message = event.message as
          | {
              role?: string
              toolCallId?: string
              toolName?: string
              details?: Record<string, unknown>
              isError?: boolean
              stopReason?: string
              errorMessage?: string
              content?: Array<{
                type?: string
                text?: string
                thinking?: string
                id?: string
                name?: string
                arguments?: Record<string, unknown>
              }>
            }
          | undefined
        if (!message || !Array.isArray(message.content)) return []

        if (message.role === "toolResult" && message.toolCallId) {
          return this.completeToolCall(
            message.toolCallId,
            message.toolName ?? "",
            {},
            {
              content: message.content,
              details: message.details,
              isError: message.isError,
            },
            message.isError === true,
          )
        }
        if (message.role !== "assistant") return []

        if (message.stopReason === "error") {
          this.pendingAssistantError = {
            type: "pi_error",
            message: message.errorMessage ?? this.pendingAssistantError?.message ?? "Pi provider request failed",
          }
        } else if (message.stopReason && message.stopReason !== "aborted") {
          this.pendingAssistantError = undefined
        }

        const result: AgentRuntimeEvent[] = []
        const matchedTextParts = new Set<string>()
        const matchedReasoningParts = new Set<string>()
        for (let idx = 0; idx < message.content.length; idx++) {
          const content = message.content[idx]
          if (!content) continue
          if (content.type === "toolCall" && content.id) {
            this.toolCallByContentIndex.set(idx, content.id)
            result.push(...this.ensureToolCall(content.id, content.name ?? "", content.arguments ?? {}, true).events)
          }
          if (content.type === "text" && typeof content.text === "string") {
            let stream = [...this.textByContentIndex.values()].find(
              (candidate) => !matchedTextParts.has(candidate.partId) && candidate.text === content.text,
            )
            const indexed = this.textByContentIndex.get(idx)
            if (!stream && indexed && !matchedTextParts.has(indexed.partId)) stream = indexed
            if (!stream) {
              const unmatched = [...this.textByContentIndex.values()].filter(
                (candidate) => !matchedTextParts.has(candidate.partId),
              )
              if (unmatched.length === 1) stream = unmatched[0]
            }
            if (!stream) {
              const partId = ctx.generatePartId()
              stream = { partId, text: "", ended: false }
              this.textByContentIndex.set(idx, stream)
              ctx.partIdMap.set(`text_${idx}`, partId)
              result.push({
                type: "text_started",
                sessionId: ctx.sessionId,
                messageId: ctx.assistantMessageId,
                partId,
              })
            }
            matchedTextParts.add(stream.partId)
            if (stream.text !== content.text) {
              stream.text = content.text
              result.push({
                type: "text_snapshot",
                sessionId: ctx.sessionId,
                messageId: ctx.assistantMessageId,
                partId: stream.partId,
                text: content.text,
              })
            }
            if (!stream.ended) {
              stream.ended = true
              result.push({
                type: "text_ended",
                sessionId: ctx.sessionId,
                messageId: ctx.assistantMessageId,
                partId: stream.partId,
                text: stream.text,
              })
            }
          }
          if (content.type === "thinking" && typeof content.thinking === "string") {
            let stream = [...this.reasoningByContentIndex.values()].find(
              (candidate) => !matchedReasoningParts.has(candidate.partId) && candidate.text === content.thinking,
            )
            const indexed = this.reasoningByContentIndex.get(idx)
            if (!stream && indexed && !matchedReasoningParts.has(indexed.partId)) stream = indexed
            if (!stream) {
              const unmatched = [...this.reasoningByContentIndex.values()].filter(
                (candidate) => !matchedReasoningParts.has(candidate.partId),
              )
              if (unmatched.length === 1) stream = unmatched[0]
            }
            if (!stream) {
              const partId = ctx.generatePartId()
              stream = { partId, text: "", ended: false }
              this.reasoningByContentIndex.set(idx, stream)
              ctx.partIdMap.set(`reasoning_${idx}`, partId)
              result.push({
                type: "reasoning_started",
                sessionId: ctx.sessionId,
                messageId: ctx.assistantMessageId,
                partId,
              })
            }
            matchedReasoningParts.add(stream.partId)
            if (stream.text !== content.thinking) {
              stream.text = content.thinking
              result.push({
                type: "reasoning_snapshot",
                sessionId: ctx.sessionId,
                messageId: ctx.assistantMessageId,
                partId: stream.partId,
                text: content.thinking,
              })
            }
            if (!stream.ended) {
              stream.ended = true
              result.push({
                type: "reasoning_ended",
                sessionId: ctx.sessionId,
                messageId: ctx.assistantMessageId,
                partId: stream.partId,
                text: stream.text,
              })
            }
          }
        }
        return result
      }

      case "tool_execution_start": {
        const toolCallId = event.toolCallId as string
        const tool = (event.toolName as string) ?? ""
        return this.ensureToolCall(toolCallId, tool, (event.args as Record<string, unknown>) ?? {}, true).events
      }

      case "tool_execution_update": {
        const toolCallId = event.toolCallId as string
        const tool = (event.toolName as string) ?? ""
        const ensured = this.ensureToolCall(toolCallId, tool, (event.args as Record<string, unknown>) ?? {}, true)
        const partialResult = event.partialResult as
          | { content?: Array<{ type?: string; text?: string }>; details?: Record<string, unknown> }
          | undefined
        const output = toolResultText(partialResult)
        const details = splitSubtaskDetails(partialResult?.details)
        ensured.toolCall.output = output
        ensured.toolCall.metadata = details.metadata
        ensured.events.push({
          type: "tool_call_progress",
          sessionId: ctx.sessionId,
          messageId: ctx.assistantMessageId,
          partId: ensured.toolCall.partId,
          callId: toolCallId,
          output,
          metadata: details.metadata,
        })
        if (ensured.toolCall.tool === "task" && details.childEvent) {
          for (const childEvent of this.mapSubtaskEvent(toolCallId, details.childEvent)) {
            ensured.events.push({
              type: "subtask_event",
              sessionId: ctx.sessionId,
              messageId: ctx.assistantMessageId,
              partId: ensured.toolCall.partId,
              callId: toolCallId,
              input: ensured.toolCall.input,
              event: childEvent,
            })
          }
        }
        return ensured.events
      }

      case "tool_execution_end": {
        const toolCallId = event.toolCallId as string
        const result = event.result as
          | {
              content?: Array<{ type?: string; text?: string }>
              details?: Record<string, unknown>
              isError?: boolean
            }
          | undefined
        const toolName = typeof event.toolName === "string" ? event.toolName : ""
        return this.completeToolCall(toolCallId, toolName, {}, result, event.isError === true)
      }

      case "agent_end": {
        if (event.willRetry === true) return []
        const piMessages = Array.isArray(event.messages) ? (event.messages as Array<Record<string, unknown>>) : []
        const assistant = piMessages.findLast((message) => message.role === "assistant")
        const usage = assistant?.usage as
          | {
              input?: number
              output?: number
              cacheRead?: number
              cacheWrite?: number
              totalTokens?: number
              cost?: { total?: number }
            }
          | undefined
        const finish = typeof assistant?.stopReason === "string" ? assistant.stopReason : "stop"
        const finalError =
          finish === "error"
            ? {
                type: "pi_error",
                message:
                  (typeof assistant?.errorMessage === "string" ? assistant.errorMessage : undefined) ??
                  this.pendingAssistantError?.message ??
                  "Pi provider request failed",
              }
            : undefined
        this.pendingAssistantError = undefined
        return [
          ...this.finalizeOpenToolCalls(),
          {
            type: "message_completed",
            sessionId: ctx.sessionId,
            messageId: ctx.assistantMessageId,
            finish,
            usage: usage
              ? {
                  cost: usage.cost?.total,
                  input: usage.input,
                  output: usage.output,
                  cacheRead: usage.cacheRead,
                  cacheWrite: usage.cacheWrite,
                  total: usage.totalTokens,
                }
              : undefined,
          },
          ...(finalError
            ? [
                {
                  type: "session_error" as const,
                  sessionId: ctx.sessionId,
                  messageId: ctx.assistantMessageId,
                  error: finalError,
                },
              ]
            : []),
        ]
      }

      case "auto_retry_start": {
        const attempt = typeof event.attempt === "number" ? Math.max(0, Math.floor(event.attempt)) : 0
        const delayMs = typeof event.delayMs === "number" ? Math.max(0, event.delayMs) : 0
        const message =
          typeof event.errorMessage === "string"
            ? event.errorMessage
            : (this.pendingAssistantError?.message ?? "Pi provider request failed")
        this.pendingAssistantError = { type: "pi_error", message }
        return [
          {
            type: "session_retry",
            sessionId: ctx.sessionId,
            attempt,
            message,
            next: Date.now() + delayMs,
          },
        ]
      }

      case "auto_retry_end": {
        if (event.success !== true) return []
        this.pendingAssistantError = undefined
        return [{ type: "session_busy", sessionId: ctx.sessionId }]
      }

      case "summarization_retry_scheduled": {
        const attempt = typeof event.attempt === "number" ? Math.max(0, Math.floor(event.attempt)) : 0
        const delayMs = typeof event.delayMs === "number" ? Math.max(0, event.delayMs) : 0
        return [
          {
            type: "session_retry",
            sessionId: ctx.sessionId,
            attempt,
            message:
              typeof event.errorMessage === "string" ? event.errorMessage : "Pi summarization request will retry",
            next: Date.now() + delayMs,
          },
        ]
      }

      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
        return [{ type: "session_busy", sessionId: ctx.sessionId }]

      case "session_info_changed": {
        const title = typeof event.name === "string" ? event.name.trim() : ""
        if (!title) return []
        return [{ type: "session_title_changed", sessionId: ctx.sessionId, title }]
      }

      case "agent_settled": {
        const recovered = this.finalizeOpenToolCalls()
        ctx.partIdMap.clear()
        this.toolCallByContentIndex.clear()
        this.toolCalls.clear()
        this.textByContentIndex.clear()
        this.reasoningByContentIndex.clear()
        return [...recovered, { type: "session_idle", sessionId: ctx.sessionId }]
      }

      case "extension_error": {
        return [
          {
            type: "session_error",
            sessionId: ctx.sessionId,
            messageId: ctx.assistantMessageId,
            error: { type: "extension_error", message: (event.error as string) ?? "Extension error" },
            fatal: false,
          },
        ]
      }

      case "extension_ui_request": {
        const method = event.method as string
        if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
          const requestId = event.id as string
          return [
            {
              type: "permission_requested",
              sessionId: ctx.sessionId,
              permissionId: requestId,
              tool: "extension",
              input: {
                method,
                title: event.title,
                message: event.message,
                options: event.options,
                placeholder: event.placeholder,
                prefill: event.prefill,
              },
            },
          ]
        }
        return []
      }

      default:
        return []
    }
  }
}
