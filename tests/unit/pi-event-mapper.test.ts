import { describe, expect, test } from "bun:test"
import { PiToOpenCodeEventMapper } from "../../src/agents/pi/pi-event-mapper.ts"

function createMapper(onUnmapped?: (event: { type: string }, reason: string) => void) {
  let part = 0
  return new PiToOpenCodeEventMapper({
    sessionId: "ses_test",
    assistantMessageId: "msg_assistant",
    partIdMap: new Map(),
    generatePartId: () => `prt_${++part}`,
    onUnmapped,
  })
}

describe("PiToOpenCodeEventMapper terminal reconciliation", () => {
  test("reports each Pi event that has no OpenCode mapping exactly once", () => {
    const unmapped: Array<{ type: string; reason: string }> = []
    const mapper = createMapper((event, reason) => unmapped.push({ type: event.type, reason }))

    expect(mapper.map({ type: "turn_start" })).toEqual([])
    expect(
      mapper.map({
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 7, delta: '{"path":' },
      }),
    ).toEqual([])
    expect(mapper.map({ type: "agent_start" })).toHaveLength(1)

    expect(unmapped).toHaveLength(2)
    expect(unmapped[0]).toMatchObject({ type: "turn_start" })
    expect(unmapped[0]?.reason).toContain("no separate turn lifecycle")
    expect(unmapped[1]).toMatchObject({ type: "message_update" })
    expect(unmapped[1]?.reason).toContain("without a known tool-call start")
  })

  test("materializes final reasoning and text when streaming updates are absent", () => {
    const mapper = createMapper()
    const events = mapper.map({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "final reasoning" },
          { type: "text", text: "final answer" },
        ],
      },
    })

    expect(events.map((event) => event.type)).toEqual([
      "reasoning_started",
      "reasoning_snapshot",
      "reasoning_ended",
      "text_started",
      "text_snapshot",
      "text_ended",
    ])
    expect(events.find((event) => event.type === "reasoning_snapshot")).toMatchObject({
      text: "final reasoning",
    })
    expect(events.find((event) => event.type === "text_snapshot")).toMatchObject({
      text: "final answer",
    })
  })

  test("repairs an incomplete streamed block from the message_end snapshot", () => {
    const mapper = createMapper()
    mapper.map({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    })
    mapper.map({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" },
    })

    const events = mapper.map({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "complete final answer" }],
      },
    })

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: "text_snapshot", text: "complete final answer" })
    expect(events[1]).toMatchObject({ type: "text_ended" })
  })

  test("reuses streamed parts when the final snapshot compresses content indexes", () => {
    const mapper = createMapper()
    mapper.map({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    })
    mapper.map({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "child response" },
    })
    mapper.map({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "child response" },
    })

    expect(
      mapper.map({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "child response" }],
          stopReason: "stop",
        },
      }),
    ).toEqual([])
  })

  test("synthesizes a start when a provider emits a delta first", () => {
    const mapper = createMapper()
    const events = mapper.map({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reasoning" },
    })

    expect(events.map((event) => event.type)).toEqual(["reasoning_started", "reasoning_delta"])
  })

  test("maps every Pi streaming delta without coalescing or dropping it", () => {
    const mapper = createMapper()
    mapper.map({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    })

    const deltas = ["用户", "要求", "我", "执行"]
    const mapped = deltas.flatMap((delta) =>
      mapper.map({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta },
      }),
    )

    expect(mapped).toHaveLength(deltas.length)
    expect(mapped.map((event) => event.type)).toEqual(deltas.map(() => "reasoning_delta"))
    expect(mapped.map((event) => (event.type === "reasoning_delta" ? event.delta : undefined))).toEqual(deltas)
    expect(mapped.at(-1)).toMatchObject({
      type: "reasoning_delta",
      delta: "执行",
      text: "用户要求我执行",
    })

    expect(
      mapper.map({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
      }),
    ).toMatchObject([{ type: "reasoning_ended", text: "用户要求我执行" }])
  })

  test("does not complete the OpenCode message for a retrying agent_end", () => {
    const mapper = createMapper()
    expect(mapper.map({ type: "agent_end", messages: [], willRetry: true })).toEqual([])
    expect(mapper.map({ type: "agent_end", messages: [], willRetry: false })).toMatchObject([
      { type: "message_completed", finish: "stop" },
    ])
  })

  test("keeps a transient provider error non-terminal and resumes the same OpenCode message", () => {
    const mapper = createMapper()

    expect(
      mapper.map({
        type: "message_update",
        assistantMessageEvent: {
          type: "error",
          reason: "error",
          error: { stopReason: "error", errorMessage: "HTTP 500: overloaded" },
        },
      }),
    ).toEqual([])
    expect(
      mapper.map({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "HTTP 500: overloaded",
        },
      }),
    ).toEqual([])
    expect(mapper.map({ type: "agent_end", messages: [], willRetry: true })).toEqual([])

    const retry = mapper.map({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 250,
      errorMessage: "HTTP 500: overloaded",
    })
    expect(retry).toMatchObject([
      {
        type: "session_retry",
        attempt: 1,
        message: "HTTP 500: overloaded",
      },
    ])
    expect((retry[0] as { next: number }).next).toBeGreaterThan(Date.now())

    expect(mapper.map({ type: "agent_start" })).toEqual([{ type: "session_busy", sessionId: "ses_test" }])
    expect(
      mapper.map({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "recovered" },
      }),
    ).toMatchObject([{ type: "text_started" }, { type: "text_delta", delta: "recovered" }])
    expect(
      mapper.map({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
          stopReason: "stop",
        },
      }),
    ).toMatchObject([{ type: "text_ended" }])

    const terminal = mapper.map({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
      willRetry: false,
    })
    expect(terminal.some((event) => event.type === "session_error")).toBe(false)
    expect(terminal).toMatchObject([{ type: "message_completed", finish: "stop" }])
  })

  test("reports a provider error only after Pi declares it non-retryable", () => {
    const mapper = createMapper()
    mapper.map({
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { stopReason: "error", errorMessage: "HTTP 500: exhausted" },
      },
    })

    const events = mapper.map({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 500: exhausted" }],
      willRetry: false,
    })

    expect(events).toMatchObject([
      { type: "message_completed", finish: "error" },
      {
        type: "session_error",
        error: { type: "pi_error", message: "HTTP 500: exhausted" },
      },
    ])
  })

  test("maps Pi summarization retries onto the OpenCode retry status", () => {
    const mapper = createMapper()
    const scheduled = mapper.map({
      type: "summarization_retry_scheduled",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 500,
      errorMessage: "temporary summarization failure",
    })

    expect(scheduled).toMatchObject([
      {
        type: "session_retry",
        attempt: 2,
        message: "temporary summarization failure",
      },
    ])
    expect((scheduled[0] as { next: number }).next).toBeGreaterThan(Date.now())
    expect(mapper.map({ type: "summarization_retry_attempt_start", source: "compaction" })).toEqual([
      { type: "session_busy", sessionId: "ses_test" },
    ])
    expect(mapper.map({ type: "summarization_retry_finished" })).toEqual([
      { type: "session_busy", sessionId: "ses_test" },
    ])
  })

  test("maps a Pi session name change to an OpenCode session title event", () => {
    const mapper = createMapper()
    expect(mapper.map({ type: "session_info_changed", name: "  Backend title  " })).toEqual([
      {
        type: "session_title_changed",
        sessionId: "ses_test",
        title: "Backend title",
      },
    ])
  })

  test("maps Pi tool progress and final metadata to OpenCode tool states", () => {
    const mapper = createMapper()
    const started = mapper.map({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "/tmp/file.txt" },
    })
    expect(started).toMatchObject([
      {
        type: "tool_call_started",
        tool: "read",
        input: { path: "/tmp/file.txt", filePath: "/tmp/file.txt" },
      },
      {
        type: "tool_call_running",
        tool: "read",
        input: { path: "/tmp/file.txt", filePath: "/tmp/file.txt" },
      },
    ])

    expect(
      mapper.map({
        type: "tool_execution_update",
        toolCallId: "call_1",
        partialResult: { content: [{ type: "text", text: "partial" }], details: { line: 1 } },
      }),
    ).toMatchObject([{ type: "tool_call_progress", output: "partial", metadata: { line: 1 } }])

    expect(
      mapper.map({
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "read",
        result: {
          content: [
            { type: "text", text: "one" },
            { type: "image", data: "ignored" },
            { type: "text", text: "two" },
          ],
          details: { lines: 2 },
        },
        isError: false,
      }),
    ).toMatchObject([
      {
        type: "tool_call_completed",
        tool: "read",
        input: { path: "/tmp/file.txt", filePath: "/tmp/file.txt" },
        output: "one\ntwo",
        title: "read",
        metadata: { lines: 2 },
      },
    ])
  })

  test("extracts private Pi task events without leaking them into Desktop metadata", () => {
    const mapper = createMapper()
    mapper.map({
      type: "tool_execution_start",
      toolCallId: "call_task",
      toolName: "task",
      args: {
        description: "Inspect files",
        prompt: "Inspect the repository",
        subagent_type: "explore",
      },
    })

    const events = mapper.map({
      type: "tool_execution_update",
      toolCallId: "call_task",
      toolName: "task",
      partialResult: {
        content: [{ type: "text", text: "working" }],
        details: {
          mode: "single",
          __opencode_adaptor_subtask_event: {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "child output" },
          },
        },
      },
    })

    expect(events[0]).toMatchObject({
      type: "tool_call_progress",
      metadata: { mode: "single" },
    })
    expect(events.slice(1)).toMatchObject([
      {
        type: "subtask_event",
        callId: "call_task",
        event: { type: "text_started" },
      },
      {
        type: "subtask_event",
        callId: "call_task",
        input: {
          description: "Inspect files",
          prompt: "Inspect the repository",
          subagent_type: "explore",
        },
        event: {
          type: "text_delta",
          delta: "child output",
          text: "child output",
        },
      },
    ])
    expect((events[0] as { metadata?: Record<string, unknown> }).metadata).not.toHaveProperty(
      "__opencode_adaptor_subtask_event",
    )
  })

  test("repairs a tool lifecycle from assistant and tool-result snapshots", () => {
    const mapper = createMapper()
    const assistantEvents = mapper.map({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_snapshot",
            name: "bash",
            arguments: { command: "printf repaired" },
          },
        ],
      },
    })
    expect(assistantEvents).toMatchObject([
      {
        type: "tool_call_started",
        tool: "bash",
        input: { command: "printf repaired" },
      },
      {
        type: "tool_call_running",
        tool: "bash",
        input: { command: "printf repaired" },
      },
    ])

    const resultEvents = mapper.map({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call_snapshot",
        toolName: "bash",
        content: [{ type: "text", text: "repaired" }],
        details: { exitCode: 0 },
        isError: false,
      },
    })
    expect(resultEvents).toMatchObject([
      {
        type: "tool_call_completed",
        tool: "bash",
        input: { command: "printf repaired" },
        output: "repaired",
        metadata: { exitCode: 0 },
      },
    ])
  })

  test("synthesizes missing start events and normalizes Pi tools for Desktop", () => {
    const mapper = createMapper()
    const events = mapper.map({
      type: "tool_execution_update",
      toolCallId: "call_find",
      toolName: "find",
      args: { path: "/repo", pattern: "**/*.ts" },
      partialResult: { content: [{ type: "text", text: "src/index.ts" }] },
    })

    expect(events).toMatchObject([
      {
        type: "tool_call_started",
        tool: "glob",
        input: { path: "/repo", pattern: "**/*.ts" },
      },
      {
        type: "tool_call_running",
        tool: "glob",
        input: { path: "/repo", pattern: "**/*.ts" },
      },
      {
        type: "tool_call_progress",
        output: "src/index.ts",
      },
    ])
  })

  test("finalizes an orphaned running tool at the terminal boundary", () => {
    const mapper = createMapper()
    mapper.map({
      type: "tool_execution_start",
      toolCallId: "call_orphan",
      toolName: "read",
      args: { path: "/repo/README.md" },
    })

    const events = mapper.map({ type: "agent_end", messages: [], willRetry: false })
    expect(events).toMatchObject([
      {
        type: "tool_call_completed",
        tool: "read",
        input: { path: "/repo/README.md", filePath: "/repo/README.md" },
        metadata: { recovered: true },
      },
      { type: "message_completed" },
    ])
  })
})
