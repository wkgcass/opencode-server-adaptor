import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentAdapter } from "../../src/agents/agent-adapter.ts"
import { AgentAdapterRegistry } from "../../src/agents/registry.ts"
import type {
  SubagentResult,
  SubagentRunCallbacks,
  SubagentRunInput,
  SubagentRunner,
} from "../../src/agents/subagent-adapter.ts"
import { SubtaskManager } from "../../src/agents/subtask-manager.ts"
import { loadConfig } from "../../src/config/index.ts"
import { DatabaseService } from "../../src/db/index.ts"
import { EventBus } from "../../src/event/index.ts"
import { createPartId } from "../../src/id/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { MessageRepository } from "../../src/message/index.ts"
import { SessionRepository } from "../../src/session/index.ts"

describe("agent backend abstractions", () => {
  const cleanup: string[] = []

  afterEach(() => {
    for (const directory of cleanup.splice(0)) {
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch {}
    }
  })

  test("SubtaskManager delegates through a parent adapter's native SubagentRunner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "native-subagent-"))
    cleanup.push(directory)
    const logger = new Logger({ minLevel: "ERROR" })
    const db = new DatabaseService(join(directory, "test.db"), logger)
    const sessions = new SessionRepository(db, "1.18.7")
    const messages = new MessageRepository(db, sessions)
    const events = new EventBus(logger)
    const nativeRunner = new FakeNativeSubagentRunner()
    const registry = new AgentAdapterRegistry()
    registry.register(new FakeNativeAgentAdapter(nativeRunner))
    const config = {
      ...loadConfig(),
      maxSubtaskDepth: 3,
      maxGlobalConcurrentSubtasks: 4,
      maxConcurrentSubtasksPerParent: 2,
      subtaskTimeoutMs: 5_000,
    }
    const manager = new SubtaskManager(registry, sessions, messages, events, logger, config)

    const parent = sessions.create({ directory, agent: "native-test" })
    sessions.enableWideIds(parent.id)
    const user = messages.createUserMessage(parent.id, parent.agent)
    const assistant = messages.createAssistantMessage(parent.id, user.id, parent.agent)
    const tool = messages.createPart(parent.id, assistant.id, "tool", {
      callID: "call_native",
      tool: "task",
      state: { status: "running", input: {}, time: { start: Date.now() } },
    })

    const handle = manager.start({
      parentSessionId: parent.id,
      parentToolPartId: tool.id,
      parentAssistantMessageId: assistant.id,
      prompt: "Inspect the project",
      description: "Native delegation",
      agent: "explore",
    })
    const result = await handle.result

    expect(result.status).toBe("completed")
    expect(nativeRunner.lastInput).toMatchObject({
      parentSessionId: parent.id,
      childSessionId: handle.childSessionId,
      agent: "explore",
      task: "Inspect the project",
    })
    const childAssistant = messages
      .listMessages(handle.childSessionId)
      .find((message) => message.info.role === "assistant")
    expect(sessions.getIdFormat(handle.childSessionId)).toBe("wide")
    expect(
      messages
        .listMessages(handle.childSessionId)
        .every(
          (message) =>
            message.info.id.startsWith("msg-") && message.parts.every((part) => part.id.startsWith("prt-")),
        ),
    ).toBe(true)
    expect(childAssistant?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "native child result" })]),
    )

    await manager.closeAll()
    db.close()
  })
})

class FakeNativeSubagentRunner implements SubagentRunner {
  readonly mode = "native" as const
  lastInput: SubagentRunInput | undefined

  listProfiles() {
    return [{ name: "explore", description: "Native explorer" }]
  }

  async run(input: SubagentRunInput, callbacks?: SubagentRunCallbacks): Promise<SubagentResult> {
    this.lastInput = input
    const partId = createPartId()
    callbacks?.onUpdate?.({
      type: "event",
      event: {
        type: "text_started",
        sessionId: input.childSessionId,
        messageId: input.childAssistantMessageId,
        partId,
      },
    })
    callbacks?.onUpdate?.({
      type: "event",
      event: {
        type: "text_ended",
        sessionId: input.childSessionId,
        messageId: input.childAssistantMessageId,
        partId,
        text: "native child result",
      },
    })
    return {
      agent: input.agent,
      task: input.task,
      status: "completed",
      output: "native child result",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 3, turns: 1 },
    }
  }
}

class FakeNativeAgentAdapter implements AgentAdapter {
  readonly id = "native-test"
  readonly displayName = "Native Test Agent"
  readonly subagents: SubagentRunner

  constructor(subagents: SubagentRunner) {
    this.subagents = subagents
  }

  async validateConfig(input: unknown) {
    return (input ?? {}) as Record<string, unknown>
  }

  async createRuntime(): Promise<never> {
    throw new Error("Runtime is not used by this test")
  }
}
