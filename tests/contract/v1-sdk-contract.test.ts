import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reserveFreePort } from "../helpers/free-port.ts"

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")

/**
 * Raw-fetch contract tests for the slimmed-down v1 API surface. v1 mode is a
 * configuration + read-only inspection layer: health, auth, provider/model
 * CRUD, project list, session list/content, agent list, provider+model list.
 */
describe("v1 SDK contract", () => {
  let port: number
  let password: string
  let proc: ReturnType<typeof spawn>
  let baseUrl: string
  let authHeader: string
  let stateDir: string

  beforeAll(async () => {
    port = reserveFreePort()
    password = randomUUID()
    stateDir = mkdtempSync(join(tmpdir(), "v1-contract-"))

    writeFileSync(
      join(stateDir, "providers.yaml"),
      [
        "provider:",
        "  contract-provider:",
        "    name: Contract Provider",
        "    models:",
        "      contract-model:",
        "        name: Contract Model",
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
    rmSync(stateDir, { recursive: true, force: true })
  })

  test("health check via raw fetch", async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { Authorization: authHeader } })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as { healthy: boolean; version: string }
    expect(body.healthy).toBe(true)
  })

  test("unauthorized without auth header", async () => {
    const res = await fetch(`${baseUrl}/session`)
    expect(res.status).toBe(401)
  })

  test("wrong password rejected", async () => {
    const res = await fetch(`${baseUrl}/session`, {
      headers: { Authorization: "Basic " + Buffer.from("opencode:wrong").toString("base64") },
    })
    expect(res.status).toBe(401)
  })

  test("list sessions via raw fetch", async () => {
    const res = await fetch(`${baseUrl}/session`, { headers: { Authorization: authHeader } })
    expect(res.ok).toBe(true)
    const sessions = (await res.json()) as unknown[]
    expect(Array.isArray(sessions)).toBe(true)
  })

  test("get unknown session returns 404", async () => {
    const res = await fetch(`${baseUrl}/session/nonexistent`, { headers: { Authorization: authHeader } })
    expect(res.status).toBe(404)
  })

  test("get unknown session messages returns 404", async () => {
    const res = await fetch(`${baseUrl}/session/nonexistent/message`, { headers: { Authorization: authHeader } })
    expect(res.status).toBe(404)
  })

  test("agent list returns array", async () => {
    const res = await fetch(`${baseUrl}/agent`, { headers: { Authorization: authHeader } })
    expect(res.ok).toBe(true)
    const agents = (await res.json()) as unknown[]
    expect(Array.isArray(agents)).toBe(true)
  })

  test("project list returns array", async () => {
    const res = await fetch(`${baseUrl}/project`, { headers: { Authorization: authHeader } })
    expect(res.ok).toBe(true)
    const projects = (await res.json()) as unknown[]
    expect(Array.isArray(projects)).toBe(true)
  })

  test("config returns provider and model info", async () => {
    const res = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
    expect(res.ok).toBe(true)
    const config = (await res.json()) as { provider: Record<string, unknown>; default_agent: string }
    expect(config.default_agent).toBeDefined()
    expect(config.provider["contract-provider"]).toBeDefined()
  })

  test("config/providers returns providers and default map", async () => {
    const res = await fetch(`${baseUrl}/config/providers`, { headers: { Authorization: authHeader } })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as { providers: unknown[]; default: Record<string, string> }
    expect(Array.isArray(body.providers)).toBe(true)
  })

  test("PATCH /config adds a provider", async () => {
    const res = await fetch(`${baseUrl}/config`, {
      method: "PATCH",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          "patched-provider": {
            name: "Patched",
            models: { "patched-model": { name: "Patched Model" } },
          },
        },
      }),
    })
    expect(res.ok).toBe(true)

    const configRes = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
    const config = (await configRes.json()) as { provider: Record<string, { name: string }> }
    expect(config.provider["patched-provider"]?.name).toBe("Patched")
  })

  test("DELETE /config/provider/:id removes a provider", async () => {
    await fetch(`${baseUrl}/config`, {
      method: "PATCH",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: { "to-delete": { name: "To Delete" } } }),
    })

    const res = await fetch(`${baseUrl}/config/provider/to-delete`, {
      method: "DELETE",
      headers: { Authorization: authHeader },
    })
    expect(res.ok).toBe(true)

    const configRes = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
    const config = (await configRes.json()) as { provider: Record<string, unknown> }
    expect(config.provider["to-delete"]).toBeUndefined()
  })

  test("DELETE /config/provider/:id/model/:modelID removes a model", async () => {
    await fetch(`${baseUrl}/config`, {
      method: "PATCH",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: { "model-test": { name: "MT", models: { keep: { name: "K" }, drop: { name: "D" } } } },
      }),
    })

    const res = await fetch(`${baseUrl}/config/provider/model-test/model/drop`, {
      method: "DELETE",
      headers: { Authorization: authHeader },
    })
    expect(res.ok).toBe(true)

    const configRes = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
    const config = (await configRes.json()) as {
      provider: Record<string, { models: Record<string, unknown> }>
    }
    expect(config.provider["model-test"]?.models["drop"]).toBeUndefined()
    expect(config.provider["model-test"]?.models["keep"]).toBeDefined()
  })

  test("PUT /auth/:providerID sets the API key", async () => {
    const res = await fetch(`${baseUrl}/auth/contract-provider`, {
      method: "PUT",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api", key: "sk-contract" }),
    })
    expect(res.ok).toBe(true)

    const configRes = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
    const config = (await configRes.json()) as { provider: Record<string, { apiKey?: string }> }
    expect(config.provider["contract-provider"]?.apiKey).toBe("sk-contract")
  })

  test("DELETE /auth/:providerID removes the API key", async () => {
    await fetch(`${baseUrl}/auth/contract-provider`, {
      method: "PUT",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api", key: "temp" }),
    })

    const res = await fetch(`${baseUrl}/auth/contract-provider`, {
      method: "DELETE",
      headers: { Authorization: authHeader },
    })
    expect(res.ok).toBe(true)

    const configRes = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
    const config = (await configRes.json()) as { provider: Record<string, { apiKey?: string }> }
    expect(config.provider["contract-provider"]?.apiKey).toBeUndefined()
  })

  test("deleted v1 endpoints return 404", async () => {
    const paths = [
      { method: "POST", path: "/session" },
      { method: "POST", path: "/session/abc/prompt_async" },
      { method: "POST", path: "/agent" },
      { method: "GET", path: "/command" },
      { method: "GET", path: "/permission" },
      { method: "GET", path: "/mcp" },
      { method: "GET", path: "/question" },
    ]
    for (const { method, path } of paths) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify({}),
      })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })
})
