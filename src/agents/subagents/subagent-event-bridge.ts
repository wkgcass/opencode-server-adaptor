import type { AgentRuntimeEvent } from "../agent-adapter.ts"
import type { MessageRepository, ToolPart } from "../../message/index.ts"
import type { EventBus } from "../../event/index.ts"
import { createEvent } from "../../event/index.ts"

export interface SubagentEventBridgeContext {
  sessionId: string
  assistantMessageId: string
  messages: MessageRepository
  events: EventBus
}

/** Persists normalized child-agent runtime events into an OpenCode child session. */
export class SubagentEventBridge {
  private readonly partIds = new Map<string, string>()

  handle(event: AgentRuntimeEvent, context: SubagentEventBridgeContext): void {
    const { sessionId, assistantMessageId, messages, events } = context
    const messageId = "messageId" in event ? assistantMessageId : undefined

    switch (event.type) {
      case "text_started":
      case "reasoning_started": {
        const type = event.type === "text_started" ? "text" : "reasoning"
        const part = messages.createPart(sessionId, assistantMessageId, type, {
          text: "",
          time: { start: Date.now() },
        })
        this.partIds.set(event.partId, part.id)
        publishPart(events, part)
        return
      }
      case "text_delta":
      case "reasoning_delta":
      case "text_snapshot":
      case "reasoning_snapshot": {
        const partId = this.partIds.get(event.partId)
        const part = partId ? messages.getPart(partId) : undefined
        if (!part || (part.type !== "text" && part.type !== "reasoning")) return
        const text = "text" in event ? event.text : part.text
        const updated = messages.updatePart(part.id, { text })
        if (updated) publishPart(events, updated)
        return
      }
      case "text_ended":
      case "reasoning_ended": {
        const partId = this.partIds.get(event.partId)
        const part = partId ? messages.getPart(partId) : undefined
        if (!part || (part.type !== "text" && part.type !== "reasoning")) return
        const updated = messages.updatePart(part.id, {
          text: event.text,
          time: { start: part.time?.start ?? Date.now(), end: Date.now() },
        })
        if (updated) publishPart(events, updated)
        return
      }
      case "tool_call_started": {
        const part = messages.createPart(sessionId, assistantMessageId, "tool", {
          callID: event.callId,
          tool: event.tool,
          state: {
            status: "pending",
            input: event.input,
            raw: JSON.stringify(event.input),
            time: { start: Date.now() },
          },
        }) as ToolPart
        this.partIds.set(event.partId, part.id)
        publishPart(events, part)
        return
      }
      case "tool_call_running":
      case "tool_call_progress": {
        const partId = this.partIds.get(event.partId)
        const part = partId ? messages.getPart(partId) : undefined
        if (!part || part.type !== "tool") return
        const updated = messages.updatePart(part.id, {
          state: {
            ...part.state,
            status: "running",
            input: "input" in event ? event.input : part.state.input,
            metadata: {
              ...(part.state.metadata ?? {}),
              ...("metadata" in event ? event.metadata : {}),
              ...("output" in event ? { partialOutput: event.output } : {}),
            },
            time: { start: part.state.time?.start ?? Date.now() },
          },
        })
        if (updated) publishPart(events, updated)
        return
      }
      case "tool_call_completed":
      case "tool_call_error": {
        const partId = this.partIds.get(event.partId)
        const part = partId ? messages.getPart(partId) : undefined
        if (!part || part.type !== "tool") return
        const failed = event.type === "tool_call_error"
        const result = failed ? event.error : event.output
        const updated = messages.updatePart(part.id, {
          tool: event.tool || part.tool,
          state: {
            ...part.state,
            status: failed ? "error" : "completed",
            input: event.input,
            output: failed ? undefined : result,
            error: failed ? result : undefined,
            metadata: { ...(part.state.metadata ?? {}), ...(event.metadata ?? {}) },
            time: { start: part.state.time?.start ?? Date.now(), end: Date.now() },
          },
        })
        if (updated) publishPart(events, updated)
        return
      }
      case "message_completed":
        if (messageId) messages.completeMessage(messageId, event.finish ?? "stop")
        return
      case "session_error":
        if (messageId) messages.setMessageError(messageId, event.error)
        return
      default:
        return
    }
  }
}

function publishPart(events: EventBus, part: ReturnType<MessageRepository["getPart"]> & {}): void {
  events.publish(
    createEvent("message.part.updated", {
      sessionID: part.sessionID,
      part,
      time: Date.now(),
    }),
  )
}
