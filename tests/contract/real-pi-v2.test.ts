import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { reserveFreePort } from "../helpers/free-port.ts"

const RUN_REAL_PI = process.env.RUN_REAL_PI_TESTS === "1"
const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")
const BUN_BIN = join(homedir(), ".bun", "bin", "bun")
const PI_BIN = join(homedir(), ".bun", "bin", "pi")
const PI_MODELS_PATH = join(homedir(), ".pi", "agent", "models.json")

function configuredModel(): { providerID: string; id: string } {
  const providerOverride = process.env.REAL_PI_PROVIDER?.trim()
  const modelOverride = process.env.REAL_PI_MODEL?.trim()
  if (providerOverride || modelOverride) {
    if (!providerOverride || !modelOverride) {
      throw new Error("REAL_PI_PROVIDER and REAL_PI_MODEL must be set together")
    }
    return { providerID: providerOverride, id: modelOverride }
  }
  const parsed = JSON.parse(readFileSync(PI_MODELS_PATH, "utf8")) as {
    providers: Record<string, { models?: Array<{ id?: string }> }>
  }
  for (const [providerID, provider] of Object.entries(parsed.providers)) {
    const model = provider.models?.find((candidate) => candidate.id?.trim())
    if (model?.id) return { providerID, id: model.id }
  }
  throw new Error(`No model found in ${PI_MODELS_PATH}`)
}

describe.skipIf(!RUN_REAL_PI)("OpenCode v2 real Pi model", () => {
  let processHandle: ReturnType<typeof spawn>
  let stateDirectory: string
  let baseUrl: string
  let authorization: string
  let model: { providerID: string; id: string }

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
    if (!existsSync(BUN_BIN) || !existsSync(PI_BIN) || !existsSync(PI_MODELS_PATH)) {
      throw new Error("Real Pi prerequisites are missing")
    }
    model = configuredModel()
    stateDirectory = mkdtempSync(join(tmpdir(), "real-pi-v2-"))
    const port = reserveFreePort()
    const password = randomUUID()
    const providerConfigPath =
      process.env.REAL_PI_PROVIDER_CONFIG_PATH?.trim() || join(stateDirectory, "providers.yaml")
    const defaultProvider = process.env.REAL_PI_DEFAULT_PROVIDER?.trim() || model.providerID
    const defaultModel = process.env.REAL_PI_DEFAULT_MODEL?.trim() || model.id
    baseUrl = `http://127.0.0.1:${port}`
    authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    processHandle = spawn({
      cmd: [
        BUN_BIN,
        "run",
        CLI_PATH,
        "--log-level",
        "WARN",
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
        DATABASE_PATH: join(stateDirectory, "adaptor.db"),
        PROVIDER_CONFIG_PATH: providerConfigPath,
        PI_SESSION_DIR: join(stateDirectory, "pi-sessions"),
        PI_CLI_PATH: `${BUN_BIN} ${PI_BIN}`,
        PI_PROVIDER: defaultProvider,
        PI_MODEL: defaultModel,
        PATH: `${homedir()}/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
      },
    })
    for (let attempt = 0; attempt < 120; attempt++) {
      await Bun.sleep(500)
      try {
        if ((await request("/api/health")).ok) return
      } catch {}
    }
    throw new Error("Real Pi v2 server did not become healthy")
  }, 120_000)

  afterAll(async () => {
    if (processHandle) {
      processHandle.kill("SIGTERM")
      await processHandle.exited
    }
    if (stateDirectory) rmSync(stateDirectory, { recursive: true, force: true })
  })

  test("v2 prompt reaches the configured model and returns its projected answer", async () => {
    const created = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({
        agent: "pi",
        location: { directory: process.cwd() },
      }),
    })
    expect(created.ok).toBe(true)
    const sessionID = ((await created.json()) as { data: { id: string } }).data.id

    const switched = await request(`/api/session/${sessionID}/model`, {
      method: "POST",
      body: JSON.stringify({ model }),
    })
    expect(switched.status).toBe(204)

    const prompted = await request(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        text: "Reply with exactly V2_REAL_OK and nothing else.",
      }),
    })
    expect(prompted.ok).toBe(true)
    expect(((await prompted.json()) as { data: { admittedSeq: number } }).data.admittedSeq).toBeGreaterThan(0)

    const waited = await request(`/api/session/${sessionID}/wait`, { method: "POST" })
    expect(waited.status).toBe(204)
    const messages = (await (await request(`/api/session/${sessionID}/message?limit=20&order=asc`)).json()) as {
      data: Array<{
        type: string
        model?: { id: string; providerID: string }
        content?: Array<{ type: string; text?: string }>
      }>
    }
    const assistants = messages.data.filter((message) => message.type === "assistant")
    const output = assistants
      .flatMap((message) => message.content ?? [])
      .filter((content) => content.type === "text")
      .map((content) => content.text ?? "")
      .join("")
    expect(assistants.at(-1)?.model).toEqual(model)
    expect(output).toContain("V2_REAL_OK")
  }, 180_000)
})
