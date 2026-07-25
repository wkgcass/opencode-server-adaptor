import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { homedir } from "node:os"
import { PiManualSubagentBackend } from "../../src/agents/pi/pi-manual-subagent-backend.ts"
import { PiSubagentRunner } from "../../src/agents/pi/subagent-runner.ts"
import { ManualSubagentRunner } from "../../src/agents/subagents/manual-subagent-runner.ts"

const BUN_BIN = join(homedir(), ".bun", "bin", "bun")
const FAKE_PI_PATH = join(import.meta.dir, "..", "fixtures", "fake-pi", "fake-pi.ts")
const PI_EXECUTABLE = `${BUN_BIN} ${FAKE_PI_PATH}`

describe("PiSubagentRunner", () => {
  test("runs one Pi process and maps its result", async () => {
    const runner = new PiSubagentRunner()
    runner.registerCustomAgent({ name: "pi", description: "Pi Agent" })

    const result = await runner.run({
      agent: "pi",
      task: "hello world",
      cwd: process.cwd(),
      piExecutable: PI_EXECUTABLE,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      status: "completed",
      exitCode: 0,
      stopReason: "end",
      usage: { input: 100, output: 50, cost: 0.001, turns: 1 },
      model: "test-model",
    })
    expect(result.output).toContain("fake Pi response")
  })

  test("reports complete subprocess interactions to the verbose logger", async () => {
    const interactions: Array<{
      direction: "in" | "out"
      metadata: Record<string, unknown>
      payload: unknown
    }> = []
    const runner = new PiSubagentRunner({
      logger: {
        interaction(channel, direction, metadata, payload) {
          expect(channel).toBe("pi")
          interactions.push({ direction, metadata, payload })
        },
      },
    })
    runner.registerCustomAgent({ name: "pi", description: "Pi Agent" })

    const result = await runner.run({
      agent: "pi",
      task: "full child payload",
      cwd: process.cwd(),
      piExecutable: PI_EXECUTABLE,
    })

    expect(result.status).toBe("completed")
    expect(interactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "out",
          metadata: expect.objectContaining({ subprocess: "subagent", stream: "argv", mode: "json" }),
        }),
        expect.objectContaining({
          direction: "in",
          metadata: expect.objectContaining({ subprocess: "subagent", stream: "stdout" }),
          payload: expect.objectContaining({ type: "message_end" }),
        }),
      ]),
    )
  })

  test("preserves tool messages and emits incremental updates", async () => {
    const runner = new PiSubagentRunner()
    runner.registerCustomAgent({ name: "pi", description: "Pi Agent" })
    const updates: string[] = []

    const result = await runner.run(
      {
        agent: "pi",
        task: "run a tool",
        cwd: process.cwd(),
        piExecutable: PI_EXECUTABLE,
      },
      { onUpdate: (update) => void updates.push(update.type) },
    )

    const assistantMessages = result.messages.filter((message: any) => message.role === "assistant")
    expect(
      assistantMessages.some((message: any) => message.content.some((part: any) => part.type === "toolCall")),
    ).toBe(true)
    expect(updates).toContain("status")
    expect(updates).toContain("message")
  })

  test("returns failed for an unknown profile", async () => {
    const result = await new PiSubagentRunner().run({
      agent: "missing",
      task: "test",
      cwd: process.cwd(),
      piExecutable: PI_EXECUTABLE,
      stderrLimitBytes: 10,
    })

    expect(result.status).toBe("failed")
    expect(result.stderr).toContain("Unknown agent")
  })

  test("stops the child process when aborted", async () => {
    const runner = new PiSubagentRunner()
    runner.registerCustomAgent({ name: "pi", description: "Pi Agent" })
    const controller = new AbortController()
    const resultPromise = runner.run({
      agent: "pi",
      task: "abort cancel",
      cwd: process.cwd(),
      piExecutable: PI_EXECUTABLE,
      signal: controller.signal,
    })

    setTimeout(() => controller.abort(), 100)
    expect((await resultPromise).status).toBe("aborted")
  })

  test("passes the adaptor agent directory to child processes", async () => {
    let beforeSpawnCalls = 0
    const runner = new PiSubagentRunner({
      agentDir: "/tmp/adaptor-pi-agent",
      beforeSpawn: () => {
        beforeSpawnCalls++
      },
    })
    runner.registerCustomAgent({ name: "pi", description: "Pi Agent" })

    const result = await runner.run({
      agent: "pi",
      task: "report-agent-dir",
      cwd: process.cwd(),
      piExecutable: PI_EXECUTABLE,
      terminateGracePeriodMs: 2_000,
    })

    expect(result.output).toBe("/tmp/adaptor-pi-agent")
    expect(beforeSpawnCalls).toBe(1)
  })
})

describe("ManualSubagentRunner with Pi backend", () => {
  test("keeps fallback orchestration generic and maps Pi events in the Pi backend", async () => {
    const runner = new ManualSubagentRunner(
      new PiManualSubagentBackend({
        piExecutable: PI_EXECUTABLE,
        agentScope: "both",
        terminateGracePeriodMs: 3_000,
        stderrLimitBytes: 65_536,
      }),
    )
    runner.registerProfile({ name: "custom", description: "Custom fallback profile" })
    const updates: string[] = []

    const result = await runner.run(
      {
        parentSessionId: "parent",
        childSessionId: "child",
        childAssistantMessageId: "assistant",
        agent: "custom",
        task: "hello",
        cwd: process.cwd(),
      },
      {
        onUpdate: (update) => {
          updates.push(update.type === "event" ? update.event.type : update.type)
        },
      },
    )

    expect(result.status).toBe("completed")
    expect(updates).toContain("text_ended")
    expect(updates).toContain("output_delta")
    expect(runner.listProfiles(process.cwd()).map((profile) => profile.name)).toContain("explore")
  })

  test("rejects unknown profiles before invoking a backend", async () => {
    const runner = new ManualSubagentRunner({
      listProfiles: () => [],
      run: async () => {
        throw new Error("must not execute")
      },
    })

    const result = await runner.run({
      parentSessionId: "parent",
      childSessionId: "child",
      childAssistantMessageId: "assistant",
      agent: "missing",
      task: "hello",
      cwd: process.cwd(),
    })

    expect(result).toMatchObject({
      status: "failed",
      error: { message: 'Unknown agent: "missing". Available agents: none.' },
    })
  })
})
