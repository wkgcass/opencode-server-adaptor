import { describe, expect, test } from "bun:test"
import {
  optimizeInteractionPayload,
  registerInteractionPayloadOptimizer,
} from "../../src/logging/interaction-payload.ts"
import { optimizePiInteractionPayload } from "../../src/agents/pi/pi-interaction-payload.ts"

registerInteractionPayloadOptimizer("pi", optimizePiInteractionPayload)

describe("verbose interaction payload design", () => {
  test("Pi message_update keeps the delta and drops repeated message snapshots", () => {
    const result = optimizeInteractionPayload(
      "pi",
      { stream: "stdout" },
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "a very large accumulated response" }],
          model: "repeated-model",
        },
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 2,
          delta: "new token",
          partial: { content: "a very large accumulated response" },
        },
      },
    )

    expect(result).toEqual({
      type: "message_update",
      event: "text_delta",
      role: "assistant",
      contentIndex: 2,
      delta: "new token",
    })
    expect(JSON.stringify(result)).not.toContain("accumulated response")
    expect(JSON.stringify(result)).not.toContain("repeated-model")
    expect(JSON.stringify(result)).not.toContain("partial")
  })

  test("Pi message_update retains tool-call and terminal event essentials", () => {
    const toolCall = optimizeInteractionPayload(
      "pi",
      { stream: "stdout" },
      {
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 1,
          toolCall: { id: "call_1", name: "bash", arguments: { command: "ls ~" } },
          partial: {},
        },
      },
    )
    expect(toolCall).toEqual({
      type: "message_update",
      event: "toolcall_end",
      role: "assistant",
      contentIndex: 1,
      toolCall: { id: "call_1", name: "bash", arguments: { command: "ls ~" } },
    })

    const done = optimizeInteractionPayload(
      "pi",
      { stream: "stdout" },
      {
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "repeated final text" }] },
        assistantMessageEvent: { type: "done", reason: "stop" },
      },
    )
    expect(done).toEqual({ type: "message_update", event: "done", role: "assistant", reason: "stop" })
  })

  test("Pi start and user-end messages summarize echoed content", () => {
    const messageStart = optimizeInteractionPayload(
      "pi",
      { stream: "stdout" },
      {
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: "do not echo this prompt" }], timestamp: 10 },
      },
    )
    expect(messageStart).toEqual({
      type: "message_start",
      role: "user",
      content: [{ type: "text", length: 23 }],
      timestamp: 10,
    })

    const messageEnd = optimizeInteractionPayload(
      "pi",
      { stream: "stdout" },
      {
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "do not echo this prompt" }], timestamp: 11 },
      },
    )
    expect(messageEnd).toEqual({
      type: "message_end",
      role: "user",
      content: [{ type: "text", length: 23 }],
      timestamp: 11,
    })
  })

  test("Pi assistant message_end summarizes final content while retaining terminal metadata", () => {
    const result = optimizeInteractionPayload(
      "pi",
      { stream: "stdout" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final answer" }],
          model: "model",
          stopReason: "stop",
          usage: { input: 10, output: 2 },
          timestamp: 12,
        },
      },
    )
    expect(result).toEqual({
      type: "message_end",
      role: "assistant",
      content: [{ type: "text", length: 12 }],
      model: "model",
      stopReason: "stop",
      usage: { input: 10, output: 2 },
      timestamp: 12,
    })
    expect(JSON.stringify(result)).not.toContain("final answer")
  })

  test("Pi tool progress and terminal events summarize cumulative output", () => {
    const progress = optimizeInteractionPayload(
      "pi",
      { stream: "stdout" },
      {
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "long command repeated from start" },
        partialResult: {
          content: [{ type: "text", text: "a growing output buffer" }],
          details: { lineCount: 20 },
        },
      },
    )
    expect(progress).toEqual({
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", length: 23 }],
      details: { lineCount: 20 },
    })

    const terminal = optimizeInteractionPayload(
      "pi",
      { stream: "stdout" },
      {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "final command output" }], details: { exit: 0 } },
        isError: false,
      },
    )
    expect(terminal).toEqual({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", length: 20 }], details: { exit: 0 } },
      isError: false,
    })
    expect(JSON.stringify(terminal)).not.toContain("final command output")
  })

  test("Pi agent_end reports counts instead of repeating every message", () => {
    const result = optimizeInteractionPayload(
      "pi",
      { stream: "stdout" },
      {
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "large prompt" }] },
          { role: "assistant", content: [{ type: "text", text: "large answer" }] },
        ],
        willRetry: false,
      },
    )
    expect(result).toEqual({ type: "agent_end", willRetry: false, messageCount: 2 })
  })

  test("OpenCode text part snapshots keep identity and length, not accumulated text", () => {
    const result = optimizeInteractionPayload(
      "opencode",
      { kind: "SSE message", path: "/api/event" },
      {
        id: "evt_1",
        type: "message.part.updated",
        data: {
          sessionID: "ses_1",
          part: {
            id: "prt_1",
            messageID: "msg_1",
            sessionID: "ses_1",
            type: "text",
            text: "the entire accumulated answer",
            time: { start: 1 },
          },
          time: 2,
        },
      },
    )
    expect(result).toEqual({
      id: "evt_1",
      type: "message.part.updated",
      data: {
        sessionID: "ses_1",
        part: {
          id: "prt_1",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          textLength: 29,
          time: { start: 1 },
        },
        time: 2,
      },
    })
    expect(JSON.stringify(result)).not.toContain("accumulated answer")
  })

  test("OpenCode tool snapshots log input once and summarize growing output", () => {
    const pending = optimizeInteractionPayload(
      "opencode",
      { kind: "SSE message", path: "/api/event" },
      {
        id: "evt_pending",
        type: "message.part.updated",
        data: {
          sessionID: "ses_1",
          part: {
            id: "prt_tool",
            messageID: "msg_1",
            sessionID: "ses_1",
            type: "tool",
            callID: "call_1",
            tool: "bash",
            state: { status: "pending", input: { command: "ls ~" } },
          },
        },
      },
    ) as { data: { part: { input?: unknown } } }
    expect(pending.data.part.input).toEqual({ command: "ls ~" })

    const running = optimizeInteractionPayload(
      "opencode",
      { kind: "SSE message", path: "/api/event" },
      {
        id: "evt_running",
        type: "message.part.updated",
        data: {
          sessionID: "ses_1",
          part: {
            id: "prt_tool",
            messageID: "msg_1",
            sessionID: "ses_1",
            type: "tool",
            callID: "call_1",
            tool: "bash",
            state: {
              status: "running",
              input: { command: "ls ~" },
              metadata: { partialOutput: "growing output", lineCount: 2 },
            },
          },
        },
      },
    ) as { data: { part: { input?: unknown; partialOutputLength?: number; metadata?: unknown } } }
    expect(running.data.part.input).toBeUndefined()
    expect(running.data.part.partialOutputLength).toBe(14)
    expect(running.data.part.metadata).toEqual({ lineCount: 2 })
  })

  test("OpenCode message.updated keeps lifecycle and usage fields only", () => {
    const result = optimizeInteractionPayload(
      "opencode",
      { kind: "SSE message", path: "/api/event" },
      {
        id: "evt_message",
        type: "message.updated",
        data: {
          sessionID: "ses_1",
          info: {
            id: "msg_1",
            sessionID: "ses_1",
            role: "assistant",
            finish: "stop",
            time: { created: 1, completed: 2 },
            tokens: { input: 4, output: 2 },
            summary: { title: "large repeated summary" },
            path: { cwd: "/tmp/repeated" },
          },
        },
      },
    )
    expect(result).toEqual({
      id: "evt_message",
      type: "message.updated",
      data: {
        sessionID: "ses_1",
        message: {
          id: "msg_1",
          role: "assistant",
          finish: "stop",
          time: { created: 1, completed: 2 },
          tokens: { input: 4, output: 2 },
        },
      },
    })
  })

  test("OpenCode v2 message envelopes and durable SSE events receive the same compact logging treatment", () => {
    const response = optimizeInteractionPayload(
      "opencode",
      {
        kind: "HTTP response",
        method: "GET",
        url: "/api/session/ses_1/message?limit=50",
        status: 200,
      },
      {
        data: [
          {
            id: "msg_user",
            type: "user",
            time: { created: 1 },
            text: "a complete v2 user prompt",
            files: [{ uri: "file:///tmp/example" }],
          },
          {
            id: "msg_assistant",
            type: "assistant",
            time: { created: 2, completed: 3 },
            agent: "pi",
            model: { id: "model", providerID: "provider" },
            finish: "stop",
            content: [
              { type: "text", id: "text_1", text: "a complete v2 answer" },
              {
                type: "tool",
                id: "call_1",
                name: "bash",
                state: {
                  status: "completed",
                  content: [{ type: "text", text: "large tool output" }],
                  result: "large tool output",
                },
                metadata: {
                  partialOutput: "large tool output",
                  truncation: { content: "large tool output", truncated: true },
                },
              },
            ],
          },
        ],
        cursor: { next: "opaque" },
      },
    )
    expect(response).toEqual({
      data: [
        {
          id: "msg_user",
          type: "user",
          time: { created: 1 },
          textLength: 25,
          fileCount: 1,
        },
        {
          id: "msg_assistant",
          type: "assistant",
          time: { created: 2, completed: 3 },
          agent: "pi",
          model: { id: "model", providerID: "provider" },
          finish: "stop",
          content: [
            { type: "text", id: "text_1", textLength: 20 },
            {
              type: "tool",
              id: "call_1",
              name: "bash",
              status: "completed",
              contentCount: 1,
              resultLength: 17,
              partialOutputLength: 17,
              metadata: {
                truncation: { contentLength: 17, truncated: true },
              },
            },
          ],
        },
      ],
      cursor: { next: "opaque" },
    })
    expect(JSON.stringify(response)).not.toContain("large tool output")

    const event = optimizeInteractionPayload(
      "opencode",
      { kind: "SSE message", path: "/api/session/ses_1/event" },
      {
        id: "evt_1",
        type: "session.next.text.ended",
        durable: { aggregateID: "ses_1", seq: 3, version: 1 },
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_assistant",
          textID: "text_1",
          text: "complete durable response",
        },
      },
    )
    expect(event).toEqual({
      id: "evt_1",
      type: "session.next.text.ended",
      durable: { aggregateID: "ses_1", seq: 3, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        textID: "text_1",
        textLength: 25,
      },
    })
  })

  test("unrelated HTTP payloads, failed message responses, and unknown future events remain complete", () => {
    const http = { message: "full request", nested: { keep: true } }
    expect(optimizeInteractionPayload("opencode", { kind: "HTTP request" }, http)).toBe(http)
    expect(
      optimizeInteractionPayload(
        "opencode",
        { kind: "HTTP response", url: "/api/session/ses_1/message", status: 500 },
        http,
      ),
    ).toBe(http)
    expect(
      optimizeInteractionPayload(
        "opencode",
        { kind: "HTTP response", url: "/api/session/ses_1/message/msg_1", status: 200 },
        http,
      ),
    ).toBe(http)

    const future = { type: "future_pi_event", newField: { preserve: "everything" } }
    expect(optimizeInteractionPayload("pi", { stream: "stdout" }, future)).toBe(future)
  })
})
