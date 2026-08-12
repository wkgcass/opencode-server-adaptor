import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { PiRpcTransport } from "../../src/agents/pi/pi-rpc-transport.ts"
import { PiRpcRuntime } from "../../src/agents/pi/pi-rpc-runtime.ts"
import { PiConversationStore } from "../../src/agents/pi/pi-conversation-store.ts"
import type { AgentRuntimeEvent } from "../../src/agents/agent-adapter.ts"
import { DatabaseService } from "../../src/db/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { MessageRepository } from "../../src/message/index.ts"
import { SessionRepository } from "../../src/session/index.ts"

const fakePi = join(import.meta.dir, "..", "fixtures", "fake-pi", "fake-pi.ts")
const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

const emptySkills = (directory: string) => ({ revision: "empty", directory, skills: [] })

function createTestRuntime(sessionId: string, rpcTimeoutMs = 2000): PiRpcRuntime {
  return new PiRpcRuntime(
    {
      sessionId,
      directory: process.cwd(),
      logger: silentLogger,
      config: {},
      skills: emptySkills(process.cwd()),
    },
    {
      cliPath: `"${process.execPath}" "${fakePi}"`,
      args: ["--mode", "rpc"],
      sessionDir: "/tmp",
      rpcTimeoutMs,
      startTimeoutMs: 2000,
    },
  )
}

describe("PiRpcTransport", () => {
  let transport: PiRpcTransport | undefined

  afterEach(async () => {
    await transport?.stop()
  })

  test("round-trips successful RPC commands", async () => {
    transport = new PiRpcTransport({
      cliPath: `"${process.execPath}" "${fakePi}"`,
      args: ["--mode", "rpc"],
      rpcTimeoutMs: 2000,
      startTimeoutMs: 2000,
      logger: silentLogger,
    })
    await transport.start()

    const response = await transport.send({ type: "get_state" })
    expect(response.success).toBe(true)
    expect((response.data as { sessionId: string }).sessionId).toBe("fake-session")
  })

  test("buffers Pi events that arrive before the first transport subscriber", async () => {
    transport = new PiRpcTransport({
      cliPath: `"${process.execPath}" "${fakePi}"`,
      args: ["--mode", "rpc"],
      rpcTimeoutMs: 2000,
      startTimeoutMs: 2000,
      logger: silentLogger,
    })
    const internal = transport as unknown as { parseLine: (line: string) => void }
    internal.parseLine(JSON.stringify({ type: "session_info_changed", name: "Early title" }))

    const received: string[] = []
    const unsubscribe = transport.subscribe((event) => received.push(event.type))
    await Promise.resolve()

    expect(received).toEqual(["session_info_changed"])
    unsubscribe()
  })

  test("warns once when a buffered Pi event is ultimately discarded", async () => {
    let output = ""
    const logger = new Logger({
      minLevel: "WARN",
      printLogs: true,
      stream: { write: (data) => void (output += data) },
    })
    transport = new PiRpcTransport({
      cliPath: `"${process.execPath}" "${fakePi}"`,
      args: ["--mode", "rpc"],
      rpcTimeoutMs: 2000,
      startTimeoutMs: 2000,
      logger,
    })
    const internal = transport as unknown as { parseLine: (line: string) => void }
    internal.parseLine(JSON.stringify({ type: "turn_start" }))
    await transport.stop()

    expect(output).toContain("\u001b[38;5;208m[WARN]")
    expect(output).toContain("Pi event produced no OpenCode event")
    expect(output.match(/piEvent=turn_start/g)).toHaveLength(1)
  })

  test("verbose interaction logging includes complete stdin, stdout, and stderr payloads", async () => {
    const interactions: Array<{
      direction: "in" | "out"
      metadata: Record<string, unknown>
      payload: unknown
      options?: { omitPayload?: boolean }
    }> = []
    const logger = {
      ...silentLogger,
      isVerbose: () => true,
      interaction(
        channel: "opencode" | "pi",
        direction: "in" | "out",
        metadata: Record<string, unknown>,
        payload: unknown,
        options?: { omitPayload?: boolean },
      ) {
        expect(channel).toBe("pi")
        interactions.push({ direction, metadata, payload, options })
      },
    }
    transport = new PiRpcTransport({
      cliPath: `"${process.execPath}" "${fakePi}"`,
      args: ["--mode", "rpc", "--debug"],
      rpcTimeoutMs: 2000,
      startTimeoutMs: 2000,
      logger,
    })
    await transport.start()

    const response = await transport.send({ type: "get_state" })
    expect(response.success).toBe(true)
    const entriesResponse = await transport.send({ type: "get_entries" })
    expect(entriesResponse.success).toBe(true)
    await Bun.sleep(20)

    const outbound = interactions.find((item) => item.direction === "out" && item.metadata.stream === "stdin")
    expect(outbound?.payload).toMatchObject({ type: "get_state" })
    expect((outbound?.payload as { id?: string }).id).toStartWith("req_")

    const inbound = interactions.find(
      (item) =>
        item.direction === "in" &&
        item.metadata.stream === "stdout" &&
        (item.payload as { type?: string }).type === "response",
    )
    expect(inbound?.payload).toMatchObject({
      type: "response",
      command: "get_state",
      success: true,
    })
    expect(inbound?.metadata.command).toBe("get_state")
    expect(inbound?.options?.omitPayload).toBe(false)

    const getEntriesResponse = interactions.find(
      (item) => item.direction === "in" && item.metadata.stream === "stdout" && item.metadata.command === "get_entries",
    )
    expect(getEntriesResponse?.payload).toMatchObject({
      type: "response",
      command: "get_entries",
      success: true,
    })
    expect(getEntriesResponse?.options?.omitPayload).toBe(true)

    const stderr = interactions
      .filter((item) => item.direction === "in" && item.metadata.stream === "stderr")
      .map((item) => item.payload)
      .join("\n")
    expect(stderr).toContain("Fake Pi RPC server ready")
    expect(stderr).toContain("received: get_state")
  })

  test("verbose logging omits only the get_entries response payload", async () => {
    let output = ""
    const logger = new Logger({
      minLevel: "DEBUG",
      printLogs: true,
      verbose: true,
      stream: { write: (data) => void (output += data) },
    })
    transport = new PiRpcTransport({
      cliPath: `"${process.execPath}" "${fakePi}"`,
      args: ["--mode", "rpc"],
      rpcTimeoutMs: 2000,
      startTimeoutMs: 2000,
      logger,
    })
    await transport.start()

    await transport.send({ type: "get_state" })
    await transport.send({ type: "get_entries" })
    await Bun.sleep(20)

    expect(output).toContain("stream=stdout type=response command=get_state")
    expect(output).toContain('"sessionId":"fake-session"')
    expect(output).toContain("stream=stdout type=response command=get_entries")
    expect(output).not.toContain('"entries":')
    expect(output).not.toContain('"leafId":')
  })

  test("rejects Pi responses with success=false", async () => {
    transport = new PiRpcTransport({
      cliPath: `"${process.execPath}" "${fakePi}"`,
      args: ["--mode", "rpc"],
      rpcTimeoutMs: 2000,
      startTimeoutMs: 2000,
      logger: silentLogger,
    })
    await transport.start()

    await expect(transport.send({ type: "not_a_real_command" })).rejects.toThrow(
      "Pi RPC command 'not_a_real_command' failed",
    )
  })

  test("projects a compact RPC failure when Pi omits compaction lifecycle events", async () => {
    const runtime = createTestRuntime("runtime-compact-rpc-failure")
    const events: AgentRuntimeEvent[] = []
    const unsubscribe = runtime.subscribe((event) => events.push(event))

    try {
      await runtime.start()
      await expect(runtime.compact({ customInstructions: "__fail_compact__" })).rejects.toThrow(
        "Turn prefix summarization failed: fake provider error",
      )
      expect(events).toContainEqual({
        type: "compaction_started",
        sessionId: "runtime-compact-rpc-failure",
        reason: "manual",
        backendReason: "manual",
      })
      expect(events).toContainEqual({
        type: "compaction_failed",
        sessionId: "runtime-compact-rpc-failure",
        reason: "manual",
        backendReason: "manual",
        error: "Pi RPC command 'compact' failed: Turn prefix summarization failed: fake provider error",
        aborted: false,
        willRetry: false,
      })
    } finally {
      unsubscribe()
      await runtime.stop()
    }
  })

  test("accepts a successful compaction_end when the later compact response conflicts", async () => {
    const runtime = createTestRuntime("runtime-compact-terminal-success")
    const events: AgentRuntimeEvent[] = []
    const unsubscribe = runtime.subscribe((event) => events.push(event))

    try {
      await runtime.start()
      const result = await runtime.compact({ customInstructions: "__compact_event_success_response_failure__" })
      expect(result.summary).toBe("Fake compacted conversation summary")
      expect(events.map((event) => event.type)).toEqual([
        "session_started",
        "compaction_started",
        "compaction_completed",
      ])
      expect(events.some((event) => event.type === "compaction_failed")).toBe(false)
    } finally {
      unsubscribe()
      await runtime.stop()
    }
  })

  test("does not apply the short-command RPC timeout to an active compaction", async () => {
    const runtime = createTestRuntime("runtime-slow-compaction", 200)
    const events: AgentRuntimeEvent[] = []
    const unsubscribe = runtime.subscribe((event) => events.push(event))

    try {
      await runtime.start()
      const result = await runtime.compact({ customInstructions: "__slow_compact__" })
      expect(result.summary).toBe("Fake compacted conversation summary")
      expect(events.some((event) => event.type === "compaction_completed")).toBe(true)
      expect(events.some((event) => event.type === "compaction_failed")).toBe(false)
    } finally {
      unsubscribe()
      await runtime.stop()
    }
  })

  test("passes an environment overlay to Pi", async () => {
    transport = new PiRpcTransport({
      cliPath: `"${process.execPath}" "${fakePi}"`,
      args: ["--mode", "rpc"],
      env: { PI_CODING_AGENT_DIR: "/tmp/adaptor-pi-agent" },
      rpcTimeoutMs: 2000,
      startTimeoutMs: 2000,
      logger: silentLogger,
    })
    await transport.start()

    const response = await transport.send({ type: "get_state" })
    expect((response.data as { agentDir: string }).agentDir).toBe("/tmp/adaptor-pi-agent")
  })

  test("materializes configuration immediately before starting Pi", async () => {
    let beforeStartCalls = 0
    const runtime = new PiRpcRuntime(
      {
        sessionId: "runtime-before-start",
        directory: process.cwd(),
        logger: silentLogger,
        config: {},
        skills: emptySkills(process.cwd()),
      },
      {
        cliPath: `"${process.execPath}" "${fakePi}"`,
        sessionDir: "/tmp",
        rpcTimeoutMs: 2000,
        startTimeoutMs: 2000,
        beforeStart: () => {
          beforeStartCalls++
        },
      },
    )

    try {
      expect(beforeStartCalls).toBe(0)
      await runtime.start()
      expect(beforeStartCalls).toBe(1)
    } finally {
      await runtime.stop()
    }
  })

  test("starts Pi with only the Skill snapshot supplied by the application layer", async () => {
    const skillPath = join(process.cwd(), ".pi", "skills", "review", "SKILL.md")
    const runtime = new PiRpcRuntime(
      {
        sessionId: "runtime-skills",
        directory: process.cwd(),
        logger: silentLogger,
        config: {},
        skills: {
          revision: "skills-1",
          directory: process.cwd(),
          skills: [
            {
              name: "review",
              description: "Review code",
              slash: true,
              location: skillPath,
              content: "Review code.",
              baseDirectory: join(process.cwd(), ".pi", "skills", "review"),
              files: [skillPath],
              digest: "review-digest",
              disableModelInvocation: true,
            },
          ],
        },
      },
      {
        cliPath: `"${process.execPath}" "${fakePi}"`,
        sessionDir: "/tmp",
        rpcTimeoutMs: 2000,
        startTimeoutMs: 2000,
      },
    )
    const texts: string[] = []
    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === "text_ended") texts.push(event.text)
    })
    try {
      await runtime.start()
      await runtime.prompt({
        sessionId: "runtime-skills",
        messageId: "msg_user_skills",
        assistantMessageId: "msg_assistant_skills",
        text: "__report_skill_args__",
      })
      expect(texts.join("\n")).toContain('"noSkills":true')
      expect(texts.join("\n")).toContain(JSON.stringify(skillPath).slice(1, -1))
    } finally {
      unsubscribe()
      await runtime.stop()
    }
  })

  test("projects a session-level Pi extension error before any prompt mapper exists", () => {
    const runtime = createTestRuntime("runtime-startup-extension-error")
    const events: AgentRuntimeEvent[] = []
    const unsubscribe = runtime.subscribe((event) => events.push(event))
    const internal = runtime as unknown as { handlePiEvent: (event: { type: string; error: string }) => void }

    try {
      internal.handlePiEvent({ type: "extension_error", error: "Extension failed during startup" })
      expect(events).toContainEqual({
        type: "session_error",
        sessionId: "runtime-startup-extension-error",
        error: { type: "extension_error", message: "Extension failed during startup" },
        fatal: false,
      })
    } finally {
      unsubscribe()
    }
  })

  test("logs each unmapped Pi event once as an orange WARN", async () => {
    let output = ""
    const logger = new Logger({
      minLevel: "WARN",
      printLogs: true,
      stream: { write: (data) => void (output += data) },
    })
    const runtime = new PiRpcRuntime(
      {
        sessionId: "runtime-unmapped-warning",
        directory: process.cwd(),
        logger,
        config: {},
        skills: emptySkills(process.cwd()),
      },
      {
        cliPath: `"${process.execPath}" "${fakePi}"`,
        args: ["--mode", "rpc"],
        sessionDir: "/tmp",
        rpcTimeoutMs: 2000,
        startTimeoutMs: 2000,
      },
    )
    const unsubscribe = runtime.subscribe(() => undefined)

    try {
      await runtime.start()
      await runtime.prompt({
        sessionId: "runtime-unmapped-warning",
        messageId: "msg_user",
        assistantMessageId: "msg_assistant",
        text: "plain response",
      })

      expect(output).toContain("\u001b[38;5;208m[WARN]")
      expect(output).toContain("Pi event produced no OpenCode event")
      expect(output.match(/piEvent=turn_start/g)).toHaveLength(1)
      expect(output).toContain("piRole=user")
    } finally {
      unsubscribe()
      await runtime.stop()
    }
  })

  test("extension UI responses are fire-and-forget notifications", async () => {
    transport = new PiRpcTransport({
      cliPath: `"${process.execPath}" "${fakePi}"`,
      args: ["--mode", "rpc"],
      rpcTimeoutMs: 50,
      startTimeoutMs: 2000,
      logger: silentLogger,
    })
    await transport.start()

    await expect(
      transport.notify({ type: "extension_ui_response", id: "ui-request-1", confirmed: true }),
    ).resolves.toBeUndefined()
  })

  test("reconciles final-only Pi output and recovers a missing agent_settled", async () => {
    const runtime = new PiRpcRuntime(
      {
        sessionId: "runtime-terminal-fallback",
        directory: process.cwd(),
        logger: silentLogger,
        config: {},
        skills: emptySkills(process.cwd()),
      },
      {
        cliPath: `"${process.execPath}" "${fakePi}"`,
        args: ["--mode", "rpc"],
        sessionDir: "/tmp",
        rpcTimeoutMs: 2000,
        startTimeoutMs: 2000,
      },
    )
    const events: Array<{ type: string; text?: string }> = []
    const unsubscribe = runtime.subscribe((event) => events.push(event))

    try {
      await runtime.start()
      await runtime.prompt({
        sessionId: "runtime-terminal-fallback",
        messageId: "msg_user",
        assistantMessageId: "msg_assistant",
        text: "think __final_only__ __omit_agent_settled__",
      })

      expect(events.find((event) => event.type === "reasoning_snapshot")?.text).toContain("analyze")
      expect(events.find((event) => event.type === "text_snapshot")?.text).toContain("fake Pi response")
      expect(events.some((event) => event.type === "message_completed")).toBe(true)
      expect(events.at(-1)?.type).toBe("session_idle")
    } finally {
      unsubscribe()
      await runtime.stop()
    }
  }, 5000)

  test("agent_settled completes a message even when agent_end is absent", async () => {
    const runtime = new PiRpcRuntime(
      {
        sessionId: "runtime-missing-agent-end",
        directory: process.cwd(),
        logger: silentLogger,
        config: {},
        skills: emptySkills(process.cwd()),
      },
      {
        cliPath: `"${process.execPath}" "${fakePi}"`,
        args: ["--mode", "rpc"],
        sessionDir: "/tmp",
        rpcTimeoutMs: 2000,
        startTimeoutMs: 2000,
      },
    )
    const types: string[] = []
    const unsubscribe = runtime.subscribe((event) => types.push(event.type))

    try {
      await runtime.start()
      await runtime.prompt({
        sessionId: "runtime-missing-agent-end",
        messageId: "msg_user",
        assistantMessageId: "msg_assistant",
        text: "__final_only__ __omit_agent_end__",
      })

      expect(types.slice(-2)).toEqual(["message_completed", "session_idle"])
    } finally {
      unsubscribe()
      await runtime.stop()
    }
  })

  test("completes a prompt that Pi handles without starting an agent run", async () => {
    const runtime = createTestRuntime("runtime-no-agent-run")
    const types: string[] = []
    const unsubscribe = runtime.subscribe((event) => types.push(event.type))

    try {
      await runtime.start()
      await runtime.prompt({
        sessionId: "runtime-no-agent-run",
        messageId: "msg_user",
        assistantMessageId: "msg_assistant",
        text: "__no_agent_run__",
      })

      expect(types.slice(-2)).toEqual(["message_completed", "session_idle"])
    } finally {
      unsubscribe()
      await runtime.stop()
    }
  })

  test("publishes extension errors as non-fatal diagnostics and remains reusable", async () => {
    const runtime = createTestRuntime("runtime-extension-error")
    const events: Array<{ type: string; fatal?: boolean }> = []
    const unsubscribe = runtime.subscribe((event) => events.push(event))

    try {
      await runtime.start()
      await runtime.prompt({
        sessionId: "runtime-extension-error",
        messageId: "msg_user_1",
        assistantMessageId: "msg_assistant_1",
        text: "__extension_error_no_run__",
      })
      await runtime.prompt({
        sessionId: "runtime-extension-error",
        messageId: "msg_user_2",
        assistantMessageId: "msg_assistant_2",
        text: "__final_only__",
      })

      expect(events).toContainEqual(expect.objectContaining({ type: "session_error", fatal: false }))
      expect(events.filter((event) => event.type === "message_completed")).toHaveLength(2)
    } finally {
      unsubscribe()
      await runtime.stop()
    }
  })

  test("keeps checking Pi until a missing agent_settled prompt is actually idle", async () => {
    const runtime = createTestRuntime("runtime-delayed-idle")
    const types: string[] = []
    const unsubscribe = runtime.subscribe((event) => types.push(event.type))

    try {
      await runtime.start()
      await runtime.prompt({
        sessionId: "runtime-delayed-idle",
        messageId: "msg_user",
        assistantMessageId: "msg_assistant",
        text: "__final_only__ __omit_agent_settled__ __delayed_idle_without_settled__",
      })

      expect(types.slice(-2)).toEqual(["message_completed", "session_idle"])
    } finally {
      unsubscribe()
      await runtime.stop()
    }
  }, 5000)

  test("recovers when Pi omits both agent_end and agent_settled", async () => {
    const runtime = createTestRuntime("runtime-no-terminal-events")
    const types: string[] = []
    const unsubscribe = runtime.subscribe((event) => types.push(event.type))

    try {
      await runtime.start()
      await runtime.prompt({
        sessionId: "runtime-no-terminal-events",
        messageId: "msg_user",
        assistantMessageId: "msg_assistant",
        text: "__final_only__ __omit_agent_end__ __omit_agent_settled__",
      })

      expect(types.slice(-2)).toEqual(["message_completed", "session_idle"])
    } finally {
      unsubscribe()
      await runtime.stop()
    }
  }, 5000)

  test("rejects an active prompt and emits runtime_fault when the Pi process exits", async () => {
    const runtime = createTestRuntime("runtime-process-exit")
    const events: AgentRuntimeEvent[] = []
    const unsubscribe = runtime.subscribe((event) => events.push(event))

    try {
      await runtime.start()
      await expect(
        runtime.prompt({
          sessionId: "runtime-process-exit",
          messageId: "msg_user",
          assistantMessageId: "msg_assistant",
          text: "__exit_during_prompt__",
        }),
      ).rejects.toThrow("Pi subprocess exited with code 23")

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "runtime_fault",
          error: expect.objectContaining({ type: "transport_exit" }),
        }),
      )
    } finally {
      unsubscribe()
      await runtime.stop()
    }
  })

  test("reopens the persisted forked Pi session after a runtime restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-fork-restart-"))
    const logger = new Logger({ minLevel: "ERROR" })
    const db = new DatabaseService(join(directory, "adaptor.db"), logger)
    const sessions = new SessionRepository(db)
    const messages = new MessageRepository(db)
    const conversationStore = new PiConversationStore(db)
    const session = sessions.create({ directory, agent: "pi" })
    let firstRuntime: PiRpcRuntime | undefined
    let restartedRuntime: PiRpcRuntime | undefined

    const createRuntime = () =>
      new PiRpcRuntime(
        {
          sessionId: session.id,
          directory,
          logger: silentLogger,
          config: {},
          skills: emptySkills(directory),
        },
        {
          cliPath: `"${process.execPath}" "${fakePi}"`,
          sessionDir: join(directory, "pi-sessions"),
          rpcTimeoutMs: 2000,
          startTimeoutMs: 2000,
          conversationStore,
        },
      )

    try {
      firstRuntime = createRuntime()
      await firstRuntime.start()
      const firstUser = messages.createUserMessage(session.id, "pi")
      const firstAssistant = messages.createAssistantMessage(session.id, firstUser.id, "pi")
      await firstRuntime.prompt({
        sessionId: session.id,
        messageId: firstUser.id,
        assistantMessageId: firstAssistant.id,
        text: "restart-first-context",
      })
      const secondUser = messages.createUserMessage(session.id, "pi")
      const secondAssistant = messages.createAssistantMessage(session.id, secondUser.id, "pi")
      await firstRuntime.prompt({
        sessionId: session.id,
        messageId: secondUser.id,
        assistantMessageId: secondAssistant.id,
        text: "restart-second-context",
      })
      expect(conversationStore.getMessageEntryId(firstUser.id)).toBeString()
      expect(conversationStore.getMessageEntryId(secondUser.id)).toBeString()
      expect(conversationStore.getMessageEntryId(secondUser.id)).not.toBe(
        conversationStore.getMessageEntryId(firstUser.id),
      )
      const result = await firstRuntime.fork({ messageId: secondUser.id })
      const forkedSessionFile = conversationStore.getSession(session.id).activeSessionFile
      expect(result.backendSessionId).toBeString()
      expect(forkedSessionFile).toBeString()
      await firstRuntime.stop()
      firstRuntime = undefined

      restartedRuntime = createRuntime()
      const textSnapshots: string[] = []
      restartedRuntime.subscribe((event) => {
        if (event.type === "text_snapshot") textSnapshots.push(event.text)
      })
      await restartedRuntime.start()
      expect(conversationStore.getSession(session.id)).toMatchObject({
        activeSessionId: result.backendSessionId,
        activeSessionFile: forkedSessionFile,
      })

      const replacementUser = messages.createUserMessage(session.id, "pi")
      const replacementAssistant = messages.createAssistantMessage(session.id, replacementUser.id, "pi")
      await restartedRuntime.prompt({
        sessionId: session.id,
        messageId: replacementUser.id,
        assistantMessageId: replacementAssistant.id,
        text: "__recall_previous_prompt__",
      })
      expect(textSnapshots.join("\n")).toContain('Restored previous prompt: "restart-first-context"')
    } finally {
      await firstRuntime?.stop()
      await restartedRuntime?.stop()
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 10000)
})
