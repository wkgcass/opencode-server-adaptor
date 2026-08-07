import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { reserveFreePort } from "../helpers/free-port.ts"

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")

/**
 * Exercises the @opencode-ai/sdk client against the slimmed-down v1 API surface.
 * v1 mode is a configuration + read-only inspection layer, so only SDK methods
 * that read data or manage provider/model config are covered. Session
 * create/prompt/abort/delete, file, command, vcs, lsp, and mcp methods are not
 * available in v1 mode and are not tested here.
 */
describe("v1 SDK client", () => {
  let port: number
  let password: string
  let proc: ReturnType<typeof spawn>
  let baseUrl: string
  let authHeader: string
  let client: any
  let stateDir: string

  beforeAll(async () => {
    port = reserveFreePort()
    password = randomUUID()
    stateDir = mkdtempSync(join(tmpdir(), "v1-sdk-client-"))

    writeFileSync(
      join(stateDir, "providers.yaml"),
      [
        "provider:",
        "  sdk-provider:",
        "    name: SDK Provider",
        "    models:",
        "      sdk-model:",
        "        name: SDK Model",
        "",
      ].join("\n"),
    )

    proc = spawn({
      cmd: [
        "bun",
        "run",
        CLI_PATH,
        "--log-level",
        "ERROR",
        "serve",
        "--api-version=v1",
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
        DEFAULT_AGENT: "stub",
        DATABASE_PATH: join(stateDir, "adaptor.db"),
        PROVIDER_CONFIG_PATH: join(stateDir, "providers.yaml"),
      },
    })

    baseUrl = `http://127.0.0.1:${port}`
    authHeader = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")

    for (let i = 0; i < 50; i++) {
      await Bun.sleep(200)
      try {
        const res = await fetch(`${baseUrl}/api/health`, { headers: { Authorization: authHeader } })
        if (res.ok) break
      } catch {
        // retry
      }
    }

    client = createOpencodeClient({ baseUrl, headers: { Authorization: authHeader } })
  }, 30000)

  afterAll(async () => {
    proc.kill("SIGTERM")
    await proc.exited
    rmSync(stateDir, { recursive: true, force: true })
  })

  describe("auth (provider API key)", () => {
    test("auth.set + auth.remove updates the configured provider", async () => {
      const setRes = await client.auth.set({
        providerID: "sdk-provider",
        auth: { type: "api", key: "sk-sdk-test" },
      })
      expect(setRes.data).toBe(true)

      const configRes = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
      const config = (await configRes.json()) as { provider: Record<string, { apiKey?: string }> }
      expect(config.provider["sdk-provider"]?.apiKey).toBe("sk-sdk-test")

      const delRes = await client.auth.remove({ providerID: "sdk-provider" })
      expect(delRes.data).toBe(true)

      const afterDelete = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
      const afterConfig = (await afterDelete.json()) as { provider: Record<string, { apiKey?: string }> }
      expect(afterConfig.provider["sdk-provider"]?.apiKey).toBeUndefined()
    })
  })

  describe("read-only inspection", () => {
    test("session.list() returns array", async () => {
      const res = await client.session.list()
      expect(Array.isArray(res.data)).toBe(true)
    })

    test("app.agents() returns array", async () => {
      const res = await client.app.agents()
      expect(Array.isArray(res.data)).toBe(true)
    })

    test("project.list() returns array", async () => {
      const res = await client.project.list()
      expect(Array.isArray(res.data)).toBe(true)
    })
  })
})
