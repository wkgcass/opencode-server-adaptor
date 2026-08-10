import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { reserveFreePort } from "../helpers/free-port.ts"
import { join } from "node:path"
import { waitFor, waitForSessionIdle } from "../helpers/wait-for.ts"

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")

describe.concurrent("Agent Integration", () => {
  let port: number
  let password: string
  let proc: ReturnType<typeof spawn>
  let baseUrl: string
  let authHeader: string

  beforeAll(async () => {
    port = reserveFreePort()
    password = randomUUID()

    proc = spawn({
      cmd: ["bun", "run", CLI_PATH, "--log-level", "ERROR", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: "opencode",
        DEFAULT_AGENT: "stub",
        DATABASE_PATH: ":memory:",
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

  test("v2 prompt triggers stub agent and produces text content", async () => {
    const createRes = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    const { data: session } = (await createRes.json()) as { data: { id: string } }

    const promptRes = await fetch(`${baseUrl}/api/session/${session.id}/prompt`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: { text: "Hello stub" } }),
    })
    expect(promptRes.ok).toBe(true)

    await waitForSessionIdle(baseUrl, authHeader, session.id)

    const msgRes = await fetch(`${baseUrl}/api/session/${session.id}/message?order=asc`, {
      headers: { Authorization: authHeader },
    })
    const { data: messages } = (await msgRes.json()) as {
      data: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>
    }

    expect(messages.length).toBeGreaterThanOrEqual(2)

    const assistantMsg = messages.find((m) => m.type === "assistant")
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.content!.length).toBeGreaterThan(0)

    const textParts = assistantMsg!.content!.filter((p) => p.type === "text")
    expect(textParts.length).toBeGreaterThan(0)
    expect(textParts[0]!.text).toContain("stub response")
  }, 15000)

  test("session returns to idle after prompt completes", async () => {
    const createRes = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    const { data: session } = (await createRes.json()) as { data: { id: string } }

    await fetch(`${baseUrl}/api/session/${session.id}/prompt`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: { text: "Hi" } }),
    })

    await waitForSessionIdle(baseUrl, authHeader, session.id)

    const getRes = await fetch(`${baseUrl}/api/session/active`, {
      headers: { Authorization: authHeader },
    })
    const active = (await getRes.json()) as { data: Record<string, unknown> }
    expect(active.data[session.id]).toBeUndefined()
  }, 15000)

  test("multiple sessions can run concurrently", async () => {
    const sessions: Array<{ id: string }> = []
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/api/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      sessions.push(((await res.json()) as { data: { id: string } }).data)
    }

    for (const s of sessions) {
      await fetch(`${baseUrl}/api/session/${s.id}/prompt`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: { text: `Hello ${s.id}` } }),
      })
    }

    await Promise.all(sessions.map((session) => waitForSessionIdle(baseUrl, authHeader, session.id)))

    for (const s of sessions) {
      const res = await fetch(`${baseUrl}/api/session/${s.id}/message?order=asc`, {
        headers: { Authorization: authHeader },
      })
      const { data: messages } = (await res.json()) as {
        data: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>
      }
      const assistant = messages.find((m) => m.type === "assistant")
      expect(assistant).toBeDefined()
      expect(assistant!.content!.some((p) => p.type === "text" && p.text && p.text.length > 0)).toBe(true)
    }
  }, 20000)

  test("same session operations are serialized", async () => {
    const createRes = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    const { data: session } = (await createRes.json()) as { data: { id: string } }

    const p1 = fetch(`${baseUrl}/api/session/${session.id}/prompt`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: { text: "First" }, delivery: "queue" }),
    })

    const p2 = fetch(`${baseUrl}/api/session/${session.id}/prompt`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: { text: "Second" }, delivery: "queue" }),
    })

    await Promise.all([p1, p2])

    await waitForSessionIdle(baseUrl, authHeader, session.id)

    const msgRes = await fetch(`${baseUrl}/api/session/${session.id}/message?order=asc`, {
      headers: { Authorization: authHeader },
    })
    const { data: messages } = (await msgRes.json()) as { data: Array<{ type: string }> }
    expect(messages.length).toBeGreaterThanOrEqual(4)
  }, 20000)

  test("abort stops processing", async () => {
    const createRes = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    const { data: session } = (await createRes.json()) as { data: { id: string } }

    await fetch(`${baseUrl}/api/session/${session.id}/prompt`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: { text: "Long prompt" } }),
    })

    await waitFor(
      async () => {
        const response = await fetch(`${baseUrl}/api/session/active`, { headers: { Authorization: authHeader } })
        return ((await response.json()) as { data: Record<string, unknown> }).data
      },
      (active) => active[session.id] !== undefined,
      { description: `session ${session.id} to become active` },
    )

    const abortRes = await fetch(`${baseUrl}/api/session/${session.id}/interrupt`, {
      method: "POST",
      headers: { Authorization: authHeader },
    })
    expect(abortRes.ok).toBe(true)

    await waitForSessionIdle(baseUrl, authHeader, session.id)

    const getRes = await fetch(`${baseUrl}/api/session/active`, {
      headers: { Authorization: authHeader },
    })
    const active = (await getRes.json()) as { data: Record<string, unknown> }
    expect(active.data[session.id]).toBeUndefined()
  }, 15000)
})
