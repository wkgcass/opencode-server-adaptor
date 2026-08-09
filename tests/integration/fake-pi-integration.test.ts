import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"
import { reserveFreePort } from "../helpers/free-port.ts"
import { createV2TestFetch } from "../helpers/v2-test-fetch.ts"
import { createMessageId } from "../../src/id/index.ts"

const fetch = createV2TestFetch()

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")
const FAKE_PI_PATH = join(import.meta.dir, "..", "fixtures", "fake-pi", "fake-pi.ts")
const BUN_BIN = join(homedir(), ".bun", "bin", "bun")

async function waitForSseEvent(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  predicate: (event: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  const decoder = new TextDecoder()
  let buffer = ""
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const result = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => {
        throw new Error(`Timed out waiting for SSE event after ${timeoutMs}ms`)
      }),
    ])
    if (result.done) throw new Error("SSE stream ended")
    buffer += decoder.decode(result.value, { stream: true })
    const records = buffer.split(/\r?\n\r?\n/)
    buffer = records.pop() ?? ""
    for (const record of records) {
      const data = record
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n")
      if (!data) continue
      const event = JSON.parse(data)
      if (predicate(event)) return event
    }
  }
  throw new Error(`Timed out waiting for SSE event after ${timeoutMs}ms`)
}

async function waitForSessionIdle(baseUrl: string, authHeader: string, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${baseUrl}/session/${sessionId}`, {
      headers: { Authorization: authHeader },
    })
    const session = (await response.json()) as { status?: string }
    if (session.status === "idle") return
    await Bun.sleep(50)
  }
  throw new Error(`Session ${sessionId} did not become idle`)
}

describe("Fake Pi Integration", () => {
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
        "bun",
        "run",
        CLI_PATH,
        "--print-logs",
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
        AGENT_IDLE_TIMEOUT_MS: "100",
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

  test("v2 session fork creates an independent Pi branch and leaves the source branch active", async () => {
    const createRes = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: "pi",
        model: { id: "default", providerID: "pi" },
        location: { directory: process.cwd() },
      }),
    })
    expect(createRes.ok).toBe(true)
    const source = (await createRes.json()) as { data: { id: string } }

    const prompt = async (sessionID: string, text: string) => {
      const response = await fetch(`${baseUrl}/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
      expect(response.ok).toBe(true)
      const admission = (await response.json()) as { data: { id: string } }
      const waited = await fetch(`${baseUrl}/api/session/${sessionID}/wait`, {
        method: "POST",
        headers: { Authorization: authHeader },
      })
      expect(waited.status).toBe(204)
      return admission.data.id
    }

    await prompt(source.data.id, "fork-backend-first")
    const boundaryMessageID = await prompt(source.data.id, "fork-backend-second")
    const forkRes = await fetch(`${baseUrl}/api/session/${source.data.id}/fork`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ messageID: boundaryMessageID }),
    })
    expect(forkRes.ok).toBe(true)
    const forked = (await forkRes.json()) as { data: { id: string } }

    await prompt(forked.data.id, "__recall_previous_prompt__")
    await prompt(source.data.id, "__recall_previous_prompt__")
    const [forkedHistory, sourceHistory] = await Promise.all([
      fetch(`${baseUrl}/api/session/${forked.data.id}/message`, { headers: { Authorization: authHeader } }).then(
        (response) => response.json(),
      ),
      fetch(`${baseUrl}/api/session/${source.data.id}/message`, { headers: { Authorization: authHeader } }).then(
        (response) => response.json(),
      ),
    ])
    const assistantText = (value: unknown) =>
      (value as { data: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> }).data
        .filter((message) => message.type === "assistant")
        .flatMap((message) => message.content ?? [])
        .map((part) => part.text ?? "")
        .join("\n")
    expect(assistantText(forkedHistory)).toContain('Restored previous prompt: "fork-backend-first"')
    expect(assistantText(sourceHistory)).toContain('Restored previous prompt: "fork-backend-second"')
  }, 15_000)

  test("create session and send prompt to Fake Pi", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fake Pi Test", agent: "pi" }),
    })
    expect(createRes.ok).toBe(true)
    const session = (await createRes.json()) as { id: string }

    const promptRes = await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "Hello Fake Pi" }] }),
    })
    expect(promptRes.ok).toBe(true)

    await Bun.sleep(3000)

    const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const messages = (await msgRes.json()) as Array<{
      info: { role: string; id: string }
      parts: Array<{ type: string; text?: string }>
    }>

    expect(messages.length).toBeGreaterThanOrEqual(2)

    const assistant = messages.find((m) => m.info.role === "assistant")
    expect(assistant).toBeDefined()

    const textParts = assistant!.parts.filter((p) => p.type === "text")
    expect(textParts.length).toBeGreaterThan(0)
    expect(textParts[0]!.text).toContain("fake Pi response")
  }, 15000)

  test("a msg_- client message switches the session to persistent wide IDs", async () => {
    const headers = { Authorization: authHeader, "Content-Type": "application/json" }
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Wide ID Test", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }
    const messageID = createMessageId(undefined, "wide")

    for (const body of [
      { messageID, parts: [{ type: "text", text: "enable wide IDs" }] },
      { parts: [{ type: "text", text: "keep wide IDs" }] },
    ]) {
      const response = await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(204)
      await waitForSessionIdle(baseUrl, authHeader, session.id)
    }

    const historyRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const history = (await historyRes.json()) as Array<{
      info: { id: string; role: string }
      parts: Array<{ id: string }>
    }>
    expect(history).toHaveLength(4)
    expect(history.every((message) => message.info.id.startsWith("msg_-"))).toBe(true)
    expect(
      history
        .filter((message) => message.info.role === "assistant")
        .flatMap((message) => message.parts)
        .filter((part) => !part.id.startsWith("prt_-")),
    ).toEqual([])
  }, 15000)

  test("session returns to idle after Fake Pi completes", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Idle Test", agent: "pi" }),
    })

    const session = (await createRes.json()) as { id: string }

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "test" }] }),
    })

    await Bun.sleep(3000)

    const getRes = await fetch(`${baseUrl}/session/${session.id}`, {
      headers: { Authorization: authHeader },
    })
    const updated = (await getRes.json()) as { status: string }
    expect(updated.status).toBe("idle")
  }, 15000)

  test("persists and streams prompts after the session Runtime was idle-recycled", async () => {
    const headers = { Authorization: authHeader, "Content-Type": "application/json" }
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Runtime recycle", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    for (const text of ["before-idle-recycle", "after-idle-recycle"]) {
      const response = await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers,
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      })
      expect(response.status).toBe(204)
      await waitForSessionIdle(baseUrl, authHeader, session.id)
      await Bun.sleep(250)
    }

    const historyRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const history = (await historyRes.json()) as Array<{
      info: { role: string; time?: { completed?: number } }
      parts: Array<{ type: string; text?: string }>
    }>
    const assistants = history.filter((message) => message.info.role === "assistant")

    expect(assistants).toHaveLength(2)
    expect(assistants.every((message) => message.parts.some((part) => part.type === "text"))).toBe(true)
    expect(assistants.every((message) => message.info.time?.completed !== undefined)).toBe(true)
  }, 15000)

  test("recreates a failed Runtime without restarting the adaptor", async () => {
    const headers = { Authorization: authHeader, "Content-Type": "application/json" }
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Runtime fault recovery", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    for (const text of ["baseline", "__exit_during_prompt__", "recovered-after-process-exit"]) {
      const response = await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers,
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      })
      expect(response.status).toBe(204)
      await waitForSessionIdle(baseUrl, authHeader, session.id)
    }

    const historyRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const history = (await historyRes.json()) as Array<{
      info: { role: string; error?: { data?: { message?: string } } }
      parts: Array<{ type: string; text?: string }>
    }>
    const assistants = history.filter((message) => message.info.role === "assistant")

    expect(assistants).toHaveLength(3)
    expect(assistants[1]?.info.error?.data?.message).toContain("Pi subprocess exited with code 23")
    expect(assistants[2]?.parts.some((part) => part.type === "text" && part.text?.includes("fake Pi response"))).toBe(
      true,
    )
  }, 15000)

  test("reverts only Pi conversation context, supports unrevert, and commits on the next prompt", async () => {
    const headers = { Authorization: authHeader, "Content-Type": "application/json" }
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Conversation fork", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    for (const text of ["first-context", "second-context"]) {
      const response = await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers,
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      })
      expect(response.status).toBe(204)
      await waitForSessionIdle(baseUrl, authHeader, session.id)
    }

    const historyRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const history = (await historyRes.json()) as Array<{
      info: { id: string; role: string }
      parts: Array<{ type: string; text?: string }>
    }>
    const users = history.filter((message) => message.info.role === "user")
    expect(users).toHaveLength(2)
    const secondUserId = users[1]!.info.id

    const revertRes = await fetch(`${baseUrl}/session/${session.id}/revert`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messageID: secondUserId }),
    })
    expect(revertRes.ok).toBe(true)
    expect(await revertRes.json()).toMatchObject({ revert: { messageID: secondUserId } })

    const unrevertRes = await fetch(`${baseUrl}/session/${session.id}/unrevert`, {
      method: "POST",
      headers,
    })
    expect(unrevertRes.ok).toBe(true)
    expect((await unrevertRes.json()) as { revert?: unknown }).not.toHaveProperty("revert")

    const secondRevertRes = await fetch(`${baseUrl}/session/${session.id}/revert`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messageID: secondUserId }),
    })
    expect(secondRevertRes.ok).toBe(true)

    const replacementRes = await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers,
      body: JSON.stringify({ parts: [{ type: "text", text: "__recall_previous_prompt__" }] }),
    })
    expect(replacementRes.status).toBe(204)
    await waitForSessionIdle(baseUrl, authHeader, session.id)

    const committedSessionRes = await fetch(`${baseUrl}/session/${session.id}`, {
      headers: { Authorization: authHeader },
    })
    expect((await committedSessionRes.json()) as { revert?: unknown }).not.toHaveProperty("revert")

    const committedHistoryRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const committedHistory = (await committedHistoryRes.json()) as Array<{
      info: { role: string }
      parts: Array<{ type: string; text?: string }>
    }>
    const userTexts = committedHistory
      .filter((message) => message.info.role === "user")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
    expect(userTexts).toEqual(["first-context", "__recall_previous_prompt__"])
    const assistantText = committedHistory
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    expect(assistantText).toContain('Restored previous prompt: "first-context"')
  }, 30000)

  test("client-initiated compaction invokes Pi and publishes the canonical compacted event", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Compact Test", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    const controller = new AbortController()
    const eventRes = await fetch(`${baseUrl}/global/event`, {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    })
    const reader = eventRes.body!.getReader()
    await waitForSseEvent(reader, (event) => event.payload?.type === "server.connected")

    try {
      const compactPromise = fetch(`${baseUrl}/session/${session.id}/summarize`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          providerID: "pi",
          modelID: "default",
          customInstructions: "Focus on changed files",
        }),
      })
      const compacted = await waitForSseEvent(
        reader,
        (event) => event.payload?.type === "session.compacted" && event.payload?.properties?.sessionID === session.id,
      )
      const response = await compactPromise
      expect(response.ok).toBe(true)
      expect(await response.json()).toBe(true)
      expect(compacted.payload.properties.sessionID).toBe(session.id)
    } finally {
      await reader.cancel()
      controller.abort()
    }
  }, 15000)

  test("Pi auto-compaction is surfaced with its automatic reason", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Auto Compact Test", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }
    const controller = new AbortController()
    const eventRes = await fetch(`${baseUrl}/global/event`, {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    })
    const reader = eventRes.body!.getReader()
    await waitForSseEvent(reader, (event) => event.payload?.type === "server.connected")

    try {
      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "__auto_compact__" }] }),
      })
      const event = await waitForSseEvent(
        reader,
        (item) =>
          item.payload?.type === "session.compaction.completed" && item.payload?.properties?.sessionID === session.id,
      )
      expect(event.payload.properties).toMatchObject({
        sessionID: session.id,
        reason: "auto",
        backendReason: "threshold",
      })
    } finally {
      await reader.cancel()
      controller.abort()
    }
  }, 15000)

  test("exposes Plan as a primary agent and switches the session runtime to it", async () => {
    const agentsRes = await fetch(`${baseUrl}/agent`, { headers: { Authorization: authHeader } })
    const agents = (await agentsRes.json()) as Array<{ name: string; mode: string }>
    expect(agents.find((agent) => agent.name === "plan")).toMatchObject({ name: "plan", mode: "primary" })

    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Plan Switch Test", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }
    const promptRes = await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: "plan",
        parts: [{ type: "text", text: "Plan this change" }],
      }),
    })
    expect(promptRes.status).toBe(204)

    const sessionRes = await fetch(`${baseUrl}/session/${session.id}`, {
      headers: { Authorization: authHeader },
    })
    expect(await sessionRes.json()).toMatchObject({ agent: "plan" })
  }, 15000)

  test("keeps the live Desktop message visible when Pi recovers from a provider retry", async () => {
    const controller = new AbortController()
    const eventRes = await fetch(`${baseUrl}/global/event`, {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    })
    const reader = eventRes.body!.getReader()
    await waitForSseEvent(reader, (event) => event.payload?.type === "server.connected")

    try {
      const directory = "/tmp"
      const scopedHeaders = {
        Authorization: authHeader,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      }
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: scopedHeaders,
        body: JSON.stringify({ title: "Provider retry recovery", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      const promptRes = await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: scopedHeaders,
        body: JSON.stringify({
          parts: [{ type: "text", text: "recover visibly __retry_once__" }],
        }),
      })
      expect(promptRes.status).toBe(204)

      let sawTerminalError = false
      const retryEvent = await waitForSseEvent(reader, (event) => {
        if (event.payload?.type === "session.error" && event.payload?.properties?.sessionID === session.id) {
          sawTerminalError = true
        }
        return (
          event.payload?.type === "session.status" &&
          event.payload?.properties?.sessionID === session.id &&
          event.payload?.properties?.status?.type === "retry"
        )
      })
      expect(retryEvent.payload.properties.status).toMatchObject({
        type: "retry",
        attempt: 1,
        message: "HTTP 500: temporary provider failure",
      })

      const liveTextEvent = await waitForSseEvent(reader, (event) => {
        if (event.payload?.type === "session.error" && event.payload?.properties?.sessionID === session.id) {
          sawTerminalError = true
        }
        return (
          event.payload?.type === "message.part.updated" &&
          event.payload?.properties?.sessionID === session.id &&
          event.payload?.properties?.part?.type === "text" &&
          event.payload?.properties?.part?.text?.includes("Pi agent simulation is working correctly")
        )
      })

      expect(sawTerminalError).toBe(false)
      expect(liveTextEvent.directory).toBe(directory)
      expect(liveTextEvent.payload.properties.part.text).toContain("recover visibly __retry_once__")

      const messageRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      const history = (await messageRes.json()) as Array<{
        info: { role: string; error?: unknown }
        parts: Array<{ type: string; text?: string }>
      }>
      const assistant = history.find((message) => message.info.role === "assistant")
      expect(assistant?.info.error).toBeUndefined()
      expect(assistant?.parts.find((part) => part.type === "text")?.text).toContain(
        "Pi agent simulation is working correctly",
      )
    } finally {
      await reader.cancel()
      controller.abort()
    }
  }, 15000)

  test("forwards every Pi text update as a live OpenCode delta and persists the final snapshot", async () => {
    const controller = new AbortController()
    const eventRes = await fetch(`${baseUrl}/global/event`, {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    })
    const reader = eventRes.body!.getReader()
    await waitForSseEvent(reader, (event) => event.payload?.type === "server.connected")

    try {
      const directory = "/tmp"
      const scopedHeaders = {
        Authorization: authHeader,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      }
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: scopedHeaders,
        body: JSON.stringify({ title: "Delta forwarding", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }
      const prompt = "stream every update"

      const promptRes = await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: scopedHeaders,
        body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
      })
      expect(promptRes.status).toBe(204)

      const expected = `This is a fake Pi response to: "${prompt}". Pi agent simulation is working correctly.`
      let streamed = ""
      let deltaCount = 0
      await waitForSseEvent(
        reader,
        (event) => {
          const payload = event.payload
          if (
            payload?.type === "message.part.delta" &&
            payload.properties?.sessionID === session.id &&
            payload.properties?.field === "text"
          ) {
            streamed += payload.properties.delta
            deltaCount++
          }
          return (
            payload?.type === "session.status" &&
            payload.properties?.sessionID === session.id &&
            payload.properties?.status?.type === "idle"
          )
        },
        10_000,
      )

      expect(deltaCount).toBe(expected.split(" ").length)
      expect(streamed).toBe(`${expected} `)

      const messageRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      const history = (await messageRes.json()) as Array<{
        info: { role: string }
        parts: Array<{ type: string; text?: string; time?: { end?: number } }>
      }>
      const finalText = history
        .find((message) => message.info.role === "assistant")
        ?.parts.find((part) => part.type === "text")
      expect(finalText?.text).toBe(expected)
      expect(finalText?.time?.end).toBeNumber()
    } finally {
      await reader.cancel()
      controller.abort()
    }
  }, 15000)

  test("forwards every Pi thinking update on the reasoning part", async () => {
    const controller = new AbortController()
    const eventRes = await fetch(`${baseUrl}/global/event`, {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    })
    const reader = eventRes.body!.getReader()
    await waitForSseEvent(reader, (event) => event.payload?.type === "server.connected")

    try {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Reasoning delta forwarding", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }
      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "show reasoning" }] }),
      })

      const expected = "Let me analyze this request carefully."
      let reasoningPartId: string | undefined
      let streamed = ""
      let deltaCount = 0
      await waitForSseEvent(
        reader,
        (event) => {
          const payload = event.payload
          if (
            payload?.type === "message.part.updated" &&
            payload.properties?.sessionID === session.id &&
            payload.properties?.part?.type === "reasoning"
          ) {
            reasoningPartId = payload.properties.part.id
          }
          if (
            payload?.type === "message.part.delta" &&
            payload.properties?.sessionID === session.id &&
            payload.properties?.partID === reasoningPartId
          ) {
            streamed += payload.properties.delta
            deltaCount++
          }
          return (
            payload?.type === "session.status" &&
            payload.properties?.sessionID === session.id &&
            payload.properties?.status?.type === "idle"
          )
        },
        10_000,
      )

      expect(reasoningPartId).toBeString()
      expect(deltaCount).toBe(expected.split(" ").length)
      expect(streamed).toBe(`${expected} `)

      const messageRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      const history = (await messageRes.json()) as Array<{
        info: { role: string }
        parts: Array<{ type: string; text?: string }>
      }>
      const reasoning = history
        .find((message) => message.info.role === "assistant")
        ?.parts.find((part) => part.type === "reasoning")
      expect(reasoning?.text).toBe(expected)
    } finally {
      await reader.cancel()
      controller.abort()
    }
  }, 15000)

  test("generates a title for the first message in a new Pi session", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string; title: string }
    expect(session.title).toBe("Untitled")

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "Investigate a flaky build" }] }),
    })

    let title = "Untitled"
    for (let attempt = 0; attempt < 50 && title === "Untitled"; attempt++) {
      await Bun.sleep(100)
      const getRes = await fetch(`${baseUrl}/session/${session.id}`, {
        headers: { Authorization: authHeader },
      })
      title = ((await getRes.json()) as { title: string }).title
    }
    expect(title).toBe("Fake conversation title")
  }, 15000)

  test("generates the title in parallel while the first Pi turn is still running", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string; title: string }
    expect(session.title).toBe("Untitled")

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "Investigate a slow build __slow_response__" }],
      }),
    })

    let current: { title: string; status: string } = { title: "Untitled", status: "idle" }
    const deadline = Date.now() + 900
    while (Date.now() < deadline && current.title === "Untitled") {
      await Bun.sleep(25)
      const getRes = await fetch(`${baseUrl}/session/${session.id}`, {
        headers: { Authorization: authHeader },
      })
      current = (await getRes.json()) as { title: string; status: string }
    }

    expect(current.title).toBe("Fake conversation title")
    expect(current.status).toBe("busy")

    const messageRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const history = (await messageRes.json()) as Array<{
      info: { role: string; time: { completed?: number } }
    }>
    const assistant = history.find((message) => message.info.role === "assistant")
    expect(assistant?.info.time.completed).toBeUndefined()
  }, 15000)

  test("persists a Desktop-compatible streamed tool call in the scoped project", async () => {
    const directory = "/tmp"
    const scopedHeaders = {
      Authorization: authHeader,
      "Content-Type": "application/json",
      "x-opencode-directory": encodeURIComponent(directory),
    }
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: scopedHeaders,
      body: JSON.stringify({ title: "Tool rendering", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string; directory: string }
    expect(session.directory).toBe(directory)

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: scopedHeaders,
      body: JSON.stringify({ parts: [{ type: "text", text: "run a bash tool" }] }),
    })

    await Bun.sleep(1500)
    const messageRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const history = (await messageRes.json()) as Array<{
      info: { role: string }
      parts: Array<{
        type: string
        tool?: string
        state?: {
          status: string
          output?: string
          title?: string
          metadata?: Record<string, unknown>
          time?: { start: number; end?: number }
        }
      }>
    }>
    const tool = history
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool")

    expect(tool).toMatchObject({
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        output: "hello",
        title: "bash",
        metadata: { streamed: true, exit: 0 },
      },
    })
    expect(tool?.state?.time?.start).toBeNumber()
    expect(tool?.state?.time?.end).toBeNumber()
  }, 15000)

  test("streams partial bash output on the running tool part via SSE", async () => {
    const controller = new AbortController()
    const eventRes = await fetch(`${baseUrl}/global/event`, {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    })
    const reader = eventRes.body!.getReader()
    await waitForSseEvent(reader, (event) => event.payload?.type === "server.connected")

    try {
      const directory = "/tmp"
      const scopedHeaders = {
        Authorization: authHeader,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      }
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: scopedHeaders,
        body: JSON.stringify({ title: "Streaming bash output", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: scopedHeaders,
        body: JSON.stringify({ parts: [{ type: "text", text: "run a bash tool" }] }),
      })

      const toolParts: Array<{ status?: string; output?: string; metadataOutput?: string }> = []
      await waitForSseEvent(
        reader,
        (event) => {
          const payload = event.payload
          if (
            payload?.type === "message.part.updated" &&
            payload.properties?.sessionID === session.id &&
            payload.properties?.part?.type === "tool"
          ) {
            const state = payload.properties.part.state ?? {}
            toolParts.push({
              status: state.status,
              output: state.output,
              metadataOutput: state.metadata?.output,
            })
          }
          return (
            payload?.type === "session.status" &&
            payload.properties?.sessionID === session.id &&
            payload.properties?.status?.type === "idle"
          )
        },
        10_000,
      )

      // The running tool part must carry the partial output on BOTH state.output
      // (read by the Desktop shell renderer via props.output on the live event
      // path) AND state.metadata.output (read via props.metadata.output after a
      // v2 REST reload, and by the ACP shellOutputSnapshot). This matches how
      // the canonical opencode ShellTool streams via ctx.metadata({ output }).
      expect(toolParts.some((part) => part.status === "running" && part.output === "hel")).toBe(true)
      expect(toolParts.some((part) => part.status === "running" && part.metadataOutput === "hel")).toBe(true)
      // The final completed part carries the full output ("hello").
      expect(toolParts.some((part) => part.status === "completed" && part.output === "hello")).toBe(true)

      // The v2 REST message projection must also carry tool metadata inside
      // `state.metadata` (not only at the top level) so the Desktop's v2
      // `toolPart` converter preserves it via normalizeToolMetadata after a
      // reload/reconnect.
      const v2Res = await fetch(`${baseUrl}/api/session/${session.id}/message?limit=20&order=asc`, {
        headers: { Authorization: authHeader },
      })
      const v2Messages = (await v2Res.json()) as {
        data: Array<{
          type: string
          content?: Array<{
            type: string
            state?: { status?: string; metadata?: { output?: string } | null }
          }>
        }>
      }
      const v2Tool = v2Messages.data
        .filter((message) => message.type === "assistant")
        .flatMap((message) => message.content ?? [])
        .find((content) => content.type === "tool")
      expect(v2Tool?.state?.metadata).toBeDefined()
    } finally {
      await reader.cancel()
      controller.abort()
    }
  }, 15000)

  test("exposes a model-invoked task as a navigable child session with its full execution", async () => {
    const directory = "/tmp"
    const scopedHeaders = {
      Authorization: authHeader,
      "Content-Type": "application/json",
      "x-opencode-directory": encodeURIComponent(directory),
    }
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: scopedHeaders,
      body: JSON.stringify({ title: "Model task navigation", agent: "pi" }),
    })
    const parent = (await createRes.json()) as { id: string }

    const eventController = new AbortController()
    const eventRes = await fetch(`${baseUrl}/global/event`, {
      headers: { Authorization: authHeader },
      signal: eventController.signal,
    })
    const eventReader = eventRes.body!.getReader()
    await waitForSseEvent(eventReader, (event) => event.payload?.type === "server.connected")

    await fetch(`${baseUrl}/session/${parent.id}/prompt_async`, {
      method: "POST",
      headers: scopedHeaders,
      body: JSON.stringify({
        parts: [{ type: "text", text: "delegate this __model_subtask__" }],
      }),
    })

    const taskLinkOrder: Array<{
      kind: "linked-task" | "child-created"
      input?: Record<string, unknown>
      sessionId?: unknown
    }> = []
    await waitForSseEvent(
      eventReader,
      (event) => {
        const payload = event.payload
        if (
          payload?.type === "message.part.updated" &&
          payload.properties?.sessionID === parent.id &&
          payload.properties?.part?.type === "tool" &&
          payload.properties?.part?.tool === "task" &&
          typeof payload.properties?.part?.state?.metadata?.sessionId === "string"
        ) {
          taskLinkOrder.push({
            kind: "linked-task",
            input: payload.properties.part.state.input,
            sessionId: payload.properties.part.state.metadata.sessionId,
          })
        }
        if (payload?.type === "session.created" && payload.properties?.info?.parentID === parent.id) {
          taskLinkOrder.push({
            kind: "child-created",
            sessionId: payload.properties.info.id,
          })
          return true
        }
        return false
      },
      5_000,
    )
    eventController.abort()
    await eventReader.cancel().catch(() => {})

    expect(taskLinkOrder.map((item) => item.kind)).toEqual(["linked-task", "child-created"])
    expect(taskLinkOrder[0]?.input).toMatchObject({
      description: "Inspect through child agent",
      prompt: "Inspect the fake project and report the child shell result",
      subagent_type: "explore",
    })
    expect(taskLinkOrder[0]?.sessionId).toBe(taskLinkOrder[1]?.sessionId)

    let parentMessages: Array<{
      info: { role: string }
      parts: Array<{
        type: string
        tool?: string
        state?: {
          status: string
          input: Record<string, unknown>
          metadata?: Record<string, unknown>
        }
      }>
    }> = []
    let task:
      | {
          type: string
          tool?: string
          state?: {
            status: string
            input: Record<string, unknown>
            metadata?: Record<string, unknown>
          }
        }
      | undefined
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const messageRes = await fetch(`${baseUrl}/session/${parent.id}/message`, {
        headers: { Authorization: authHeader },
      })
      parentMessages = (await messageRes.json()) as typeof parentMessages
      task = parentMessages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.tool === "task" && part.state?.status === "completed")
      if (task) break
      await Bun.sleep(50)
    }

    expect(task).toBeDefined()
    expect(task?.state?.input).toMatchObject({
      description: "Inspect through child agent",
      prompt: "Inspect the fake project and report the child shell result",
      subagent_type: "explore",
    })
    expect(task?.state?.metadata).toMatchObject({
      parentSessionId: parent.id,
      status: "completed",
    })
    const childSessionId = task?.state?.metadata?.sessionId
    expect(childSessionId).toBeString()

    const childRes = await fetch(`${baseUrl}/session/${childSessionId}`, {
      headers: { Authorization: authHeader },
    })
    expect(childRes.ok).toBe(true)
    const child = (await childRes.json()) as {
      id: string
      parentID?: string
      title: string
      agent: string
      status: string
    }
    expect(child).toMatchObject({
      id: childSessionId,
      parentID: parent.id,
      title: "Inspect through child agent (@Explore subagent)",
      agent: "explore",
      status: "idle",
    })

    const childMessageRes = await fetch(`${baseUrl}/session/${childSessionId}/message`, {
      headers: { Authorization: authHeader },
    })
    const childMessages = (await childMessageRes.json()) as Array<{
      info: { role: string; time: { completed?: number } }
      parts: Array<{
        type: string
        text?: string
        tool?: string
        state?: { status: string; output?: string; time?: { end?: number } }
      }>
    }>
    const childUser = childMessages.find((message) => message.info.role === "user")
    expect(childUser?.parts.find((part) => part.type === "text")?.text).toBe(
      "Inspect the fake project and report the child shell result",
    )

    const childAssistant = childMessages.find((message) => message.info.role === "assistant")
    expect(childAssistant?.info.time.completed).toBeNumber()
    expect(childAssistant?.parts.find((part) => part.type === "reasoning")?.text).toBe("Inspecting child workspace.")
    expect(childAssistant?.parts.find((part) => part.type === "text")?.text).toBe("Child inspection complete.")
    expect(childAssistant?.parts.find((part) => part.type === "tool" && part.tool === "bash")).toMatchObject({
      state: {
        status: "completed",
        output: "child",
      },
    })
  }, 15000)

  test("publishes completed tool calls on the matching Desktop project channel", async () => {
    const controller = new AbortController()
    const eventRes = await fetch(`${baseUrl}/global/event`, {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    })
    const reader = eventRes.body!.getReader()
    await waitForSseEvent(reader, (event) => event.payload?.type === "server.connected")

    try {
      const directory = "/tmp"
      const scopedHeaders = {
        Authorization: authHeader,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      }
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: scopedHeaders,
        body: JSON.stringify({ title: "Live tool event", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }
      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: scopedHeaders,
        body: JSON.stringify({ parts: [{ type: "text", text: "run a bash tool" }] }),
      })

      const event = await waitForSseEvent(
        reader,
        (item) =>
          item.payload?.type === "message.part.updated" &&
          item.payload?.properties?.sessionID === session.id &&
          item.payload?.properties?.part?.type === "tool" &&
          item.payload?.properties?.part?.state?.status === "completed",
      )
      expect(event.directory).toBe(directory)
      expect(event.payload.properties.part).toMatchObject({
        tool: "bash",
        state: { status: "completed", output: "hello", title: "bash" },
      })
    } finally {
      await reader.cancel()
      controller.abort()
    }
  }, 15000)

  test("persists a completed tool when Pi only emits message snapshots", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Tool snapshot recovery", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "run bash __tool_snapshots_only__" }],
      }),
    })

    await Bun.sleep(1500)
    const messageRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const history = (await messageRes.json()) as Array<{
      info: { role: string }
      parts: Array<{
        type: string
        tool?: string
        state?: {
          status: string
          input: Record<string, unknown>
          output?: string
          metadata?: Record<string, unknown>
          time?: { start: number; end?: number }
        }
      }>
    }>
    const tool = history.flatMap((message) => message.parts).find((part) => part.type === "tool")
    expect(tool).toMatchObject({
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "echo hello" },
        output: "hello from snapshot",
        metadata: { recoveredFromSnapshot: true, exit: 0 },
      },
    })
    expect(tool?.state?.time?.end).toBeNumber()
  }, 15000)

  test("final-only output and a missing settled event cannot leave Desktop thinking", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Terminal Recovery Test", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "think __final_only__ __omit_agent_settled__" }],
      }),
    })

    await Bun.sleep(2000)

    const [sessionRes, messageRes] = await Promise.all([
      fetch(`${baseUrl}/session/${session.id}`, { headers: { Authorization: authHeader } }),
      fetch(`${baseUrl}/session/${session.id}/message`, { headers: { Authorization: authHeader } }),
    ])
    const updated = (await sessionRes.json()) as { status: string }
    const messages = (await messageRes.json()) as Array<{
      info: { role: string; time: { completed?: number } }
      parts: Array<{ type: string; text?: string; time?: { start: number; end?: number } }>
    }>
    const assistant = messages.find((message) => message.info.role === "assistant")

    expect(updated.status).toBe("idle")
    expect(assistant?.info.time.completed).toBeNumber()
    expect(assistant?.parts.find((part) => part.type === "reasoning")?.text).toContain("analyze")
    expect(assistant?.parts.find((part) => part.type === "text")?.text).toContain("fake Pi response")
    for (const part of assistant?.parts.filter((item) => item.type === "reasoning" || item.type === "text") ?? []) {
      expect(part.time?.end).toBeNumber()
    }
  }, 10000)

  test("SSE endpoint returns stream", async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/event`, {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("server.connected")
    await reader.cancel()
    controller.abort()
  }, 10000)

  test("abort stops Fake Pi processing", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Abort Test", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "abort me" }] }),
    })

    await Bun.sleep(100)

    const abortRes = await fetch(`${baseUrl}/session/${session.id}/abort`, {
      method: "POST",
      headers: { Authorization: authHeader },
    })
    expect(abortRes.ok).toBe(true)

    await Bun.sleep(500)

    const getRes = await fetch(`${baseUrl}/session/${session.id}`, {
      headers: { Authorization: authHeader },
    })
    const updated = (await getRes.json()) as { status: string }
    expect(updated.status).toBe("idle")
  }, 15000)
})
