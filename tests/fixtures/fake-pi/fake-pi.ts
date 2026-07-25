#!/usr/bin/env bun
/**
 * Fake Pi server for testing.
 * Supports both --mode rpc (interactive JSONL RPC) and --mode json -p (one-shot print mode).
 *
 * RPC mode protocol:
 *   Commands (stdin):  {"type":"prompt","message":"...","id":"req-1"}
 *   Responses (stdout): {"type":"response","id":"req-1","command":"prompt","success":true}
 *   Events (stdout):    {"type":"agent_start"}, {"type":"message_update",...}, {"type":"agent_settled"}
 *
 * JSON mode protocol:
 *   stdout: newline-delimited JSON events (message_end, tool_result_end)
 *   Exits after outputting all events.
 */

import { argv } from "node:process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const DEBUG = argv.includes("--debug")
const TITLE_MODE = argv.includes("--no-tools") && argv.includes("--system-prompt")

function argumentValue(name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const SESSION_DIR = argumentValue("--session-dir")
const SESSION_ID = argumentValue("--session-id")
const REQUESTED_SESSION_FILE = argumentValue("--session")
let activeSessionId = SESSION_ID ?? "fake-session"
let activeSessionFile =
  REQUESTED_SESSION_FILE ?? (SESSION_DIR && SESSION_ID ? join(SESSION_DIR, `${SESSION_ID}.fake.json`) : undefined)
let persistedPrompts: string[] = []
let persistedEntries: Array<{
  id: string
  type: "message"
  parentId: string | null
  message: { role: "user"; content: string }
}> = []

function loadSession(path: string): void {
  activeSessionFile = path
  persistedPrompts = []
  persistedEntries = []
  if (!existsSync(path)) return
  try {
    const stored = JSON.parse(readFileSync(path, "utf8")) as {
      sessionId?: unknown
      prompts?: unknown
      entries?: unknown
    }
    if (typeof stored.sessionId === "string" && stored.sessionId) activeSessionId = stored.sessionId
    if (Array.isArray(stored.prompts)) {
      persistedPrompts = stored.prompts.filter((prompt): prompt is string => typeof prompt === "string")
    }
    if (Array.isArray(stored.entries)) {
      persistedEntries = stored.entries.filter((entry): entry is (typeof persistedEntries)[number] =>
        Boolean(
          entry &&
            typeof entry === "object" &&
            typeof (entry as { id?: unknown }).id === "string" &&
            (entry as { type?: unknown }).type === "message",
        ),
      )
    }
  } catch {
    // Treat malformed fake state as an empty session.
  }
}

if (activeSessionFile) loadSession(activeSessionFile)

function persistSession(): void {
  if (!activeSessionFile) return
  mkdirSync(SESSION_DIR ?? dirname(activeSessionFile), { recursive: true })
  writeFileSync(
    activeSessionFile,
    JSON.stringify({ sessionId: activeSessionId, prompts: persistedPrompts, entries: persistedEntries }),
    "utf8",
  )
}

function persistPrompt(prompt: string): void {
  persistedPrompts.push(prompt)
  const parentId = persistedEntries.at(-1)?.id ?? null
  persistedEntries.push({
    id: `entry_${crypto.randomUUID()}`,
    type: "message",
    parentId,
    message: { role: "user", content: prompt },
  })
  persistSession()
}

function log(msg: string): void {
  if (DEBUG) process.stderr.write(`[fake-pi] ${msg}\n`)
}

// =============================================================================
// JSON mode (--mode json -p --no-session)
// =============================================================================

async function runJsonMode(): Promise<void> {
  const args = argv.slice(2)

  let task = ""
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === "--mode" || arg === "-p" || arg === "--no-session") continue
    if (arg === "--model" || arg === "--tools" || arg === "--append-system-prompt" || arg === "--provider") {
      i++
      continue
    }
    if (!arg.startsWith("-") && arg.startsWith("Task:")) {
      task = arg.slice("Task:".length).trim()
    } else if (!arg.startsWith("-")) {
      task = arg
    }
  }

  log(`JSON mode: task="${task}"`)

  const wantsTool = task.includes("tool") || task.includes("bash") || task.includes("run") || task.includes("file")
  const wantsAborting = task.includes("abort") || task.includes("cancel")

  if (wantsAborting) {
    await Bun.sleep(500)
    process.exit(2)
  }

  const toolCallId = `call_${Date.now()}`

  if (wantsTool) {
    process.stdout.write(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll run that for you." },
            { type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "echo hello" } },
          ],
          usage: { input: 50, output: 30, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0005 }, totalTokens: 80 },
          model: "test-model",
          stopReason: "tool_use",
          timestamp: Date.now(),
        },
      }) + "\n",
    )

    process.stdout.write(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "toolResult",
          content: [{ type: "toolResult", toolCallId, content: [{ type: "text", text: "hello" }], isError: false }],
          timestamp: Date.now(),
        },
      }) + "\n",
    )
  }

  const response = wantsTool
    ? "Done. I executed the requested tool."
    : task === "report-agent-dir"
      ? (process.env.PI_CODING_AGENT_DIR ?? "<unset>")
      : `This is a fake Pi response to: "${task}". Pi agent simulation is working correctly.`

  process.stdout.write(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: response }],
        usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 0.001 }, totalTokens: 160 },
        model: "test-model",
        stopReason: "end",
        timestamp: Date.now(),
      },
    }) + "\n",
  )

  process.exit(0)
}

// Detect JSON mode
const modeIdx = argv.indexOf("--mode")
if (modeIdx >= 0 && argv[modeIdx + 1] === "json") {
  await runJsonMode()
}

// =============================================================================
// RPC mode (--mode rpc)
// =============================================================================

interface RpcCommand {
  type: string
  id?: string
  message?: string
  [key: string]: unknown
}

let pendingPermissionId: string | null = null

function sendResponse(id: string | undefined, command: string, success: boolean, data?: unknown): void {
  const msg: Record<string, unknown> = { type: "response", command, success }
  if (id) msg.id = id
  if (data !== undefined) msg.data = data
  process.stdout.write(JSON.stringify(msg) + "\n")
  log(`sent response: ${command} success=${success}`)
}

function sendEvent(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n")
  log(`sent event: ${event.type}`)
}

let buffer = ""
let aborted = false
let streamingUntil = 0

async function handleCommand(cmd: RpcCommand): Promise<void> {
  log(`received: ${cmd.type} (${cmd.id ?? "no-id"})`)

  switch (cmd.type) {
    case "prompt": {
      const text = cmd.message ?? ""
      sendResponse(cmd.id, cmd.type, true)
      if (text.includes("__no_agent_run__")) break
      if (text.includes("__extension_error_no_run__")) {
        sendEvent({ type: "extension_error", error: "Fake extension command failed" })
        break
      }
      if (text.includes("__exit_during_prompt__")) {
        setTimeout(() => process.exit(23), 5)
        break
      }
      await simulatePrompt(text)
      break
    }

    case "abort": {
      aborted = true
      sendResponse(cmd.id, "abort", true)
      sendEvent({ type: "agent_settled" })
      break
    }

    case "new_session": {
      sendResponse(cmd.id, "new_session", true, { cancelled: false })
      break
    }

    case "get_state": {
      sendResponse(cmd.id, "get_state", true, {
        isStreaming: Date.now() < streamingUntil,
        sessionFile: activeSessionFile ?? null,
        sessionId: activeSessionId,
        agentDir: process.env.PI_CODING_AGENT_DIR,
      })
      break
    }

    case "get_entries": {
      sendResponse(cmd.id, "get_entries", true, {
        entries: persistedEntries,
        leafId: persistedEntries.at(-1)?.id ?? null,
      })
      break
    }

    case "fork": {
      const entryId = typeof cmd.entryId === "string" ? cmd.entryId : ""
      const index = persistedEntries.findIndex((entry) => entry.id === entryId)
      if (index < 0 || !SESSION_DIR) {
        sendResponse(cmd.id, "fork", false)
        break
      }
      activeSessionId = crypto.randomUUID()
      activeSessionFile = join(SESSION_DIR, `${activeSessionId}.fake.json`)
      persistedEntries = persistedEntries.slice(0, index)
      persistedPrompts = persistedPrompts.slice(0, index)
      persistSession()
      sendResponse(cmd.id, "fork", true, { text: "", cancelled: false })
      break
    }

    case "switch_session": {
      const sessionPath = typeof cmd.sessionPath === "string" ? cmd.sessionPath : ""
      if (!sessionPath || !existsSync(sessionPath)) {
        sendResponse(cmd.id, "switch_session", false)
        break
      }
      loadSession(sessionPath)
      sendResponse(cmd.id, "switch_session", true, { cancelled: false })
      break
    }

    case "get_messages": {
      sendResponse(cmd.id, "get_messages", true, { messages: [] })
      break
    }

    case "set_model": {
      sendResponse(cmd.id, "set_model", true, { id: cmd.modelId, provider: cmd.provider })
      break
    }

    case "compact": {
      const result = {
        summary: "Fake compacted conversation summary",
        firstKeptEntryId: "fake-kept-entry",
        tokensBefore: 120000,
        estimatedTokensAfter: 24000,
        usage: {
          input: 12000,
          output: 600,
          cacheRead: 1000,
          cacheWrite: 0,
          totalTokens: 13600,
          cost: { total: 0.02 },
        },
        details: { customInstructions: cmd.customInstructions },
      }
      sendEvent({ type: "compaction_start", reason: "manual" })
      sendEvent({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false })
      sendResponse(cmd.id, "compact", true, result)
      break
    }

    case "extension_ui_response": {
      pendingPermissionId = null
      sendResponse(cmd.id, "extension_ui_response", true)
      break
    }

    default: {
      sendResponse(cmd.id, cmd.type, false, undefined)
    }
  }
}

async function simulatePrompt(text: string): Promise<void> {
  aborted = false
  const previousPrompt = persistedPrompts.at(-1)
  persistPrompt(text)

  const wantsReasoning = text.includes("reasoning") || text.includes("think")
  const wantsTool = text.includes("tool") || text.includes("bash") || text.includes("run") || text.includes("file")
  const wantsPermission = text.includes("permission") || text.includes("approve") || text.includes("write")
  const finalOnly = text.includes("__final_only__")
  const omitAgentEnd = text.includes("__omit_agent_end__")
  const omitAgentSettled = text.includes("__omit_agent_settled__")
  const delayedIdleWithoutSettled = text.includes("__delayed_idle_without_settled__")
  const toolSnapshotsOnly = text.includes("__tool_snapshots_only__")
  const retryOnce = text.includes("__retry_once__")
  const wantsModelSubtask = text.includes("__model_subtask__")
  const wantsAutoCompact = text.includes("__auto_compact__")

  sendEvent({ type: "agent_start" })
  sendEvent({ type: "turn_start" })

  await Bun.sleep(10)
  if (aborted) {
    sendEvent({ type: "agent_end", messages: [], willRetry: false })
    sendEvent({ type: "agent_settled" })
    return
  }

  // User message
  sendEvent({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  })
  sendEvent({
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  })

  await Bun.sleep(5)

  if (wantsAutoCompact) {
    const result = {
      summary: "Fake automatic compacted conversation summary",
      firstKeptEntryId: "fake-auto-kept-entry",
      tokensBefore: 180000,
      estimatedTokensAfter: 30000,
    }
    sendEvent({ type: "compaction_start", reason: "threshold" })
    sendEvent({ type: "compaction_end", reason: "threshold", result, aborted: false, willRetry: false })
  }

  if (TITLE_MODE) {
    const failOnceState = text.match(/__title_fail_once__=([^\s]+)/)?.[1]
    const alwaysFailState = text.match(/__title_always_fail__=([^\s]+)/)?.[1]
    const attemptState = failOnceState ?? alwaysFailState
    const shouldFail = Boolean(alwaysFailState) || Boolean(failOnceState && !existsSync(failOnceState))
    if (attemptState) appendFileSync(attemptState, "attempt\n", "utf8")

    if (shouldFail) {
      const failed = {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "HTTP 500: temporary title provider failure",
        timestamp: Date.now(),
      }
      sendEvent({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() } })
      sendEvent({ type: "message_end", message: failed })
      sendEvent({ type: "turn_end", message: failed, toolResults: [] })
      sendEvent({ type: "agent_end", messages: [failed], willRetry: false })
      sendEvent({ type: "agent_settled" })
      return
    }
  }

  if (retryOnce) {
    const failed = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "HTTP 500: temporary provider failure",
      timestamp: Date.now(),
    }
    sendEvent({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() } })
    sendEvent({
      type: "message_update",
      message: failed,
      assistantMessageEvent: { type: "error", reason: "error", error: failed },
    })
    sendEvent({ type: "message_end", message: failed })
    sendEvent({ type: "turn_end", message: failed, toolResults: [] })
    sendEvent({ type: "agent_end", messages: [failed], willRetry: true })
    sendEvent({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      errorMessage: failed.errorMessage,
    })
    await Bun.sleep(10)
    sendEvent({ type: "agent_start" })
    sendEvent({ type: "turn_start" })
  }

  // Assistant message
  sendEvent({
    type: "message_start",
    message: { role: "assistant", content: [], timestamp: Date.now() },
  })

  if (!TITLE_MODE && text.includes("__slow_response__")) {
    await Bun.sleep(1000)
  }

  // Reasoning block
  if (wantsReasoning && !finalOnly) {
    sendEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} },
    })

    const reasoning = "Let me analyze this request carefully."
    const rWords = reasoning.split(" ")
    for (const word of rWords) {
      if (aborted) break
      await Bun.sleep(5)
      sendEvent({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: word + " ", partial: {} },
      })
    }

    if (!aborted) {
      sendEvent({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0, partial: {} },
      })
    }
  }

  if (wantsModelSubtask && !aborted) {
    const toolCallId = `call_task_${Date.now()}`
    const childToolCallId = `call_child_${Date.now()}`
    const toolArgs = {
      description: "Inspect through child agent",
      prompt: "Inspect the fake project and report the child shell result",
      subagent_type: "explore",
    }
    const emitChild = (childEvent: Record<string, unknown>, output = "") => {
      sendEvent({
        type: "tool_execution_update",
        toolCallId,
        toolName: "task",
        args: toolArgs,
        partialResult: {
          content: [{ type: "text", text: output }],
          details: {
            mode: "single",
            agent: "explore",
            status: "running",
            description: toolArgs.description,
            __opencode_adaptor_subtask_event: childEvent,
          },
        },
      })
    }

    sendEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        // Pi can expose a partially decoded argument object while the model is
        // still streaming the tool call. description arrives at toolcall_end.
        toolCall: { id: toolCallId, name: "task", arguments: { prompt: toolArgs.prompt } },
        partial: {},
      },
    })
    sendEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { id: toolCallId, name: "task", arguments: toolArgs },
        partial: {},
      },
    })
    sendEvent({ type: "tool_execution_start", toolCallId, toolName: "task", args: toolArgs })

    emitChild({ type: "agent_start" })
    emitChild({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    })
    emitChild({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Inspecting child workspace." },
    })
    emitChild({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Inspecting child workspace." },
    })
    emitChild({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: childToolCallId, name: "bash", arguments: { command: "echo child" } }],
      },
    })
    emitChild({
      type: "tool_execution_start",
      toolCallId: childToolCallId,
      toolName: "bash",
      args: { command: "echo child" },
    })
    emitChild({
      type: "tool_execution_end",
      toolCallId: childToolCallId,
      toolName: "bash",
      result: { content: [{ type: "text", text: "child" }], details: { exit: 0 } },
      isError: false,
    })
    emitChild({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    })
    emitChild({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Child inspection complete." },
    })
    emitChild({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Child inspection complete." },
    })
    emitChild(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Child inspection complete." }],
          stopReason: "stop",
        },
      },
      "Child inspection complete.",
    )
    emitChild(
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            usage: {
              input: 21,
              output: 13,
              cacheRead: 2,
              cacheWrite: 1,
              totalTokens: 37,
              cost: { total: 0.0002 },
            },
          },
        ],
        willRetry: false,
      },
      "Child inspection complete.",
    )
    emitChild({ type: "agent_settled" }, "Child inspection complete.")

    sendEvent({
      type: "tool_execution_end",
      toolCallId,
      toolName: "task",
      result: {
        content: [{ type: "text", text: "Child inspection complete." }],
        details: {
          mode: "single",
          agent: "explore",
          status: "completed",
          description: toolArgs.description,
          usage: {
            input: 21,
            output: 13,
            cacheRead: 2,
            cacheWrite: 1,
            totalTokens: 37,
            cost: { total: 0.0002 },
          },
        },
      },
      isError: false,
    })
  }

  // Tool call
  if (wantsTool && !aborted) {
    const toolCallId = `call_${Date.now()}`
    const toolName = wantsPermission ? "write" : "bash"
    const toolArgs = wantsPermission ? { path: "/tmp/test.txt", content: "hello" } : { command: "echo hello" }

    if (toolSnapshotsOnly) {
      sendEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: toolArgs }],
          timestamp: Date.now(),
        },
      })
    } else {
      sendEvent({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 1,
          toolCall: { id: toolCallId, name: toolName, arguments: toolArgs },
          partial: {},
        },
      })

      sendEvent({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 1,
          delta: JSON.stringify(toolArgs),
          partial: {},
        },
      })

      sendEvent({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 1,
          toolCall: { id: toolCallId, name: toolName, arguments: toolArgs },
          partial: {},
        },
      })
    }

    // Permission request for dangerous tools
    if (wantsPermission) {
      pendingPermissionId = `perm_${Date.now()}`
      sendEvent({
        type: "extension_ui_request",
        id: pendingPermissionId,
        method: "select",
        title: `Allow ${toolName} to ${wantsPermission ? "write file" : "run command"}?`,
        options: ["Allow", "Block"],
        timeout: 10000,
      })

      // Wait for permission response (up to 5 seconds)
      const deadline = Date.now() + 5000
      while (pendingPermissionId && Date.now() < deadline && !aborted) {
        await Bun.sleep(50)
      }

      if (pendingPermissionId) {
        // Timeout - tool denied
        sendEvent({
          type: "tool_execution_start",
          toolCallId,
          toolName,
          args: toolArgs,
        })
        sendEvent({
          type: "tool_execution_end",
          toolCallId,
          toolName,
          result: { content: [{ type: "text", text: "Permission denied (timeout)" }] },
          isError: true,
        })
      } else {
        // Permission granted
        sendEvent({
          type: "tool_execution_start",
          toolCallId,
          toolName,
          args: toolArgs,
        })
        await Bun.sleep(10)
        sendEvent({
          type: "tool_execution_end",
          toolCallId,
          toolName,
          result: { content: [{ type: "text", text: "Success: file written" }] },
          isError: false,
        })
      }
    } else {
      // No permission needed, execute directly
      if (toolSnapshotsOnly) {
        sendEvent({
          type: "message_end",
          message: {
            role: "toolResult",
            toolCallId,
            toolName,
            content: [{ type: "text", text: "hello from snapshot" }],
            details: { recoveredFromSnapshot: true, exit: 0 },
            isError: false,
            timestamp: Date.now(),
          },
        })
      } else {
        sendEvent({
          type: "tool_execution_start",
          toolCallId,
          toolName,
          args: toolArgs,
        })
        await Bun.sleep(10)
        sendEvent({
          type: "tool_execution_update",
          toolCallId,
          toolName,
          args: toolArgs,
          partialResult: {
            content: [{ type: "text", text: "hel" }],
            details: { streamed: true },
          },
        })
        sendEvent({
          type: "tool_execution_end",
          toolCallId,
          toolName,
          result: {
            content: [{ type: "text", text: "hello" }],
            details: { streamed: true, exit: 0 },
          },
          isError: false,
        })
      }
    }
  }

  // Text response
  if (!aborted) {
    const reasoning = "Let me analyze this request carefully."
    const response = TITLE_MODE
      ? "Fake conversation title"
      : text.includes("__recall_previous_prompt__")
        ? `Restored previous prompt: "${previousPrompt ?? "<none>"}".`
        : wantsTool || wantsModelSubtask
          ? `Done. I executed the requested tool.`
          : `This is a fake Pi response to: "${text}". Pi agent simulation is working correctly.`
    const textContentIndex = wantsReasoning ? 1 : 0

    if (!finalOnly) {
      sendEvent({
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
        assistantMessageEvent: { type: "text_start", contentIndex: textContentIndex, partial: {} },
      })

      const words = response.split(" ")

      for (const word of words) {
        if (aborted) break
        await Bun.sleep(10)
        sendEvent({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: word }] },
          assistantMessageEvent: { type: "text_delta", contentIndex: textContentIndex, delta: word + " ", partial: {} },
        })
      }

      if (!aborted) {
        sendEvent({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: response }] },
          assistantMessageEvent: { type: "text_end", contentIndex: textContentIndex, content: response, partial: {} },
        })

        sendEvent({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: response }] },
          assistantMessageEvent: { type: "done", reason: "stop" },
        })
      }
    }

    sendEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          ...(wantsReasoning ? [{ type: "thinking", thinking: reasoning }] : []),
          { type: "text", text: response },
        ],
        stopReason: "stop",
        timestamp: Date.now(),
      },
    })
    if (retryOnce) sendEvent({ type: "auto_retry_end", success: true, attempt: 1 })

    sendEvent({ type: "turn_end", message: {}, toolResults: [] })
  }

  if (!omitAgentEnd) sendEvent({ type: "agent_end", messages: [], willRetry: false })
  if (delayedIdleWithoutSettled) streamingUntil = Date.now() + 1500
  if (!omitAgentSettled) sendEvent({ type: "agent_settled" })
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf-8")
  const lines = buffer.split(/\r?\n/)
  buffer = lines.pop() ?? ""

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const cmd = JSON.parse(line) as RpcCommand
      handleCommand(cmd).catch((err) => {
        log(`error handling command: ${err}`)
      })
    } catch {
      log(`invalid JSON: ${line.slice(0, 100)}`)
    }
  }
})

process.stdin.on("end", () => {
  log("stdin ended, exiting")
  process.exit(0)
})

process.on("SIGTERM", () => {
  log("received SIGTERM, exiting")
  process.exit(0)
})

process.on("SIGINT", () => {
  log("received SIGINT, exiting")
  process.exit(0)
})

log("Fake Pi RPC server ready")
