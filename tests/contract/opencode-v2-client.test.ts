import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawn } from "bun"
import { reserveFreePort } from "../helpers/free-port.ts"

const CLI_PATH = resolve(import.meta.dir, "..", "..", "src", "cli.ts")
const OPENCODE_APP_PACKAGE = resolve(import.meta.dir, "..", "..", "..", "opencode", "packages", "app", "package.json")
const CLIENT_ENTRY = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "opencode",
  "packages",
  "app",
  "node_modules",
  "@opencode-ai",
  "client",
  "dist",
  "promise",
  "index.js",
)
const HAS_OPENCODE_V2_CLIENT = existsSync(OPENCODE_APP_PACKAGE) && existsSync(CLIENT_ENTRY)

/**
 * Version of the packaged OpenCode Desktop client under test. Read dynamically so
 * the contract suite tracks whatever the external opencode repository currently
 * packages instead of pinning a hardcoded number that rots on every client bump.
 */
const OPENCODE_APP_VERSION = HAS_OPENCODE_V2_CLIENT
  ? (JSON.parse(readFileSync(OPENCODE_APP_PACKAGE, "utf8")) as { version: string }).version
  : undefined

describe.skipIf(!HAS_OPENCODE_V2_CLIENT)(`OpenCode ${OPENCODE_APP_VERSION} Desktop packaged v2 client`, () => {
  let processHandle: ReturnType<typeof spawn>
  let api: any
  const directory = process.cwd()

  beforeAll(async () => {
    const port = reserveFreePort()
    processHandle = spawn({
      cmd: [
        process.execPath,
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
      },
    })

    const { OpenCode } = await import(CLIENT_ENTRY)
    const baseUrl = `http://127.0.0.1:${port}`
    api = OpenCode.make({ baseUrl })
    for (let attempt = 0; attempt < 50; attempt++) {
      await Bun.sleep(100)
      try {
        const health = await api.health.get()
        if (health.healthy) return
      } catch {}
    }
    throw new Error("Server did not become healthy")
  }, 30_000)

  afterAll(async () => {
    if (!processHandle) return
    processHandle.kill("SIGTERM")
    await processHandle.exited
  })

  test("Desktop reload calls and Agent normalization complete without UnexpectedStatus", async () => {
    expect(OPENCODE_APP_VERSION).toMatch(/^\d+\.\d+\.\d+/)
    const location = { directory }
    const [agents, models, defaultModel, providers, projects, current, mcp, resources] = await Promise.all([
      api.agent.list({ location }),
      api.model.list({ location }),
      api.model.default({ location }),
      api.provider.list({ location }),
      api.project.list(),
      api.project.current({ location }),
      api.mcp.list({ location }),
      api.mcp.resource.catalog({ location }),
    ])

    const normalized = agents.data.map((agent: any) => ({
      id: agent.id,
      mode: agent.mode,
      temperature:
        typeof agent.request.settings.temperature === "number" ? agent.request.settings.temperature : undefined,
      topP: typeof agent.request.settings.topP === "number" ? agent.request.settings.topP : undefined,
    }))

    expect(new Set(normalized.map((agent: { id: string }) => agent.id)).size).toBe(normalized.length)
    expect(normalized.find((agent: { id: string }) => agent.id === "pi")?.mode).toBe("primary")
    expect(normalized.find((agent: { id: string }) => agent.id === "plan")?.mode).toBe("primary")
    expect(agents.data.find((agent: { id: string }) => agent.id === "pi")?.name).toBe("Pi Agent")
    expect(models.data.length).toBeGreaterThan(0)
    expect(defaultModel.data?.id).toBeString()
    expect(providers.data.length).toBeGreaterThan(0)
    expect(projects.length).toBeGreaterThan(0)
    expect(current.directory).toBe(directory)
    expect(mcp.data).toEqual([])
    expect(resources.data).toEqual({ resources: [], templates: [] })

    const session = await api.session.create({
      agent: "pi",
      model: {
        id: defaultModel.data.id,
        providerID: defaultModel.data.providerID,
      },
      location,
    })
    const admitted = await api.session.prompt({
      sessionID: session.id,
      id: `msg_desktop_${Date.now()}`,
      text: "Desktop flat prompt",
      files: [
        {
          uri: "file:///tmp/desktop.txt",
          name: "desktop.txt",
          mention: { start: 0, end: 12, text: "@desktop.txt" },
        },
      ],
      agents: [
        {
          name: "general",
          mention: { start: 13, end: 21, text: "@general" },
        },
      ],
      delivery: "steer",
      resume: false,
    })

    expect(admitted.prompt.text).toContain("Desktop flat prompt")
    expect(admitted.prompt.files?.[0]?.uri).toBe("file:///tmp/desktop.txt")
    expect(admitted.prompt.agents?.[0]?.name).toBe("general")
  })

  test("Desktop event client receives the established message event stream in generation order", async () => {
    const location = { directory }
    const defaultModel = await api.model.default({ location })
    const session = await api.session.create({
      agent: "stub",
      model: {
        id: defaultModel.data.id,
        providerID: defaultModel.data.providerID,
      },
      location,
    })
    const controller = new AbortController()
    const events: Array<{ type: string; data: Record<string, any> }> = []
    const read = (async () => {
      for await (const event of api.event.subscribe({ signal: controller.signal })) {
        if (event.data?.sessionID !== session.id) continue
        events.push(event as { type: string; data: Record<string, any> })
        if (
          event.type === "message.updated" &&
          event.data.info?.role === "assistant" &&
          event.data.info?.time?.completed !== undefined
        ) {
          return
        }
      }
    })()

    try {
      await Bun.sleep(20)
      await api.session.prompt({
        sessionID: session.id,
        id: `msg_event_${Date.now()}`,
        text: "ordered v2 event stream",
        files: [],
        agents: [],
        delivery: "steer",
      })
      await Promise.race([
        read,
        Bun.sleep(5_000).then(() => {
          throw new Error("Timed out waiting for terminal assistant event")
        }),
      ])
      const user = events.findIndex((event) => event.type === "message.updated" && event.data.info?.role === "user")
      const assistant = events.findIndex(
        (event) =>
          event.type === "message.updated" &&
          event.data.info?.role === "assistant" &&
          event.data.info?.time?.completed === undefined,
      )
      const text = events.findIndex(
        (event) => event.type === "message.part.updated" && event.data.part?.type === "text",
      )
      expect(user).toBeGreaterThanOrEqual(0)
      expect(assistant).toBeGreaterThan(user)
      expect(text).toBeGreaterThan(assistant)
      const textPartIDs = new Set(
        events.filter((event) => event.data.part?.type === "text").map((event) => event.data.part.id),
      )
      expect(textPartIDs.size).toBe(1)
    } finally {
      controller.abort()
      await read.catch(() => {})
    }
  })
})
