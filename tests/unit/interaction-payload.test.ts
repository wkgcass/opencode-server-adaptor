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

  test("Pi tool_execution_update slims the nested subtask event prompt/reasoning text", () => {
    const result = optimizeInteractionPayload(
      "pi",
      { stream: "stdout" },
      {
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "task",
        partialResult: {
          content: [{ type: "text", text: "subtask output so far" }],
          details: {
            mode: "single",
            agent: "general",
            status: "running",
            description: "write files",
            __opencode_adaptor_subtask_event: {
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 1,
                delta: "2",
                partial: {
                  role: "assistant",
                  content: [
                    {
                      type: "thinking",
                      thinking: "The user wants me to write two files.",
                      thinkingSignature: "reasoning_content",
                    },
                    { type: "text", text: "已成功执行两条命令。" },
                  ],
                  provider: "pi-cmss",
                  model: "demo-model",
                  usage: { input: 0, output: 0, totalTokens: 0 },
                  stopReason: "stop",
                  timestamp: 1785802272970,
                  responseId: "chatcmpl-x",
                },
              },
            },
          },
        },
      },
    )
    const json = JSON.stringify(result)
    // Verbose prompt/reasoning text must not be printed.
    expect(json).not.toContain("The user wants me to write two files.")
    expect(json).not.toContain("已成功执行两条命令。")
    expect(json).not.toContain("reasoning_content")
    // Structure and actionable fields are preserved.
    expect(json).toContain('"delta":"2"')
    expect(json).toContain('"description":"write files"')
    // Content is summarized to lengths, consistent with the top-level content.
    const details = (result as { details: Record<string, unknown> }).details
    const childEvent = details.__opencode_adaptor_subtask_event as {
      assistantMessageEvent: { partial: { content: Array<{ type: string; length?: number }> } }
    }
    expect(childEvent.assistantMessageEvent.partial.content).toEqual([
      { type: "thinking", length: 37 },
      { type: "text", length: 10 },
    ])
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

  test("OpenCode current text events keep identity and length, not accumulated text", () => {
    const result = optimizeInteractionPayload(
      "opencode",
      { kind: "SSE message", path: "/api/event" },
      {
        id: "evt_1",
        type: "session.text.ended",
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          ordinal: 0,
          text: "the entire accumulated answer",
        },
      },
    )
    expect(result).toEqual({
      id: "evt_1",
      type: "session.text.ended",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        ordinal: 0,
        textLength: 29,
      },
    })
    expect(JSON.stringify(result)).not.toContain("accumulated answer")
  })

  test("OpenCode current tool events log input once and summarize growing output", () => {
    const pending = optimizeInteractionPayload(
      "opencode",
      { kind: "SSE message", path: "/api/event" },
      {
        id: "evt_pending",
        type: "session.tool.called",
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          callID: "call_1",
          input: { command: "ls ~" },
          executed: true,
        },
      },
    ) as { data: { input?: unknown } }
    expect(pending.data.input).toEqual({ command: "ls ~" })

    const running = optimizeInteractionPayload(
      "opencode",
      { kind: "SSE message", path: "/api/event" },
      {
        id: "evt_running",
        type: "session.tool.progress",
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          callID: "call_1",
          metadata: { partialOutput: "growing output", lineCount: 2 },
        },
      },
    ) as { data: { metadata?: { partialOutputLength?: number; lineCount?: number } } }
    expect(running.data.metadata).toEqual({ partialOutputLength: 14, lineCount: 2 })
  })

  test("OpenCode current step terminal keeps lifecycle and usage fields", () => {
    const result = optimizeInteractionPayload(
      "opencode",
      { kind: "SSE message", path: "/api/event" },
      {
        id: "evt_message",
        type: "session.step.ended",
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          finish: "stop",
          cost: 0,
          tokens: { input: 4, output: 2 },
        },
      },
    )
    expect(result).toEqual({
      id: "evt_message",
      type: "session.step.ended",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        finish: "stop",
        cost: 0,
        tokens: { input: 4, output: 2 },
      },
    })
  })

  test("OpenCode v2 message logs omit verbose conversation and tool payload fields", () => {
    const payload = {
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
          summary: { title: "message summary to omit", body: "summary body to omit" },
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
                input: {
                  command: "state input command to omit",
                  content: "state input content to omit",
                  path: "state input path to omit",
                  filePath: "state input filePath to omit",
                  cwd: "/workspace",
                },
                content: [{ type: "text", text: "state content text to omit", mime: "text/plain" }],
                result: "state result to omit",
                metadata: {
                  output: "state metadata output to omit",
                  partialOutput: "state metadata partial output to omit",
                  preserved: "state metadata to preserve",
                },
                error: { name: "ToolError", message: "state error message to omit", code: "E_TOOL" },
              },
              metadata: {
                output: "metadata output to omit",
                partialOutput: "metadata partial output to omit",
                truncation: { content: "large tool output", truncated: true },
              },
            },
          ],
        },
      ],
      cursor: { next: "opaque" },
    }
    const response = optimizeInteractionPayload(
      "opencode",
      {
        kind: "HTTP response",
        method: "GET",
        url: "/api/session/ses_1/message?limit=50",
        status: 200,
      },
      payload,
    )
    expect(response).toEqual({
      data: [
        {
          id: "msg_user",
          type: "user",
          time: { created: 1 },
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
            { type: "text", id: "text_1" },
            {
              type: "tool",
              id: "call_1",
              name: "bash",
              state: {
                status: "completed",
                input: { cwd: "/workspace" },
                content: [{ type: "text", mime: "text/plain" }],
                metadata: { preserved: "state metadata to preserve" },
                error: { name: "ToolError", code: "E_TOOL" },
              },
              metadata: {
                truncation: { content: "large tool output", truncated: true },
              },
            },
          ],
        },
      ],
      cursor: { next: "opaque" },
    })
    expect(JSON.stringify(payload)).toContain("metadata output to omit")
    expect(JSON.stringify(payload)).toContain("a complete v2 user prompt")
    expect(JSON.stringify(payload)).toContain("a complete v2 answer")
    const loggedResponse = JSON.stringify(response)
    for (const removed of [
      "metadata output to omit",
      "metadata partial output to omit",
      "a complete v2 user prompt",
      "a complete v2 answer",
      "state input command to omit",
      "state input content to omit",
      "state input path to omit",
      "state input filePath to omit",
      "state content text to omit",
      "state result to omit",
      "state metadata output to omit",
      "state metadata partial output to omit",
      "state error message to omit",
      "message summary to omit",
      "summary body to omit",
    ]) {
      expect(loggedResponse).not.toContain(removed)
    }
    expect(loggedResponse).toContain("large tool output")
    expect(loggedResponse).toContain("state metadata to preserve")
    expect(loggedResponse).toContain("E_TOOL")

    const event = optimizeInteractionPayload(
      "opencode",
      { kind: "SSE message", path: "/api/session/ses_1/event" },
      {
        id: "evt_1",
        type: "session.text.ended",
        durable: { aggregateID: "ses_1", seq: 3, version: 1 },
        data: {
          sessionID: "ses_1",
          assistantMessageID: "msg_assistant",
          ordinal: 0,
          text: "complete durable response",
        },
      },
    )
    expect(event).toEqual({
      id: "evt_1",
      type: "session.text.ended",
      durable: { aggregateID: "ses_1", seq: 3, version: 1 },
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        ordinal: 0,
        textLength: 25,
      },
    })
  })

  test("OpenCode command catalog logs omit only each command template", () => {
    const payload = {
      location: { directory: "/workspace" },
      data: [
        {
          name: "review",
          description: "Review a target",
          template: "complete Skill instructions that should not be logged",
          subtask: false,
        },
        {
          name: "test",
          template: "run the complete test workflow",
          agent: "plan",
        },
      ],
    }

    const response = optimizeInteractionPayload(
      "opencode",
      {
        kind: "HTTP response",
        method: "GET",
        url: "/api/command?location%5Bdirectory%5D=%2Fworkspace",
        status: 200,
      },
      payload,
    )

    expect(response).toEqual({
      location: { directory: "/workspace" },
      data: [
        { name: "review", description: "Review a target", subtask: false },
        { name: "test", agent: "plan" },
      ],
    })
    expect(payload.data[0]!.template).toBe("complete Skill instructions that should not be logged")
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
