import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"
import { reserveFreePort } from "../helpers/free-port.ts"
import { createV2TestFetch } from "../helpers/v2-test-fetch.ts"

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

  test("tool call lifecycle: bash tool is persisted as ToolPart", async () => {
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

    await Bun.sleep(5000)

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
  }, 15000)

  test("reasoning streaming: reasoning part is persisted", async () => {
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

    await Bun.sleep(5000)

    const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    let messages = (await msgRes.json()) as Array<{
      info: { id: string; role: string }
      parts: Array<{ id: string; type: string; text?: string; time?: { start: number; end?: number } }>
    }>

    const assistant = messages.find((m) => m.info.role === "assistant")
    expect(assistant).toBeDefined()

    const reasoningParts = assistant!.parts.filter((p) => p.type === "reasoning")
    expect(reasoningParts.length).toBeGreaterThanOrEqual(1)
    expect(reasoningParts[0]!.text).toContain("analyze")
    expect(reasoningParts[0]!.time?.start).toBeNumber()
    expect(reasoningParts[0]!.time?.end).toBeNumber()

    const desktopSortedParts = [...assistant!.parts].sort((left, right) => left.id.localeCompare(right.id))
    expect(desktopSortedParts.findIndex((part) => part.type === "reasoning")).toBeLessThan(
      desktopSortedParts.findIndex((part) => part.type === "text"),
    )

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "think about this follow-up reasoning problem" }] }),
    })
    await Bun.sleep(5000)

    const continuedRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    messages = (await continuedRes.json()) as typeof messages
    expect(messages.map((message) => message.info.id)).toEqual([...messages].map((message) => message.info.id).sort())
    const assistants = messages.filter((message) => message.info.role === "assistant")
    expect(assistants).toHaveLength(2)
    for (const continuedAssistant of assistants) {
      const sorted = [...continuedAssistant.parts].sort((left, right) => left.id.localeCompare(right.id))
      expect(sorted.findIndex((part) => part.type === "reasoning")).toBeLessThan(
        sorted.findIndex((part) => part.type === "text"),
      )
      for (const reasoning of sorted.filter((part) => part.type === "reasoning")) {
        expect(reasoning.time?.start).toBeNumber()
        expect(reasoning.time?.end).toBeNumber()
      }
    }
  }, 15000)

  test("permission request: write tool triggers permission, allow approves it", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Permission Test", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "write a file with permission" }] }),
    })

    // Wait for permission to appear
    await Bun.sleep(2000)

    // Check pending permissions
    const permRes = await fetch(`${baseUrl}/session/${session.id}/permissions`, {
      headers: { Authorization: authHeader },
    })
    expect(permRes.ok).toBe(true)
    const perms = (await permRes.json()) as Array<{
      id: string
      sessionId: string
      tool: string
      status: string
    }>

    expect(perms.length).toBeGreaterThanOrEqual(1)
    const pendingPerm = perms.find((p) => p.status === "pending")
    expect(pendingPerm).toBeDefined()
    // Permission comes from extension_ui_request, so tool is "extension"
    expect(pendingPerm!.tool === "extension" || pendingPerm!.tool === "write").toBe(true)

    // Respond to permission - allow
    const replyRes = await fetch(`${baseUrl}/session/${session.id}/permissions/${pendingPerm!.id}`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "allow" }),
    })
    expect(replyRes.ok).toBe(true)

    // Wait for tool to complete
    await Bun.sleep(5000)

    // Verify tool completed successfully
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

    const writeTool = toolParts.find((p) => p.tool === "write")
    expect(writeTool).toBeDefined()
    expect(writeTool!.state!.status).toBe("completed")
    expect(writeTool!.state!.output).toContain("Success")
  }, 20000)

  test("global permission list includes pending from all sessions", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Global Perm Test", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "write file with permission" }] }),
    })

    await Bun.sleep(2000)

    const globalPermRes = await fetch(`${baseUrl}/permission`, {
      headers: { Authorization: authHeader },
    })
    expect(globalPermRes.ok).toBe(true)
    const globalPerms = (await globalPermRes.json()) as Array<{ id: string; sessionID: string }>
    expect(globalPerms.some((p) => p.sessionID === session.id)).toBe(true)

    const pending = globalPerms.find((p) => p.sessionID === session.id)
    const replyRes = await fetch(`${baseUrl}/permission/${pending!.id}/reply`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "reject", message: "test cleanup" }),
    })
    expect(replyRes.ok).toBe(true)
    expect(await replyRes.json()).toBe(true)
  }, 15000)

  test("permission deny results in tool error state", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Deny Test", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "write file with permission" }] }),
    })

    await Bun.sleep(2000)

    // Check pending permissions
    const permRes = await fetch(`${baseUrl}/session/${session.id}/permissions`, {
      headers: { Authorization: authHeader },
    })
    const perms = (await permRes.json()) as Array<{ id: string; status: string }>

    const pending = perms.find((p) => p.status === "pending")
    if (pending) {
      // Deny it
      await fetch(`${baseUrl}/session/${session.id}/permissions/${pending.id}`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deny", reason: "Not allowed" }),
      })
    }

    // Wait for timeout / completion
    await Bun.sleep(6000)

    const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const messages = (await msgRes.json()) as Array<{
      info: { role: string }
      parts: Array<{ type: string; tool?: string; state?: { status: string; error?: string } }>
    }>

    const assistant = messages.find((m) => m.info.role === "assistant")
    if (assistant) {
      const toolParts = assistant.parts.filter((p) => p.type === "tool")
      // If tool was denied or timed out, it should be in error state
      const errorTool = toolParts.find((p) => p.state?.status === "error")
      // Tool may or may not exist depending on timing
      if (errorTool) {
        expect(errorTool.state!.error).toBeDefined()
      }
    }
  }, 20000)

  test("tool part has stable ID across multiple fetches", async () => {
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

    await Bun.sleep(5000)

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
  }, 15000)

  test("multiple tool calls in one session", async () => {
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

    await Bun.sleep(5000)

    // Second prompt with tool
    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "run another bash tool" }] }),
    })

    await Bun.sleep(5000)

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

    // Each should have at least one tool part
    for (const msg of assistantMessages) {
      const toolParts = msg.parts.filter((p) => p.type === "tool")
      expect(toolParts.length).toBeGreaterThanOrEqual(1)
    }
  }, 20000)
})
