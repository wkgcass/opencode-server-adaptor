import { OPENCODE_SUBTASK_EVENT_KEY } from "./pi-event-mapper.ts"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : undefined
}

function defined(input: UnknownRecord): UnknownRecord {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

function contentSummary(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined
  return content.map((item) => {
    const part = record(item)
    if (!part) return item
    if (part.type === "text") {
      return defined({ type: "text", length: typeof part.text === "string" ? part.text.length : undefined })
    }
    if (part.type === "thinking") {
      return defined({
        type: "thinking",
        length: typeof part.thinking === "string" ? part.thinking.length : undefined,
      })
    }
    if (part.type === "toolCall") {
      return defined({ type: "toolCall", id: part.id, name: part.name, arguments: part.arguments })
    }
    return defined({ type: part.type })
  })
}

function compactMessageEnd(payload: UnknownRecord): UnknownRecord {
  const message = record(payload.message)
  if (!message) return payload
  const role = message.role
  return defined({
    type: payload.type,
    role,
    content: contentSummary(message.content),
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    details: message.details,
    isError: message.isError,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    usage: message.usage,
    timestamp: message.timestamp,
  })
}

function compactSubtaskDetails(details: unknown): unknown {
  // The subtask child event is nested under details so the parent runtime can
  // project subtask progress. For message_update events it carries the full
  // accumulated assistant `partial` (including reasoning/thinking and response
  // text), which is only needed for event projection on the raw event path and
  // is pure noise in the interaction log. Summarize its content to lengths so
  // the printed payload no longer includes the verbose prompt/reasoning text.
  const detailsRecord = record(details)
  if (!detailsRecord) return details
  const child = record(detailsRecord[OPENCODE_SUBTASK_EVENT_KEY])
  if (!child) return details
  const assistantMessageEvent = record(child.assistantMessageEvent)
  if (!assistantMessageEvent) return details
  const partial = record(assistantMessageEvent.partial)
  if (!partial || !Array.isArray(partial.content)) return details
  return {
    ...detailsRecord,
    [OPENCODE_SUBTASK_EVENT_KEY]: {
      ...child,
      assistantMessageEvent: {
        ...assistantMessageEvent,
        partial: { ...partial, content: contentSummary(partial.content) },
      },
    },
  }
}

function compactPayload(payload: unknown): unknown {
  const event = record(payload)
  if (!event || typeof event.type !== "string") return payload

  switch (event.type) {
    case "message_update": {
      const message = record(event.message)
      const update = record(event.assistantMessageEvent)
      if (!update) return defined({ type: event.type, role: message?.role })
      return defined({
        type: event.type,
        event: update.type,
        role: message?.role,
        contentIndex: update.contentIndex,
        delta: update.delta,
        reason: update.reason,
        toolCall: update.toolCall,
        error: update.error,
        contentLength: typeof update.content === "string" ? update.content.length : undefined,
      })
    }
    case "message_start": {
      const message = record(event.message)
      return defined({
        type: event.type,
        role: message?.role,
        content: contentSummary(message?.content),
        timestamp: message?.timestamp,
      })
    }
    case "message_end":
      return compactMessageEnd(event)
    case "agent_end": {
      const messages = Array.isArray(event.messages) ? event.messages : undefined
      return defined({
        type: event.type,
        willRetry: event.willRetry,
        messageCount: messages?.length,
        error: event.error,
      })
    }
    case "turn_end":
      return defined({
        type: event.type,
        toolResultCount: Array.isArray(event.toolResults) ? event.toolResults.length : undefined,
      })
    case "tool_execution_start":
      return defined({
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      })
    case "tool_execution_update": {
      const partial = record(event.partialResult)
      return defined({
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        content: contentSummary(partial?.content),
        details: compactSubtaskDetails(partial?.details),
      })
    }
    case "tool_execution_end": {
      const result = record(event.result)
      return defined({
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: result
          ? defined({
              content: contentSummary(result.content),
              details: result.details,
              isError: result.isError,
            })
          : event.result,
        isError: event.isError,
      })
    }
    default:
      return payload
  }
}

export function optimizePiInteractionPayload(metadata: Record<string, unknown>, payload: unknown): unknown {
  if (metadata.stream === "stdout" || metadata.stream === "stderr-bridge") {
    return compactPayload(payload)
  }
  return payload
}
