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

describe("Subagent + Custom Agent Registration", () => {
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
        OPENCODE_CLIENT: "",
        DEFAULT_AGENT: "pi",
        DATABASE_PATH: ":memory:",
        PI_CLI_PATH: `${BUN_BIN} ${FAKE_PI_PATH}`,
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
      } catch (err) {
        if (i === 20) {
          const stderrText = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
          console.error("Server stderr:", stderrText.slice(0, 500))
        }
      }
    }
    throw new Error(`Server did not become healthy at ${baseUrl}`)
  }, 60000)

  afterAll(async () => {
    proc.kill("SIGTERM")
    await proc.exited
  })

  describe("Custom Agent Registration", () => {
    test("POST /agent registers a new custom agent", async () => {
      const res = await fetch(`${baseUrl}/agent`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "my-custom-agent",
          description: "A custom agent for testing",
          cliPath: `${BUN_BIN} ${FAKE_PI_PATH}`,
        }),
      })
      expect(res.status).toBe(201)
      const agent = (await res.json()) as { name: string; description: string; mode: string }
      expect(agent.name).toBe("my-custom-agent")
      expect(agent.description).toBe("A custom agent for testing")
      expect(agent.mode).toBe("subagent")
    })

    test("GET /agent includes custom agent", async () => {
      const res = await fetch(`${baseUrl}/agent`, { headers: { Authorization: authHeader } })
      expect(res.ok).toBe(true)
      const agents = (await res.json()) as Array<{ name: string }>
      expect(agents.some((a) => a.name === "my-custom-agent")).toBe(true)
    })

    test("GET /agent exposes the Pi task profiles used by child sessions", async () => {
      const res = await fetch(`${baseUrl}/agent`, { headers: { Authorization: authHeader } })
      expect(res.ok).toBe(true)
      const agents = (await res.json()) as Array<{ name: string; mode: string }>
      for (const name of ["general", "explore", "plan", "review"]) {
        expect(agents.find((agent) => agent.name === name)).toMatchObject({
          name,
          mode: name === "plan" ? "primary" : "subagent",
        })
      }
    })

    test("POST /agent with duplicate name returns 409", async () => {
      const res = await fetch(`${baseUrl}/agent`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "my-custom-agent",
          cliPath: `${BUN_BIN} ${FAKE_PI_PATH}`,
        }),
      })
      expect(res.status).toBe(409)
    })

    test("POST /agent without name returns 400", async () => {
      const res = await fetch(`${baseUrl}/agent`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ cliPath: "something" }),
      })
      expect(res.status).toBe(400)
    })

    test("POST /agent without cliPath returns 400", async () => {
      const res = await fetch(`${baseUrl}/agent`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "no-cli-agent" }),
      })
      expect(res.status).toBe(400)
    })

    test("DELETE /agent/:name removes custom agent", async () => {
      await fetch(`${baseUrl}/agent`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "temp-agent",
          cliPath: `${BUN_BIN} ${FAKE_PI_PATH}`,
        }),
      })

      const delRes = await fetch(`${baseUrl}/agent/temp-agent`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      })
      expect(delRes.ok).toBe(true)

      const listRes = await fetch(`${baseUrl}/agent`, { headers: { Authorization: authHeader } })
      const agents = (await listRes.json()) as Array<{ name: string }>
      expect(agents.some((a) => a.name === "temp-agent")).toBe(false)
    })

    test("DELETE /agent/:name for unknown returns 404", async () => {
      const res = await fetch(`${baseUrl}/agent/nonexistent`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      })
      expect(res.status).toBe(404)
    })

    test("session can use custom agent", async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Custom Agent Test", agent: "my-custom-agent" }),
      })
      expect(createRes.ok).toBe(true)
      const session = (await createRes.json()) as { id: string; agent: string }
      expect(session.agent).toBe("my-custom-agent")

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "Hello custom agent" }] }),
      })

      await Bun.sleep(5000)

      const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      const messages = (await msgRes.json()) as Array<{
        info: { role: string }
        parts: Array<{ type: string; text?: string }>
      }>

      const assistant = messages.find((m) => m.info.role === "assistant")
      expect(assistant).toBeDefined()
      const textParts = assistant!.parts.filter((p) => p.type === "text")
      expect(textParts.length).toBeGreaterThan(0)
    }, 15000)
  })

  describe("Subtask / Subagent", () => {
    test("prompt with subtask part creates SubtaskPart on user message and ToolPart on dedicated assistant message", async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subtask Test", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [
            {
              type: "subtask",
              prompt: "List all files in the current directory",
              description: "File listing subtask",
              agent: "pi",
            },
            {
              type: "text",
              text: "After the subtask completes, say hello.",
            },
          ],
        }),
      })

      await Bun.sleep(8000)

      const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      const messages = (await msgRes.json()) as Array<{
        info: { role: string; agent?: string }
        parts: Array<{
          type: string
          prompt?: string
          agent?: string
          text?: string
          tool?: string
          state?: { status: string; output?: string; metadata?: { sessionId?: string } }
        }>
      }>

      // SubtaskPart must be on the user message (OpenCode standard)
      const userMsg = messages.find((m) => m.info.role === "user")
      expect(userMsg).toBeDefined()
      const subtaskParts = userMsg!.parts.filter((p) => p.type === "subtask")
      expect(subtaskParts.length).toBeGreaterThanOrEqual(1)
      expect(subtaskParts[0]!.agent).toBe("pi")
      expect(subtaskParts[0]!.prompt).toContain("List all files")

      // ToolPart (tool="task") must be on a dedicated assistant message
      const toolParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && p.tool === "task")
      expect(toolParts.length).toBeGreaterThanOrEqual(1)
      expect(toolParts[0]!.state!.status).toBe("completed")

      // OpenCode's task card becomes navigable only when metadata.sessionId is present.
      expect(toolParts[0]!.state!.metadata).toBeDefined()
      expect(toolParts[0]!.state!.metadata!.sessionId).toBeDefined()

      // Child session must be queryable via /session/:id/children
      const childrenRes = await fetch(`${baseUrl}/session/${session.id}/children`, {
        headers: { Authorization: authHeader },
      })
      expect(childrenRes.ok).toBe(true)
      const children = (await childrenRes.json()) as Array<{ id: string; parentID?: string }>
      expect(children.length).toBeGreaterThanOrEqual(1)
      expect(children[0]!.parentID).toBe(session.id)

      // Text part must exist (main agent response)
      const allTextParts = messages.flatMap((m) => m.parts.filter((p) => p.type === "text"))
      expect(allTextParts.length).toBeGreaterThan(0)
    }, 15000)

    test("subtask with non-existent agent creates ToolPart with error and continues", async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Bad Subtask Test", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      const promptRes = await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [
            {
              type: "subtask",
              prompt: "Do something",
              description: "Bad agent subtask",
              agent: "nonexistent-agent",
            },
            {
              type: "text",
              text: "Hello anyway",
            },
          ],
        }),
      })
      expect(promptRes.ok).toBe(true)

      await Bun.sleep(8000)

      const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      const messages = (await msgRes.json()) as Array<{
        info: { role: string }
        parts: Array<{ type: string; tool?: string; state?: { status: string; output?: string } }>
      }>

      // SubtaskPart on user message
      const userMsg = messages.find((m) => m.info.role === "user")
      expect(userMsg).toBeDefined()
      const subtaskParts = userMsg!.parts.filter((p) => p.type === "subtask")
      expect(subtaskParts.length).toBeGreaterThanOrEqual(1)

      // ToolPart exists with error status (agent not found = failure)
      const toolParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && p.tool === "task")
      expect(toolParts.length).toBeGreaterThanOrEqual(1)
      expect(toolParts[0]!.state!.status).toBe("error")

      // Text parts exist (main agent still responds)
      const allTextParts = messages.flatMap((m) => m.parts.filter((p) => p.type === "text"))
      expect(allTextParts.length).toBeGreaterThan(0)
    }, 15000)

    test("multiple subtasks in one prompt", async () => {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Multi Subtask Test", agent: "pi" }),
      })
      const session = (await createRes.json()) as { id: string }

      await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [
            {
              type: "subtask",
              prompt: "First subtask",
              description: "First",
              agent: "pi",
            },
            {
              type: "subtask",
              prompt: "Second subtask",
              description: "Second",
              agent: "pi",
            },
            {
              type: "text",
              text: "Now summarize",
            },
          ],
        }),
      })

      await Bun.sleep(8000)

      const msgRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
        headers: { Authorization: authHeader },
      })
      const messages = (await msgRes.json()) as Array<{
        info: { role: string }
        parts: Array<{ type: string; prompt?: string; tool?: string; state?: { status: string } }>
      }>

      // SubtaskParts on user message
      const userMsg = messages.find((m) => m.info.role === "user")
      expect(userMsg).toBeDefined()
      const subtaskParts = userMsg!.parts.filter((p) => p.type === "subtask")
      expect(subtaskParts.length).toBeGreaterThanOrEqual(2)

      // ToolParts on dedicated assistant messages
      const toolParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && p.tool === "task")
      expect(toolParts.length).toBeGreaterThanOrEqual(2)
    }, 20000)
  })
})
