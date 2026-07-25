import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reserveFreePort } from "../helpers/free-port.ts"

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")

describe("OpenCode v2 protocol", () => {
  let processHandle: ReturnType<typeof spawn>
  let baseUrl: string
  let authorization: string
  let sessionID: string
  let userMessageID: string
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
    configDirectory = mkdtempSync(join(tmpdir(), "opencode-v2-contract-"))
    const providerConfigPath = join(configDirectory, "providers.yaml")
    writeFileSync(
      providerConfigPath,
      "provider:\n  v2-auth:\n    name: V2 Auth\n    models:\n      model:\n        name: Model\n",
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

  test("health, location, agents, models, and providers use v2 envelopes", async () => {
    const [health, location, agents, models, defaultModel, providers, projects, currentProject, plugins] =
      await Promise.all([
        request("/api/health").then((response) => response.json()),
        request(`/api/location?location%5Bdirectory%5D=${encodeURIComponent(process.cwd())}`).then((response) =>
          response.json(),
        ),
        request("/api/agent").then((response) => response.json()),
        request("/api/model").then((response) => response.json()),
        request("/api/model/default").then((response) => response.json()),
        request("/api/provider").then((response) => response.json()),
        request("/api/project").then((response) => response.json()),
        request(`/api/project/current?location%5Bdirectory%5D=${encodeURIComponent(process.cwd())}`).then((response) =>
          response.json(),
        ),
        request("/api/plugin").then((response) => response.json()),
      ])
    expect((health as { healthy: boolean; version: string; pid: number }).healthy).toBe(true)
    expect((health as { healthy: boolean; version: string; pid: number }).version).toBe("1.18.7")
    expect((health as { healthy: boolean; version: string; pid: number }).pid).toBe(processHandle.pid)
    expect((await request("/global/health")).status).toBe(404)
    expect((location as { project: { directory: string } }).project.directory).toBe(process.cwd())
    const agentData = (
      agents as {
        data: Array<{
          id: string
          name: string
          mode: string
          request: { settings?: Record<string, unknown> }
        }>
      }
    ).data
    const stubAgent = agentData.find((agent) => agent.id === "stub")
    expect(new Set(agentData.map((agent) => agent.id)).size).toBe(agentData.length)
    expect(stubAgent?.name).toBeString()
    expect(stubAgent?.mode).toBe("primary")
    expect(stubAgent?.request.settings).toEqual({})
    expect(
      typeof stubAgent?.request.settings?.temperature === "number" ? stubAgent.request.settings.temperature : undefined,
    ).toBeUndefined()
    const model = (models as { data: Array<{ id: string; modelID: string; providerID: string }> }).data.find(
      (candidate) => candidate.providerID === "pi",
    )
    expect(model?.modelID).toBeString()
    expect((defaultModel as { data: { id: string } | null }).data?.id).toBeString()
    const provider = (providers as { data: Array<{ id: string; package: string }> }).data.find(
      (candidate) => candidate.id === "pi",
    )
    expect(provider?.package).toBeString()
    expect(Array.isArray(projects)).toBe(true)
    expect((currentProject as { directory: string }).directory).toBe(process.cwd())
    expect((plugins as { data: unknown[] }).data).toEqual([])

    const providerResponse = await request("/api/provider/pi")
    expect(providerResponse.ok).toBe(true)
    expect(((await providerResponse.json()) as { data: { id: string } }).data.id).toBe("pi")
  })

  test("v1 discovery and business routes are not registered", async () => {
    const paths = ["/global/health", "/global/event", "/event", "/session", "/agent", "/provider"]
    const responses = await Promise.all(paths.map((path) => request(path)))
    expect(responses.map((response) => response.status)).toEqual(paths.map(() => 404))
  })

  test("Desktop v2 reload endpoints all return their declared success status", async () => {
    const current = (await (
      await request(`/api/project/current?location%5Bdirectory%5D=${encodeURIComponent(process.cwd())}`)
    ).json()) as { id: string }
    const responses = await Promise.all([
      request("/api/model/default"),
      request("/api/project"),
      request(`/api/project/current?location%5Bdirectory%5D=${encodeURIComponent(process.cwd())}`),
      request(
        `/api/project/${encodeURIComponent(current.id)}/directories?location%5Bdirectory%5D=${encodeURIComponent(process.cwd())}`,
      ),
      request(`/api/mcp?location%5Bdirectory%5D=${encodeURIComponent(process.cwd())}`),
      request(`/api/mcp/resource?location%5Bdirectory%5D=${encodeURIComponent(process.cwd())}`),
      request(`/api/command?location%5Bdirectory%5D=${encodeURIComponent(process.cwd())}`),
      request(`/api/reference?location%5Bdirectory%5D=${encodeURIComponent(process.cwd())}`),
      request(`/api/permission/request?location%5Bdirectory%5D=${encodeURIComponent(process.cwd())}`),
      request(`/api/question/request?location%5Bdirectory%5D=${encodeURIComponent(process.cwd())}`),
    ])
    expect(responses.map((response) => response.status)).toEqual(Array(responses.length).fill(200))

    const mcp = (await responses[4]!.json()) as { data: unknown[] }
    const resources = (await responses[5]!.json()) as { data: { resources: unknown[]; templates: unknown[] } }
    expect(mcp.data).toEqual([])
    expect(resources.data).toEqual({ resources: [], templates: [] })
  })

  test("session create, get, list, agent/model switches, and active list", async () => {
    const created = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({
        agent: "stub",
        model: { id: "default", providerID: "pi" },
        location: { directory: process.cwd() },
      }),
    })
    expect(created.ok).toBe(true)
    const createdBody = (await created.json()) as { data: { id: string; location: { directory: string } } }
    sessionID = createdBody.data.id
    expect(createdBody.data.location.directory).toBe(process.cwd())

    const switchedAgent = await request(`/api/session/${sessionID}/agent`, {
      method: "POST",
      body: JSON.stringify({ agent: "stub" }),
    })
    expect(switchedAgent.status).toBe(204)
    const switchedModel = await request(`/api/session/${sessionID}/model`, {
      method: "POST",
      body: JSON.stringify({ model: { id: "qwen-selected", providerID: "pi" } }),
    })
    expect(switchedModel.status).toBe(204)

    const [get, list, active] = await Promise.all([
      request(`/api/session/${sessionID}`).then((response) => response.json()),
      request("/api/session?limit=10&order=desc").then((response) => response.json()),
      request("/api/session/active").then((response) => response.json()),
    ])
    expect((get as { data: { id: string; model: { id: string; providerID: string } } }).data.id).toBe(sessionID)
    expect((get as { data: { model: { id: string; providerID: string } } }).data.model).toEqual({
      id: "qwen-selected",
      providerID: "pi",
    })
    expect((list as { data: Array<{ id: string }> }).data.some((session) => session.id === sessionID)).toBe(true)
    expect((active as { data: Record<string, unknown> }).data).toEqual({})
  })

  test("session cursors page forward and backward without repeating query filters", async () => {
    for (let index = 0; index < 3; index++) {
      const created = await request("/api/session", {
        method: "POST",
        body: JSON.stringify({
          id: `ses_v2_page_${index}`,
          agent: "stub",
          model: { id: "default", providerID: "pi" },
          location: { directory: process.cwd() },
        }),
      })
      expect(created.ok).toBe(true)
      await Bun.sleep(2)
    }
    const first = (await (await request("/api/session?limit=2&order=asc")).json()) as {
      data: Array<{ id: string }>
      cursor: { previous: string; next: string }
    }
    const second = (await (
      await request(`/api/session?limit=2&cursor=${encodeURIComponent(first.cursor.next)}`)
    ).json()) as {
      data: Array<{ id: string }>
      cursor: { previous: string }
    }
    expect(second.data.some((session) => first.data.some((firstSession) => firstSession.id === session.id))).toBe(false)
    const previous = (await (
      await request(`/api/session?limit=2&cursor=${encodeURIComponent(second.cursor.previous)}`)
    ).json()) as { data: Array<{ id: string }> }
    expect(previous.data.map((session) => session.id)).toEqual(first.data.map((session) => session.id))
  })

  test("prompt admission executes the shared agent flow and projects v2 messages", async () => {
    const prompted = await request(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        id: `msg_${Date.now().toString(36)}v2prompt`,
        text: "v2 protocol prompt",
        files: [
          {
            uri: "file:///tmp/example.txt",
            name: "example.txt",
            mention: { start: 0, end: 12, text: "@example.txt" },
          },
        ],
        agents: [{ name: "stub", mention: { start: 13, end: 18, text: "@stub" } }],
        delivery: "steer",
      }),
    })
    expect(prompted.ok).toBe(true)
    const admission = (await prompted.json()) as {
      data: { id: string; admittedSeq: number; promotedSeq?: number; delivery: string }
    }
    userMessageID = admission.data.id
    expect(admission.data.admittedSeq).toBeGreaterThan(0)
    expect(admission.data.promotedSeq).toBeGreaterThan(admission.data.admittedSeq)
    expect(admission.data.delivery).toBe("steer")

    const waited = await request(`/api/session/${sessionID}/wait`, { method: "POST" })
    expect(waited.status).toBe(204)

    const messagesResponse = await request(`/api/session/${sessionID}/message?limit=20&order=asc`)
    expect(messagesResponse.ok).toBe(true)
    const messages = (await messagesResponse.json()) as {
      data: Array<{
        id: string
        type: string
        text?: string
        model?: { id: string; providerID: string }
        content?: Array<{ type: string; text?: string }>
      }>
      cursor: { next?: string }
    }
    const user = messages.data.find((message) => message.id === userMessageID)
    const assistant = messages.data.find((message) => message.type === "assistant")
    expect(user?.type).toBe("user")
    expect(user?.text).toContain("v2 protocol prompt")
    expect(
      assistant?.content?.some((content) => content.type === "text" && content.text?.includes("stub response")),
    ).toBe(true)
    expect(assistant?.model).toEqual({ id: "qwen-selected", providerID: "pi" })
    expect(messages.cursor).toBeDefined()

    const single = await request(`/api/session/${sessionID}/message/${userMessageID}`)
    expect(single.ok).toBe(true)
    expect(((await single.json()) as { data: { type: string } }).data.type).toBe("user")
  })

  test("prompt admission also accepts the newer nested prompt envelope", async () => {
    const response = await request(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        id: `msg_${Date.now().toString(36)}nested`,
        prompt: {
          text: "nested v2 protocol prompt",
          files: [],
          agents: [],
        },
        delivery: "steer",
        resume: false,
      }),
    })
    expect(response.ok).toBe(true)
    const body = (await response.json()) as { data: { prompt: { text: string } } }
    expect(body.data.prompt.text).toBe("nested v2 protocol prompt")
  })

  test("context, durable history, and interrupt are available", async () => {
    const [context, history, interrupt] = await Promise.all([
      request(`/api/session/${sessionID}/context`),
      request(`/api/session/${sessionID}/history?after=0&limit=100`),
      request(`/api/session/${sessionID}/interrupt`, { method: "POST" }),
    ])
    expect(context.ok).toBe(true)
    expect(((await context.json()) as { data: unknown[] }).data.length).toBeGreaterThanOrEqual(2)
    expect(history.ok).toBe(true)
    const historyBody = (await history.json()) as {
      data: Array<{ type: string; durable: { seq: number } }>
      hasMore: boolean
    }
    expect(historyBody.data.some((event) => event.type === "session.next.prompt.admitted")).toBe(true)
    expect(
      historyBody.data.every(
        (event, index, events) => index === 0 || event.durable.seq > events[index - 1]!.durable.seq,
      ),
    ).toBe(true)
    expect(interrupt.status).toBe(204)
  })

  test("session event replay, compaction, and revert endpoints are wired", async () => {
    const stream = await request(`/api/session/${sessionID}/event?after=0`)
    expect(stream.ok).toBe(true)
    expect(stream.headers.get("content-type")).toContain("text/event-stream")
    const reader = stream.body!.getReader()
    const first = await reader.read()
    await reader.cancel()
    expect(new TextDecoder().decode(first.value)).toContain("session.next.prompt.admitted")

    expect((await request(`/api/session/${sessionID}/compact`, { method: "POST" })).status).toBe(400)
    expect(
      (
        await request(`/api/session/${sessionID}/revert/stage`, {
          method: "POST",
          body: JSON.stringify({ messageID: userMessageID }),
        })
      ).status,
    ).toBe(400)
    expect((await request(`/api/session/${sessionID}/revert/clear`, { method: "POST" })).status).toBe(204)
    expect((await request(`/api/session/${sessionID}/revert/commit`, { method: "POST" })).status).toBe(204)
  })

  test("permission and question interfaces return v2 envelopes and typed errors", async () => {
    const [globalPermissions, sessionPermissions, questions, sessionQuestions] = await Promise.all([
      request("/api/permission/request").then((response) => response.json()),
      request(`/api/session/${sessionID}/permission`).then((response) => response.json()),
      request("/api/question/request").then((response) => response.json()),
      request(`/api/session/${sessionID}/question`).then((response) => response.json()),
    ])
    expect((globalPermissions as { data: unknown[] }).data).toEqual([])
    expect((sessionPermissions as { data: unknown[] }).data).toEqual([])
    expect((questions as { data: unknown[] }).data).toEqual([])
    expect((sessionQuestions as { data: unknown[] }).data).toEqual([])

    const created = await request(`/api/session/${sessionID}/permission`, {
      method: "POST",
      body: JSON.stringify({
        id: "per_v2_contract",
        action: "bash",
        resources: ["echo"],
        metadata: { command: "echo" },
      }),
    })
    expect(created.ok).toBe(true)
    expect(((await created.json()) as { data: { effect: string } }).data.effect).toBe("ask")
    expect((await request(`/api/session/${sessionID}/permission/per_v2_contract`)).ok).toBe(true)
    expect(
      (
        await request(`/api/session/${sessionID}/permission/per_v2_contract/reply`, {
          method: "POST",
          body: JSON.stringify({ reply: "once" }),
        })
      ).status,
    ).toBe(204)

    const missing = await request(`/api/session/${sessionID}/permission/missing/reply`, {
      method: "POST",
      body: JSON.stringify({ reply: "reject" }),
    })
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { _tag: string })._tag).toBe("PermissionNotFoundError")
    expect(((await (await request("/api/permission/saved")).json()) as { data: unknown[] }).data).toEqual([])
    expect((await request("/api/permission/saved/missing", { method: "DELETE" })).status).toBe(204)

    expect(
      (
        await request(`/api/session/${sessionID}/question/missing/reply`, {
          method: "POST",
          body: JSON.stringify({ answers: [] }),
        })
      ).status,
    ).toBe(204)
    expect(
      (
        await request(`/api/session/${sessionID}/question/missing/reject`, {
          method: "POST",
        })
      ).status,
    ).toBe(204)
  })

  test("integration key and credential endpoints mirror provider authentication", async () => {
    const integrations = (await (await request("/api/integration")).json()) as {
      data: Array<{ id: string }>
    }
    expect(integrations.data.some((integration) => integration.id === "v2-auth")).toBe(true)
    expect((await request("/api/integration/v2-auth")).ok).toBe(true)
    expect(
      (
        await request("/api/integration/v2-auth/connect/key", {
          method: "POST",
          body: JSON.stringify({ key: "sk-v2-contract", label: "test" }),
        })
      ).status,
    ).toBe(204)
    const connected = (await (await request("/api/integration/v2-auth")).json()) as {
      data: { connections: Array<{ id: string }> }
    }
    expect(connected.data.connections[0]?.id).toBe("credential_v2-auth")
    expect(
      (
        await request("/api/credential/credential_v2-auth", {
          method: "PATCH",
          body: JSON.stringify({ label: "renamed" }),
        })
      ).status,
    ).toBe(204)
    expect((await request("/api/credential/credential_v2-auth", { method: "DELETE" })).status).toBe(204)
    const disconnected = (await (await request("/api/integration/v2-auth")).json()) as {
      data: { connections: unknown[] }
    }
    expect(disconnected.data.connections).toEqual([])
  })

  test("integration OAuth attempts implement create, poll, complete, and cancel", async () => {
    const started = await request("/api/integration/v2-auth/connect/oauth", {
      method: "POST",
      body: JSON.stringify({ methodID: "oauth", inputs: {}, label: "oauth test" }),
    })
    expect(started.ok).toBe(true)
    const attempt = (await started.json()) as {
      data: { attemptID: string; mode: string; time: { expires: number } }
    }
    expect(attempt.data.mode).toBe("code")
    expect(attempt.data.time.expires).toBeGreaterThan(Date.now())

    const pending = (await (await request(`/api/integration/attempt/${attempt.data.attemptID}`)).json()) as {
      data: { status: string }
    }
    expect(pending.data.status).toBe("pending")
    expect(
      (
        await request(`/api/integration/attempt/${attempt.data.attemptID}/complete`, {
          method: "POST",
          body: JSON.stringify({ code: "oauth-code" }),
        })
      ).status,
    ).toBe(204)
    const complete = (await (await request(`/api/integration/attempt/${attempt.data.attemptID}`)).json()) as {
      data: { status: string }
    }
    expect(complete.data.status).toBe("complete")
    expect((await request(`/api/integration/attempt/${attempt.data.attemptID}`, { method: "DELETE" })).status).toBe(204)
    expect((await request("/api/credential/credential_v2-auth", { method: "DELETE" })).status).toBe(204)
  })

  test("filesystem, command, skill, and reference interfaces use location envelopes", async () => {
    const encodedDirectory = encodeURIComponent(process.cwd())
    const [list, find, command, skill, reference, read] = await Promise.all([
      request(`/api/fs/list?location%5Bdirectory%5D=${encodedDirectory}&path=.`),
      request(`/api/fs/find?location%5Bdirectory%5D=${encodedDirectory}&query=package&limit=10`),
      request(`/api/command?location%5Bdirectory%5D=${encodedDirectory}`),
      request(`/api/skill?location%5Bdirectory%5D=${encodedDirectory}`),
      request(`/api/reference?location%5Bdirectory%5D=${encodedDirectory}`),
      request(`/api/fs/read/package.json?location%5Bdirectory%5D=${encodedDirectory}`),
    ])
    expect(((await list.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0)
    expect(((await find.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0)
    expect(((await command.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0)
    expect(((await skill.json()) as { data: unknown[] }).data).toEqual([])
    expect(((await reference.json()) as { data: unknown[] }).data).toEqual([])
    expect(read.ok).toBe(true)
    expect(await read.text()).toContain("opencode-server-adaptor")
  })

  test("PTY compatibility implements the full v2 CRUD surface", async () => {
    const created = await request("/api/pty", {
      method: "POST",
      body: JSON.stringify({ command: "bash", args: ["-l"], title: "v2 terminal" }),
    })
    expect(created.ok).toBe(true)
    const pty = (await created.json()) as { data: { id: string; title: string; pid: number } }
    const ptyID = pty.data.id
    expect(pty.data.pid).toBeGreaterThan(0)

    expect(((await (await request("/api/pty")).json()) as { data: unknown[] }).data.length).toBe(1)
    expect((await request(`/api/pty/${ptyID}`)).ok).toBe(true)
    const updated = await request(`/api/pty/${ptyID}`, {
      method: "PUT",
      body: JSON.stringify({ title: "renamed" }),
    })
    expect(((await updated.json()) as { data: { title: string } }).data.title).toBe("renamed")
    expect((await request(`/api/pty/${ptyID}`, { method: "DELETE" })).status).toBe(204)
    expect((await request(`/api/pty/${ptyID}`)).status).toBe(404)
  })

  test("PTY connect tickets are scoped, short-lived, and single-use", async () => {
    const created = await request("/api/pty", {
      method: "POST",
      body: JSON.stringify({ command: "bash", title: "ticket terminal" }),
    })
    const ptyID = ((await created.json()) as { data: { id: string } }).data.id
    const token = await request(`/api/pty/${ptyID}/connect-token`, {
      method: "POST",
      headers: { "x-opencode-ticket": "1" },
    })
    expect(token.ok).toBe(true)
    const ticket = ((await token.json()) as { data: { ticket: string; expires_in: number } }).data
    expect(ticket.expires_in).toBeGreaterThan(0)
    const marker = `PTY_V2_${randomUUID()}`
    const output = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(
        `${baseUrl.replace(/^http/, "ws")}/api/pty/${ptyID}/connect?ticket=${encodeURIComponent(ticket.ticket)}`,
      )
      let received = ""
      const timeout = setTimeout(() => {
        socket.close()
        reject(new Error("Timed out waiting for PTY output"))
      }, 10_000)
      socket.addEventListener("open", () => socket.send(`printf '${marker}\\n'\n`))
      socket.addEventListener("message", async (event) => {
        const data =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(
                event.data instanceof ArrayBuffer
                  ? new Uint8Array(event.data)
                  : ArrayBuffer.isView(event.data)
                    ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
                    : new Uint8Array(await event.data.arrayBuffer()),
              )
        if (data.charCodeAt(0) === 0) return
        received += data
        if (!received.includes(marker)) return
        clearTimeout(timeout)
        socket.close()
        resolve(received)
      })
      socket.addEventListener("error", () => {
        clearTimeout(timeout)
        reject(new Error("PTY WebSocket connection failed"))
      })
    })
    expect(output).toContain(marker)
    expect((await request(`/api/pty/${ptyID}/connect?ticket=${encodeURIComponent(ticket.ticket)}`)).status).toBe(403)
    expect((await request(`/api/pty/${ptyID}`, { method: "DELETE" })).status).toBe(204)
  })

  test("project copy routes create, refresh, and remove a git worktree", async () => {
    const encodedDirectory = encodeURIComponent(process.cwd())
    const project = (await (
      await request(`/api/project/current?location%5Bdirectory%5D=${encodedDirectory}`)
    ).json()) as { id: string }
    const copiesDirectory = join(configDirectory, "copies")
    const created = await request(
      `/experimental/project/${encodeURIComponent(project.id)}/copy?location%5Bdirectory%5D=${encodedDirectory}`,
      {
        method: "POST",
        body: JSON.stringify({ strategy: "git-worktree", directory: copiesDirectory, name: "contract-copy" }),
      },
    )
    expect(created.ok).toBe(true)
    const copy = (await created.json()) as { directory: string }
    expect(copy.directory).toBe(join(copiesDirectory, "contract-copy"))
    expect(
      (
        await request(
          `/experimental/project/${encodeURIComponent(project.id)}/copy/refresh?location%5Bdirectory%5D=${encodedDirectory}`,
          { method: "POST" },
        )
      ).status,
    ).toBe(204)
    expect(
      (
        await request(
          `/experimental/project/${encodeURIComponent(project.id)}/copy?location%5Bdirectory%5D=${encodedDirectory}`,
          {
            method: "DELETE",
            body: JSON.stringify({ directory: copy.directory, force: true }),
          },
        )
      ).status,
    ).toBe(204)
  })

  test("invalid requests use v2 tagged errors", async () => {
    const missing = await request("/api/session/ses_missing")
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { _tag: string })._tag).toBe("SessionNotFoundError")

    const invalidCursor = await request("/api/session?cursor=invalid")
    expect(invalidCursor.status).toBe(400)
    expect(((await invalidCursor.json()) as { _tag: string })._tag).toBe("InvalidCursorError")
  })
})
