import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"
import { reserveFreePort } from "../helpers/free-port.ts"
import { createV2TestFetch } from "../helpers/v2-test-fetch.ts"
import { waitFor, waitForSessionIdle } from "../helpers/wait-for.ts"

const fetch = createV2TestFetch()
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")
const FAKE_PI_PATH = join(import.meta.dir, "..", "fixtures", "fake-pi", "fake-pi.ts")
const BUN_BIN = join(homedir(), ".bun", "bin", "bun")

describe("Subtask Architecture", () => {
  let port: number
  let password: string
  let proc: ReturnType<typeof spawn>
  let baseUrl: string
  let authHeader: string
  let tmpDbPath: string

  beforeAll(async () => {
    port = reserveFreePort()
    password = randomUUID()
    const tmpDir = mkdtempSync(join(tmpdir(), "opencode-test-"))
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
        MAX_SUBTASK_DEPTH: "3",
        MAX_GLOBAL_CONCURRENT_SUBTASKS: "8",
        MAX_CONCURRENT_SUBTASKS_PER_PARENT: "4",
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
      } catch {}
    }
    throw new Error(`Server did not become healthy at ${baseUrl}`)
  }, 60000)

  afterAll(async () => {
    proc.kill("SIGTERM")
    await proc.exited
    try {
      rmSync(tmpDbPath)
    } catch {}
  })

  describe("Child Session Management", () => {
    test("child session has correct parentID", async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Parent Session", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [
            { type: "subtask", prompt: "Say hello", description: "Greeting", agent: "pi" },
            { type: "text", text: "Continue" },
          ],
        }),
      })

      await waitForSessionIdle(baseUrl, authHeader, session.id)

      const childrenRes = await fetch(`${baseUrl}/session/${session.id}/children`, {
        headers: { Authorization: authHeader },
      })
      expect(childrenRes.ok).toBe(true)
      const children = (await childrenRes.json()) as Array<{ id: string; parentID?: string; agent: string }>
      expect(children.length).toBeGreaterThanOrEqual(1)
      expect(children[0]!.parentID).toBe(session.id)
      expect(children[0]!.agent).toBe("pi")
    }, 15000)

    test("child session has queryable messages", async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Parent with Messages", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [
            { type: "subtask", prompt: "Say hello world", description: "Test", agent: "pi" },
            { type: "text", text: "Continue" },
          ],
        }),
      })

      await waitForSessionIdle(baseUrl, authHeader, session.id)

      const childrenRes = await fetch(`${baseUrl}/session/${session.id}/children`, {
        headers: { Authorization: authHeader },
      })
      const children = (await childrenRes.json()) as Array<{ id: string }>
      expect(children.length).toBeGreaterThanOrEqual(1)

      const childMsgRes = await fetch(`${baseUrl}/session/${children[0]!.id}/message`, {
        headers: { Authorization: authHeader },
      })
      expect(childMsgRes.ok).toBe(true)
      const childMessages = (await childMsgRes.json()) as Array<{
        info: { role: string }
        parts: Array<{ type: string; text?: string }>
      }>
      expect(childMessages.length).toBeGreaterThanOrEqual(2)

      const childUserMsg = childMessages.find((m) => m.info.role === "user")
      expect(childUserMsg).toBeDefined()
      const childTextParts = childUserMsg!.parts.filter((p) => p.type === "text")
      expect(childTextParts.length).toBeGreaterThanOrEqual(1)
      expect(childTextParts[0]!.text).toContain("Say hello world")

      const childAssistantMsg = childMessages.find((m) => m.info.role === "assistant")
      expect(childAssistantMsg).toBeDefined()
    }, 15000)

    test("tool part metadata includes OpenCode sessionId matching child session", async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Metadata Test", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [
            { type: "subtask", prompt: "Do something", description: "Meta test", agent: "pi" },
            { type: "text", text: "Done?" },
          ],
        }),
      })

      await waitForSessionIdle(baseUrl, authHeader, session.id)

      const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      const messages = (await msgRes.json()) as Array<{
        parts: Array<{ type: string; tool?: string; state?: { metadata?: { sessionId?: string } } }>
      }>

      const toolParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && p.tool === "task")
      expect(toolParts.length).toBeGreaterThanOrEqual(1)
      expect(toolParts[0]!.state!.metadata).toBeDefined()
      const childId = toolParts[0]!.state!.metadata!.sessionId
      expect(childId).toBeDefined()
      expect(typeof childId).toBe("string")
      expect(childId!.length).toBeGreaterThan(0)

      const childrenRes = await fetch(`${baseUrl}/session/${session.id}/children`, {
        headers: { Authorization: authHeader },
      })
      const children = (await childrenRes.json()) as Array<{ id: string }>
      expect(children.some((c) => c.id === childId)).toBe(true)
    }, 15000)
  })

  describe("Multiple Subtasks", () => {
    test("multiple subtasks create multiple child sessions", async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Multi Child Test", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [
            { type: "subtask", prompt: "First task", description: "First", agent: "pi" },
            { type: "subtask", prompt: "Second task", description: "Second", agent: "pi" },
            { type: "subtask", prompt: "Third task", description: "Third", agent: "pi" },
            { type: "text", text: "Summarize all" },
          ],
        }),
      })

      await waitForSessionIdle(baseUrl, authHeader, session.id, 25_000)

      const childrenRes = await fetch(`${baseUrl}/session/${session.id}/children`, {
        headers: { Authorization: authHeader },
      })
      const children = (await childrenRes.json()) as Array<{ id: string; parentID: string }>
      expect(children.length).toBeGreaterThanOrEqual(3)
      expect(children.every((c) => c.parentID === session.id)).toBe(true)

      const childIds = new Set(children.map((c) => c.id))
      expect(childIds.size).toBe(children.length)
    }, 25000)
  })

  describe("Abort Propagation", () => {
    test("aborting parent session also aborts running subtasks", async () => {
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
          parts: [
            { type: "subtask", prompt: "This is a long task that should be aborted", description: "Long", agent: "pi" },
            { type: "text", text: "Continue after" },
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
        (children) => children.length > 0,
        { description: `subtask for session ${session.id}` },
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
          sessions.length === 0 ||
          sessions.some((child) => ["idle", "aborted", "failed", "interrupted"].includes(child.status)),
        { description: `subtask for session ${session.id} to terminate` },
      )

      if (children.length > 0) {
        const childStatuses = children.map((c) => c.status)
        const hasTerminal = childStatuses.some(
          (s) => s === "idle" || s === "aborted" || s === "failed" || s === "interrupted",
        )
        expect(hasTerminal).toBe(true)
      }

      const sessionRes = await fetch(`${baseUrl}/session/${session.id}`, {
        headers: { Authorization: authHeader },
      })
      const updatedSession = (await sessionRes.json()) as { status: string }
      expect(updatedSession.status).toBe("idle")
    }, 15000)
  })

  describe("Persistence Recovery", () => {
    test("server restart marks running child sessions as interrupted", async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Recovery Test", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [
            { type: "subtask", prompt: "Quick task", description: "Recovery setup", agent: "pi" },
            { type: "text", text: "Done" },
          ],
        }),
      })

      await waitForSessionIdle(baseUrl, authHeader, session.id)

      const childrenRes = await fetch(`${baseUrl}/session/${session.id}/children`, {
        headers: { Authorization: authHeader },
      })
      const children = (await childrenRes.json()) as Array<{ id: string }>
      expect(children.length).toBeGreaterThanOrEqual(1)
      const childId = children[0]!.id

      await fetch(`${baseUrl}/session/${childId}`, {
        method: "PATCH",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      })

      proc.kill("SIGTERM")
      await proc.exited

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
          PATH: `${homedir()}/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
        },
      })

      for (let i = 0; i < 100; i++) {
        await Bun.sleep(300)
        try {
          const res = await fetch(`${baseUrl}/api/health`, { headers: { Authorization: authHeader } })
          if (res.ok) break
        } catch {}
      }

      const childRes = await fetch(`${baseUrl}/session/${childId}`, {
        headers: { Authorization: authHeader },
      })
      const recoveredChild = (await childRes.json()) as { status: string }
      expect(recoveredChild.status).not.toBe("running")
      expect(recoveredChild.status).toBe("interrupted")
    }, 30000)
  })
})
