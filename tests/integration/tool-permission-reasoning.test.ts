import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"
import { reserveFreePort } from "../helpers/free-port.ts"
import { createV2TestFetch } from "../helpers/v2-test-fetch.ts"
import { waitFor, waitForSessionIdle } from "../helpers/wait-for.ts"

const fetch = createV2TestFetch()

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")
const FAKE_PI_PATH = join(import.meta.dir, "..", "fixtures", "fake-pi", "fake-pi.ts")
const BUN_BIN = join(homedir(), ".bun", "bin", "bun")

describe("Tool Call + Permission + Reasoning (Fake Pi)", () => {
  let port: number
  let password: string
  let proc: ReturnType<typeof spawn>
  let baseUrl: string
  let authHeader: string

  beforeAll(async () => {
    port = reserveFreePort()
    password = randomUUID()

    proc = spawn({
      cmd: [
        BUN_BIN,
        "run",
        CLI_PATH,
        "--log-level",
        "ERROR",
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: "opencode",
        DEFAULT_AGENT: "pi",
        DATABASE_PATH: ":memory:",
        PI_CLI_PATH: `${BUN_BIN} ${FAKE_PI_PATH}`,
        MAX_ACTIVE_AGENT_PROCESSES: "10",
      },
    })

    baseUrl = `http://127.0.0.1:${port}`
    authHeader = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")

    for (let i = 0; i < 100; i++) {
      await Bun.sleep(300)
      try {
        const res = await fetch(`${baseUrl}/api/health`, { headers: { Authorization: authHeader } })
        if (res.ok) return
      } catch {
        // retry
      }
    }
    throw new Error("Server did not become healthy")
  }, 30000)

  afterAll(async () => {
    proc.kill("SIGTERM")
    await proc.exited
  })

  test.concurrent(
    "tool call lifecycle: bash tool is persisted as ToolPart",
    async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Tool Test", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "run a bash command to list files" }] }),
      })

      await waitForSessionIdle(baseUrl, authHeader, session.id)

      const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      const messages = (await msgRes.json()) as Array<{
        info: { role: string }
        parts: Array<{ type: string; tool?: string; state?: { status: string; output?: string } }>
      }>

      const assistant = messages.find((m) => m.info.role === "assistant")
      expect(assistant).toBeDefined()

      const toolParts = assistant!.parts.filter((p) => p.type === "tool")
      expect(toolParts.length).toBeGreaterThanOrEqual(1)

      const bashTool = toolParts.find((p) => p.tool === "bash")
      expect(bashTool).toBeDefined()
      expect(bashTool!.state!.status).toBe("completed")
      expect(bashTool!.state!.output).toBeDefined()
    },
    15000,
  )

  test.concurrent(
    "reasoning streaming: reasoning part is persisted",
    async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Reasoning Test", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "think about this reasoning problem" }] }),
      })

      await waitForSessionIdle(baseUrl, authHeader, session.id)

      const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      let messages = (await msgRes.json()) as Array<{
        info: { id: string; role: string }
        parts: Array<{ id: string; type: string; text?: string; time?: { start: number; end?: number } }>
      }>

      const assistantMessages = messages.filter((message) => message.info.role === "assistant")
      expect(assistantMessages.length).toBeGreaterThanOrEqual(2)

      const reasoningParts = assistantMessages.flatMap((message) => message.parts).filter((p) => p.type === "reasoning")
      expect(reasoningParts.length).toBeGreaterThanOrEqual(1)
      expect(reasoningParts[0]!.text).toContain("analyze")
      expect(reasoningParts[0]!.time?.start).toBeNumber()
      expect(reasoningParts[0]!.time?.end).toBeNumber()

      expect(
        assistantMessages.findIndex((message) => message.parts.some((part) => part.type === "reasoning")),
      ).toBeLessThan(assistantMessages.findIndex((message) => message.parts.some((part) => part.type === "text")))

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "think about this follow-up reasoning problem" }] }),
      })
      await waitForSessionIdle(baseUrl, authHeader, session.id)

      const continuedRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      messages = (await continuedRes.json()) as typeof messages
      expect(messages.map((message) => message.info.id)).toEqual([...messages].map((message) => message.info.id).sort())
      const assistants = messages.filter((message) => message.info.role === "assistant")
      expect(assistants).toHaveLength(4)
      expect(assistants.map((message) => [...new Set(message.parts.map((part) => part.type))])).toEqual([
        ["reasoning"],
        ["text"],
        ["reasoning"],
        ["text"],
      ])
      for (const continuedAssistant of assistants) {
        for (const reasoning of continuedAssistant.parts.filter((part) => part.type === "reasoning")) {
          expect(reasoning.time?.start).toBeNumber()
          expect(reasoning.time?.end).toBeNumber()
        }
      }
    },
    15000,
  )

  test.serial(
    "unsupported extension UI requests are cancelled without creating permission state",
    async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Unsupported Extension UI Test", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "__extension_ui_request__" }] }),
      })

      await waitForSessionIdle(baseUrl, authHeader, session.id)

      const permissionRes = await fetch(`${baseUrl}/api/session/${session.id}/permission`, {
        headers: { Authorization: authHeader },
      })
      expect(permissionRes.ok).toBe(true)
      expect(await permissionRes.json()).toEqual({ data: [] })

      const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      const messages = (await msgRes.json()) as Array<{
        info: { role: string }
        parts: Array<{ type: string; tool?: string; state?: { status: string; error?: string } }>
      }>

      const errorTool = messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.state?.status === "error")
      expect(errorTool?.state?.error).toBeDefined()
    },
    20000,
  )

  test.concurrent(
    "tool part has stable ID across multiple fetches",
    async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Stable ID Test", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "run a bash tool" }] }),
      })

      await waitForSessionIdle(baseUrl, authHeader, session.id)

      const msgRes1 = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      const messages1 = (await msgRes1.json()) as Array<{
        info: { id: string; role: string }
        parts: Array<{ id: string; type: string }>
      }>

      const msgRes2 = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      const messages2 = (await msgRes2.json()) as Array<{
        info: { id: string; role: string }
        parts: Array<{ id: string; type: string }>
      }>

      expect(messages1.length).toBe(messages2.length)
      const assistant1 = messages1.find((m) => m.info.role === "assistant")
      const assistant2 = messages2.find((m) => m.info.role === "assistant")
      expect(assistant1!.parts.map((p) => p.id)).toEqual(assistant2!.parts.map((p) => p.id))
    },
    15000,
  )

  test.concurrent(
    "multiple tool calls in one session",
    async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Multi Tool Test", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      // First prompt with tool
      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "run a bash tool" }] }),
      })

      await waitForSessionIdle(baseUrl, authHeader, session.id)

      // Second prompt with tool
      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "run another bash tool" }] }),
      })

      await waitForSessionIdle(baseUrl, authHeader, session.id)

      const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      const messages = (await msgRes.json()) as Array<{
        info: { role: string }
        parts: Array<{ type: string; tool?: string; state?: { status: string } }>
      }>

      // Should have at least 2 assistant messages
      const assistantMessages = messages.filter((m) => m.info.role === "assistant")
      expect(assistantMessages.length).toBeGreaterThanOrEqual(2)

      const toolMessages = assistantMessages.filter((message) => message.parts.some((part) => part.type === "tool"))
      expect(toolMessages.length).toBeGreaterThanOrEqual(2)

      // Each tool response group should have at least one tool part
      for (const msg of toolMessages) {
        const toolParts = msg.parts.filter((p) => p.type === "tool")
        expect(toolParts.length).toBeGreaterThanOrEqual(1)
      }
    },
    20000,
  )
})
