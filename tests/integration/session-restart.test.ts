import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { spawn } from "bun"
import { reserveFreePort } from "../helpers/free-port.ts"
import { createV2TestFetch } from "../helpers/v2-test-fetch.ts"

const fetch = createV2TestFetch()

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")
const FAKE_PI_PATH = join(import.meta.dir, "..", "fixtures", "fake-pi", "fake-pi.ts")
const BUN_BIN = join(homedir(), ".bun", "bin", "bun")

describe("session restart recovery", () => {
  const cleanup: string[] = []
  const processes = new Set<ReturnType<typeof spawn>>()

  afterEach(async () => {
    for (const proc of processes) {
      if (proc.exitCode === null) proc.kill("SIGTERM")
      await proc.exited
    }
    processes.clear()
    for (const directory of cleanup.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("continues the same Pi session after the adaptor process restarts", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "opencode-session-restart-"))
    cleanup.push(stateDirectory)
    const databasePath = join(stateDirectory, "adaptor.db")
    const piSessionDirectory = join(stateDirectory, "pi-sessions")
    const port = reserveFreePort()
    const password = randomUUID()
    const baseUrl = `http://127.0.0.1:${port}`
    const authHeader = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")

    const startServer = async (): Promise<ReturnType<typeof spawn>> => {
      const proc = spawn({
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
          DATABASE_PATH: databasePath,
          PI_SESSION_DIR: piSessionDirectory,
          PI_CLI_PATH: `${BUN_BIN} ${FAKE_PI_PATH}`,
        },
      })
      processes.add(proc)

      for (let attempt = 0; attempt < 100; attempt++) {
        if (proc.exitCode !== null) {
          throw new Error(`Server exited before becoming healthy with code ${proc.exitCode}`)
        }
        await Bun.sleep(200)
        try {
          const response = await fetch(`${baseUrl}/api/health`, {
            headers: { Authorization: authHeader },
          })
          if (response.ok) return proc
        } catch {
          // Retry until the listener is ready.
        }
      }
      throw new Error("Server did not become healthy")
    }

    const stopServer = async (proc: ReturnType<typeof spawn>): Promise<void> => {
      if (proc.exitCode === null) proc.kill("SIGTERM")
      await proc.exited
      processes.delete(proc)
    }

    const sendPrompt = async (sessionId: string, text: string): Promise<void> => {
      const response = await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      })
      expect(response.status).toBe(204)
    }

    const waitForIdle = async (sessionId: string): Promise<void> => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const response = await fetch(`${baseUrl}/session/status`, {
          headers: { Authorization: authHeader },
        })
        const statuses = (await response.json()) as Record<string, { type: string }>
        if (statuses[sessionId]?.type === "idle") return
        await Bun.sleep(100)
      }
      throw new Error(`Session ${sessionId} did not become idle`)
    }

    let proc = await startServer()
    const createResponse = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Restart recovery", agent: "pi" }),
    })
    expect(createResponse.ok).toBe(true)
    const session = (await createResponse.json()) as { id: string }
    const marker = `RESTART_CONTEXT_${randomUUID()}`

    await sendPrompt(session.id, marker)
    await waitForIdle(session.id)
    expect(readdirSync(piSessionDirectory).filter((name) => name.endsWith(".fake.json"))).toHaveLength(1)
    await stopServer(proc)

    proc = await startServer()
    const restoredSessionResponse = await fetch(`${baseUrl}/session/${session.id}`, {
      headers: { Authorization: authHeader },
    })
    expect(restoredSessionResponse.ok).toBe(true)

    const rejectedWithoutEvents = await fetch(`${baseUrl}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ parts: [{ type: "text", text: "__must_not_be_persisted__" }] }),
    })
    expect(rejectedWithoutEvents.status).toBe(409)
    expect(await rejectedWithoutEvents.json()).toEqual({
      _tag: "ConflictError",
      message: "Cannot continue a session from a previous adaptor run before the client event stream is connected",
    })

    const eventResponse = await fetch(`${baseUrl}/global/event`, {
      headers: { Authorization: authHeader },
    })
    expect(eventResponse.ok).toBe(true)
    const eventReader = eventResponse.body!.getReader()
    expect(new TextDecoder().decode((await eventReader.read()).value)).toContain("server.connected")

    await sendPrompt(session.id, "__recall_previous_prompt__")
    await waitForIdle(session.id)

    const messagesResponse = await fetch(`${baseUrl}/session/${session.id}/message`, {
      headers: { Authorization: authHeader },
    })
    const messages = (await messagesResponse.json()) as Array<{
      info: { role: string }
      parts: Array<{ type: string; text?: string }>
    }>
    const assistants = messages.filter((message) => message.info.role === "assistant")
    const restoredText = assistants
      .at(-1)!
      .parts.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")

    expect(messages.length).toBeGreaterThanOrEqual(4)
    expect(
      messages.some((message) =>
        message.parts.some((part) => part.type === "text" && part.text === "__must_not_be_persisted__"),
      ),
    ).toBe(false)
    expect(restoredText).toContain(marker)
    expect(readdirSync(piSessionDirectory).filter((name) => name.endsWith(".fake.json"))).toHaveLength(1)
    await eventReader.cancel()
    await stopServer(proc)
  }, 30000)
})
