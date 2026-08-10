import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"
import { reserveFreePort } from "../helpers/free-port.ts"
import { createV2TestFetch } from "../helpers/v2-test-fetch.ts"
import { waitFor, waitForSessionIdle } from "../helpers/wait-for.ts"

const fetch = createV2TestFetch()
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")
const FAKE_PI_PATH = join(import.meta.dir, "..", "fixtures", "fake-pi", "fake-pi.ts")
const BUN_BIN = join(homedir(), ".bun", "bin", "bun")

describe.concurrent("Subtask Modes (parallel / chain / usage)", () => {
  let port: number
  let password: string
  let proc: ReturnType<typeof spawn>
  let baseUrl: string
  let authHeader: string
  let tmpDbPath: string

  beforeAll(async () => {
    port = reserveFreePort()
    password = randomUUID()
    const tmpDir = mkdtempSync(join(tmpdir(), "opencode-modes-"))
    tmpDbPath = join(tmpDir, "test.db")

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
        OPENCODE_CLIENT: "",
        DEFAULT_AGENT: "pi",
        PI_CLI_PATH: `${BUN_BIN} ${FAKE_PI_PATH}`,
        DATABASE_PATH: tmpDbPath,
        SUBTASK_TERMINATE_GRACE_PERIOD_MS: "3000",
        SUBTASK_STDERR_LIMIT_BYTES: "65536",
        SUBTASK_TIMEOUT_MS: "30000",
        SUBTASK_AGENT_SCOPE: "both",
        MAX_ACTIVE_AGENT_PROCESSES: "10",
        MAX_GLOBAL_CONCURRENT_SUBTASKS: "12",
        PATH: `${homedir()}/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
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

  test("parallel mode: multiple subtasks run concurrently and produce separate child sessions", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Parallel Test", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        subtaskMode: "parallel",
        parts: [
          { type: "subtask", prompt: "Task A: do something", description: "Task A", agent: "pi" },
          { type: "subtask", prompt: "Task B: do something else", description: "Task B", agent: "pi" },
          { type: "subtask", prompt: "Task C: do a third thing", description: "Task C", agent: "pi" },
          { type: "text", text: "Summarize the results" },
        ],
      }),
    })

    await waitForSessionIdle(baseUrl, authHeader, session.id, 30_000)

    const childrenRes = await fetch(`${baseUrl}/session/${session.id}/children`, {
      headers: { Authorization: authHeader },
    })
    expect(childrenRes.ok).toBe(true)
    const children = (await childrenRes.json()) as Array<{ id: string; parentID: string }>
    expect(children.length).toBe(3)
    expect(children.every((c) => c.parentID === session.id)).toBe(true)

    const childIds = new Set(children.map((c) => c.id))
    expect(childIds.size).toBe(3)

    const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const messages = (await msgRes.json()) as Array<{
      info: { role: string }
      parts: Array<{
        type: string
        tool?: string
        state?: {
          status: string
          metadata?: { sessionId?: string; usage?: { cost?: number; input?: number; output?: number } }
        }
      }>
    }>

    const toolParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && p.tool === "task")
    expect(toolParts.length).toBe(3)
    expect(toolParts.every((p) => p.state!.status === "completed")).toBe(true)

    for (const tp of toolParts) {
      expect(tp.state!.metadata!.sessionId).toBeDefined()
      expect(tp.state!.metadata!.usage).toBeDefined()
      expect(tp.state!.metadata!.usage!.cost).toBeGreaterThan(0)
      expect(tp.state!.metadata!.usage!.input).toBeGreaterThan(0)
    }
  }, 30000)

  test("chain mode: steps run sequentially with {previous} substitution", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Chain Test", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        subtaskMode: "chain",
        parts: [
          { type: "subtask", prompt: "First step: say hello world", description: "Step 1", agent: "pi" },
          {
            type: "subtask",
            prompt: "Previous result was: {previous}. Now say goodbye",
            description: "Step 2",
            agent: "pi",
          },
          { type: "text", text: "Summarize the chain" },
        ],
      }),
    })

    await waitForSessionIdle(baseUrl, authHeader, session.id, 30_000)

    const childrenRes = await fetch(`${baseUrl}/session/${session.id}/children`, {
      headers: { Authorization: authHeader },
    })
    const children = (await childrenRes.json()) as Array<{ id: string }>
    expect(children.length).toBe(2)

    const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const messages = (await msgRes.json()) as Array<{
      parts: Array<{ type: string; tool?: string; state?: { status: string; output?: string } }>
    }>

    const toolParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && p.tool === "task")
    expect(toolParts.length).toBe(2)
    expect(toolParts.every((p) => p.state!.status === "completed")).toBe(true)
  }, 30000)

  test("usage/cost persisted to child assistant message", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Usage Test", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [
          { type: "subtask", prompt: "hello world", description: "Usage test", agent: "pi" },
          { type: "text", text: "done" },
        ],
      }),
    })

    await waitForSessionIdle(baseUrl, authHeader, session.id)

    const childrenRes = await fetch(`${baseUrl}/session/${session.id}/children`, {
      headers: { Authorization: authHeader },
    })
    const children = (await childrenRes.json()) as Array<{ id: string }>

    const childMsgRes = await fetch(`${baseUrl}/session/${children[0]!.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const childMessages = (await childMsgRes.json()) as Array<{
      info: { role: string }
      parts: Array<{ type: string }>
    }>

    const childAssistantMsg = childMessages.find((m) => m.info.role === "assistant")
    expect(childAssistantMsg).toBeDefined()

    const rawRes = await fetch(`${baseUrl}/session/${children[0]!.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const raw = await rawRes.text()
    expect(raw).toContain('"cost"')
    expect(raw).toContain('"tokens"')
  }, 15000)

  test("parallel mode: individual task can be aborted", async () => {
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Abort Test", agent: "pi" }),
    })
    const session = (await createRes.json()) as { id: string }

    await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        subtaskMode: "parallel",
        parts: [
          { type: "subtask", prompt: "abort cancel", description: "Will abort", agent: "pi" },
          { type: "subtask", prompt: "hello world", description: "Will complete", agent: "pi" },
        ],
      }),
    })

    await waitFor(
      async () => {
        const response = await fetch(`${baseUrl}/session/${session.id}/children`, {
          headers: { Authorization: authHeader },
        })
        return (await response.json()) as Array<{ id: string; status: string }>
      },
      (children) => children.length === 2,
      { description: `subtasks for session ${session.id}` },
    )

    await fetch(`${baseUrl}/session/${session.id}/abort`, {
      method: "POST",
      headers: { Authorization: authHeader },
    })

    await waitForSessionIdle(baseUrl, authHeader, session.id)

    const children = await waitFor(
      async () => {
        const response = await fetch(`${baseUrl}/session/${session.id}/children`, {
          headers: { Authorization: authHeader },
        })
        return (await response.json()) as Array<{ id: string; status: string }>
      },
      (sessions) =>
        sessions.length === 2 &&
        sessions.every((child) => ["idle", "aborted", "failed", "interrupted"].includes(child.status)),
      { description: `subtasks for session ${session.id} to terminate` },
    )

    expect(children.length).toBe(2)
    const hasTerminal = children.every(
      (c) => c.status === "idle" || c.status === "aborted" || c.status === "failed" || c.status === "interrupted",
    )
    expect(hasTerminal).toBe(true)

    const sessionRes = await fetch(`${baseUrl}/session/${session.id}`, {
      headers: { Authorization: authHeader },
    })
    const updatedSession = (await sessionRes.json()) as { status: string }
    expect(updatedSession.status).toBe("idle")
  }, 20000)
})
