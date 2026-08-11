import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "bun"
import { homedir } from "node:os"
import { join } from "node:path"
import { reserveFreePort } from "../helpers/free-port.ts"

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")
const FAKE_PI_PATH = join(import.meta.dir, "..", "fixtures", "fake-pi", "fake-pi.ts")
const BUN_BIN = join(homedir(), ".bun", "bin", "bun")

describe("OpenCode v2 subagent event ordering", () => {
  let processHandle: ReturnType<typeof spawn>
  let baseUrl: string

  beforeAll(async () => {
    const port = reserveFreePort()
    baseUrl = `http://127.0.0.1:${port}`
    processHandle = spawn({
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
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_SERVER_USERNAME: "",
        DEFAULT_AGENT: "pi",
        DATABASE_PATH: ":memory:",
        PI_CLI_PATH: `${BUN_BIN} ${FAKE_PI_PATH}`,
      },
    })
    for (let attempt = 0; attempt < 100; attempt++) {
      await Bun.sleep(100)
      try {
        if ((await fetch(`${baseUrl}/api/health`)).ok) return
      } catch {}
    }
    throw new Error("v2 fake Pi server did not become healthy")
  }, 30_000)

  afterAll(async () => {
    processHandle.kill("SIGTERM")
    await processHandle.exited
  })

  test("default child messages retain generated part order without duplicating terminal output", async () => {
    const eventController = new AbortController()
    const eventResponse = await fetch(`${baseUrl}/api/event`, { signal: eventController.signal })
    const reader = eventResponse.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const queuedEvents: Array<{ type: string; data: Record<string, any> }> = []
    const nextEvent = async () => {
      while (true) {
        const queued = queuedEvents.shift()
        if (queued) return queued
        const records = buffer.split(/\r?\n\r?\n/)
        buffer = records.pop() ?? ""
        for (const record of records) {
          const data = record.split(/\r?\n/).find((line) => line.startsWith("data: "))
          if (data) queuedEvents.push(JSON.parse(data.slice(6)) as { type: string; data: Record<string, any> })
        }
        const parsed = queuedEvents.shift()
        if (parsed) return parsed
        const next = await reader.read()
        if (next.done) throw new Error("v2 event stream ended")
        buffer += decoder.decode(next.value, { stream: true })
      }
    }
    expect((await nextEvent()).type).toBe("server.connected")

    const created = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: "pi",
        model: { id: "default", providerID: "pi" },
        location: { directory: process.cwd() },
      }),
    })
    const parentID = ((await created.json()) as { data: { id: string } }).data.id
    const prompted = await fetch(`${baseUrl}/api/session/${parentID}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "delegate this __model_subtask__" }),
    })
    expect(prompted.ok).toBe(true)

    let childID: string | undefined
    let childAssistantID: string | undefined
    const firstPartTypes: string[] = []
    const seenPartIDs = new Set<string>()
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const event = await nextEvent()
      if (event.type === "session.created" && event.data.info?.parentID === parentID) {
        childID = event.data.info.id
      }
      if (childID && event.data.sessionID === childID) {
        if (event.type === "message.updated" && event.data.info?.role === "assistant") {
          childAssistantID = event.data.info.id
        }
        const part = event.data.part
        if (
          event.type === "message.part.updated" &&
          part?.messageID === childAssistantID &&
          !seenPartIDs.has(part.id)
        ) {
          seenPartIDs.add(part.id)
          firstPartTypes.push(part.type)
        }
      }
      if (
        event.type === "message.updated" &&
        event.data.info?.sessionID === parentID &&
        event.data.info?.role === "assistant" &&
        event.data.info?.time?.completed !== undefined
      ) {
        break
      }
    }
    expect(childID).toBeString()

    const reasoning = firstPartTypes.indexOf("reasoning")
    const tool = firstPartTypes.indexOf("tool")
    const text = firstPartTypes.indexOf("text")
    expect(reasoning).toBeGreaterThanOrEqual(0)
    expect(tool).toBeGreaterThan(reasoning)
    expect(text).toBeGreaterThan(tool)
    const waited = await fetch(`${baseUrl}/api/session/${parentID}/wait`, { method: "POST" })
    expect(waited.status).toBe(204)
    const context = (await (await fetch(`${baseUrl}/api/session/${childID}/context`)).json()) as {
      data: Array<{
        id: string
        type: string
        finish?: string
        content?: Array<{ id?: string; type: string; text?: string }>
      }>
    }
    const assistants = context.data.filter((message) => message.type === "assistant")
    const contents = assistants.flatMap((message) => message.content ?? [])
    const projectedTypes = assistants.map((message) => [...new Set((message.content ?? []).map((part) => part.type))])
    expect(projectedTypes.every((types) => types.length <= 1)).toBe(true)
    expect(projectedTypes.map((types) => types[0])).toEqual(["reasoning", "tool", "text"])
    expect(contents.map((content) => content.type)).toEqual(["reasoning", "tool", "text"])
    expect(contents.filter((content) => content.type === "text")).toHaveLength(1)
    expect(assistants.filter((message) => message.finish !== undefined)).toHaveLength(1)
    expect(firstPartTypes.filter((type) => type === "reasoning")).toHaveLength(1)
    expect(firstPartTypes.filter((type) => type === "tool")).toHaveLength(1)
    expect(firstPartTypes.filter((type) => type === "text")).toHaveLength(1)

    eventController.abort()
    await reader.cancel().catch(() => {})
  }, 20_000)
})
