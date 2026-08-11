import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reserveFreePort } from "../helpers/free-port.ts"

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")

describe("OpenCode v2 shell endpoint", () => {
  let processHandle: ReturnType<typeof spawn>
  let baseUrl: string
  let authorization: string
  let sessionID: string
  let configDirectory: string

  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: authorization,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    })

  beforeAll(async () => {
    const port = reserveFreePort()
    const password = randomUUID()
    configDirectory = mkdtempSync(join(tmpdir(), "opencode-v2-shell-"))
    const providerConfigPath = join(configDirectory, "providers.yaml")
    writeFileSync(
      providerConfigPath,
      "provider:\n  v2-shell:\n    name: V2 Shell\n    models:\n      model:\n        name: Model\n",
    )
    baseUrl = `http://127.0.0.1:${port}`
    authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    processHandle = spawn({
      cmd: ["bun", "run", CLI_PATH, "--log-level", "ERROR", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: "opencode",
        DEFAULT_AGENT: "stub",
        DATABASE_PATH: ":memory:",
        PROVIDER_CONFIG_PATH: providerConfigPath,
      },
    })
    for (let attempt = 0; attempt < 50; attempt++) {
      await Bun.sleep(200)
      try {
        if ((await request("/api/health")).ok) return
      } catch {}
    }
    throw new Error("Server did not become healthy")
  }, 30_000)

  afterAll(async () => {
    processHandle.kill("SIGTERM")
    await processHandle.exited
    rmSync(configDirectory, { recursive: true, force: true })
  })

  test("creates a session for shell commands", async () => {
    const created = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({
        agent: "stub",
        model: { id: "default", providerID: "pi" },
        location: { directory: process.cwd() },
      }),
    })
    expect(created.ok).toBe(true)
    sessionID = ((await created.json()) as { data: { id: string } }).data.id
  })

  test("POST /api/session/:id/shell returns 204 and streams a bash tool part", async () => {
    // Subscribe to the global event stream so the adaptor buffers events and so
    // we can assert the Desktop-facing message events are published.
    const eventStream = await request("/api/event")
    expect(eventStream.ok).toBe(true)
    const reader = eventStream.body!.getReader()
    const decoder = new TextDecoder()
    const received: Array<{ type: string; data: Record<string, unknown>; durable?: { version: number } }> = []
    const collect = (async () => {
      let buffer = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split("\n\n")
        buffer = frames.pop() ?? ""
        for (const frame of frames) {
          const dataLine = frame
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6)
          if (!dataLine) continue
          try {
            const event = JSON.parse(dataLine) as {
              type: string
              data: Record<string, unknown>
              durable?: { version: number }
            }
            if (event.type !== "server.heartbeat" && event.type !== "server.connected") received.push(event)
          } catch {}
        }
      }
    })()

    const shellResponse = await request(`/api/session/${sessionID}/shell`, {
      method: "POST",
      body: JSON.stringify({ id: `evt_${Date.now().toString(36)}shell`, command: "echo shell-test-output && pwd" }),
    })
    expect(shellResponse.status).toBe(204)
    expect(await shellResponse.text()).toBe("")

    // Poll the message history until the assistant shell tool part is completed.
    let assistant: { content?: Array<{ type: string; state?: { status: string; output?: string } }> } | undefined
    for (let attempt = 0; attempt < 50; attempt++) {
      await Bun.sleep(100)
      const messagesResponse = await request(`/api/session/${sessionID}/message?limit=20&order=asc`)
      const messages = (await messagesResponse.json()) as {
        data: Array<{
          id: string
          type: string
          text?: string
          content?: Array<{ type: string; state?: { status: string; output?: string } }>
        }>
      }
      assistant = messages.data.find((message) => message.type === "assistant")
      const bashPart = assistant?.content?.find((part) => part.type === "tool")
      if (bashPart?.state?.status === "completed") break
    }

    const bashPart = assistant?.content?.find((part) => part.type === "tool") as
      | { state?: { status?: string; result?: string; content?: Array<{ type: string; text?: string }> } }
      | undefined
    expect(bashPart).toBeDefined()
    expect(bashPart!.state!.status).toBe("completed")
    // The v2 REST conversion exposes tool output via state.result / state.content.
    const outputText = bashPart!.state!.result ?? bashPart!.state!.content?.find((c) => c.type === "text")?.text ?? ""
    expect(outputText).toContain("shell-test-output")

    // Give the event stream a moment to flush the message events, then stop.
    await Bun.sleep(150)
    reader.cancel()
    await collect.catch(() => {})

    const types = received.map((event) => event.type)
    expect(types).toEqual(
      expect.arrayContaining([
        "session.input.admitted",
        "session.input.promoted",
        "session.execution.started",
        "session.step.started",
        "session.tool.input.started",
        "session.tool.called",
        "session.tool.success",
        "session.step.ended",
        "session.execution.succeeded",
      ]),
    )
    const success = received.find((event) => event.type === "session.tool.success")
    expect(success?.durable?.version).toBe(2)
    expect(success?.data).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("shell-test-output") }],
    })
    const admitted = received.find((event) => event.type === "session.input.admitted")
    expect(admitted?.data).toMatchObject({
      input: { type: "user", data: { text: "The following tool was executed by the user" } },
    })
    expect(types.some((type) => type === "message.updated" || type.startsWith("message.part."))).toBe(false)
  })

  test("shell rejects empty commands with 400", async () => {
    const response = await request(`/api/session/${sessionID}/shell`, {
      method: "POST",
      body: JSON.stringify({ command: "   " }),
    })
    expect(response.status).toBe(400)
  })

  test("shell on a missing session returns 404", async () => {
    const response = await request(`/api/session/ses_missing/shell`, {
      method: "POST",
      body: JSON.stringify({ command: "echo hi" }),
    })
    expect(response.status).toBe(404)
  })
})
