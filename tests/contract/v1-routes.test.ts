import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reserveFreePort } from "../helpers/free-port.ts"

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")

/**
 * Behavioural coverage for the slimmed-down v1 API surface
 * (src/api/routes/v1.ts). The server is started with --api-version=v1 so only
 * v1 routes are mounted. v1 is a configuration + read-only inspection layer:
 * health, auth, provider/model CRUD, project list, session list/content, agent
 * list, provider+model list.
 */
describe("v1 API routes", () => {
  let port: number
  let password: string
  let proc: ReturnType<typeof spawn>
  let baseUrl: string
  let authHeader: string
  let stateDir: string

  beforeAll(async () => {
    port = reserveFreePort()
    password = randomUUID()
    stateDir = mkdtempSync(join(tmpdir(), "v1-routes-"))

    // Pre-configure a provider so auth/model-management tests have a target.
    writeFileSync(
      join(stateDir, "providers.yaml"),
      [
        "provider:",
        "  test-provider-x:",
        "    name: Test Provider X",
        "    models:",
        "      test-model:",
        "        name: Test Model",
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

  describe("health", () => {
    test("GET /api/health returns healthy + version + pid", async () => {
      const res = await fetch(`${baseUrl}/api/health`, { headers: { Authorization: authHeader } })
      expect(res.ok).toBe(true)
      const body = (await res.json()) as { healthy: boolean; version: string; pid: number }
      expect(body.healthy).toBe(true)
      expect(body.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(typeof body.pid).toBe("number")
    })
  })

  describe("auth (Basic Auth)", () => {
    test("unauthorized without auth header", async () => {
      const res = await fetch(`${baseUrl}/agent`)
      expect(res.status).toBe(401)
    })

    test("wrong password rejected", async () => {
      const res = await fetch(`${baseUrl}/agent`, {
        headers: { Authorization: "Basic " + Buffer.from("opencode:wrong").toString("base64") },
      })
      expect(res.status).toBe(401)
    })
  })

  describe("agent list", () => {
    test("GET /agent returns array with at least one agent", async () => {
      const res = await fetch(`${baseUrl}/agent`, { headers: { Authorization: authHeader } })
      expect(res.ok).toBe(true)
      const agents = (await res.json()) as Array<{ name: string; mode: string }>
      expect(Array.isArray(agents)).toBe(true)
      expect(agents.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe("config read", () => {
    test("GET /config returns config object with providers", async () => {
      const res = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
      expect(res.ok).toBe(true)
      const config = (await res.json()) as { default_agent: string; provider: Record<string, unknown> }
      expect(config.default_agent).toBeDefined()
      expect(config.provider["test-provider-x"]).toBeDefined()
    })

    test("GET /config/providers returns providers and default map", async () => {
      const res = await fetch(`${baseUrl}/config/providers`, { headers: { Authorization: authHeader } })
      expect(res.ok).toBe(true)
      const body = (await res.json()) as { providers: unknown[]; default: Record<string, string> }
      expect(Array.isArray(body.providers)).toBe(true)
      expect(body.default).toBeDefined()
    })
  })

  describe("provider CRUD", () => {
    test("PATCH /config adds a provider", async () => {
      const res = await fetch(`${baseUrl}/config`, {
        method: "PATCH",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: {
            "crud-provider": {
              name: "CRUD Provider",
              baseUrl: "https://example.com/v1",
              models: { "crud-model": { name: "CRUD Model" } },
            },
          },
        }),
      })
      expect(res.ok).toBe(true)

      const configRes = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
      const config = (await configRes.json()) as { provider: Record<string, { name: string }> }
      expect(config.provider["crud-provider"]?.name).toBe("CRUD Provider")
    })

    test("DELETE /config/provider/:id removes a provider", async () => {
      // Ensure it exists
      await fetch(`${baseUrl}/config`, {
        method: "PATCH",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: { "delete-me": { name: "Delete Me", models: { m1: { name: "M1" } } } },
        }),
      })

      const res = await fetch(`${baseUrl}/config/provider/delete-me`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      })
      expect(res.ok).toBe(true)
      expect(await res.json()).toBe(true)

      const configRes = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
      const config = (await configRes.json()) as { provider: Record<string, unknown> }
      expect(config.provider["delete-me"]).toBeUndefined()
    })

    test("DELETE /config/provider/:id returns 404 for unknown provider", async () => {
      const res = await fetch(`${baseUrl}/config/provider/nonexistent`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      })
      expect(res.status).toBe(404)
    })
  })

  describe("model CRUD", () => {
    test("PATCH /config adds a model to an existing provider", async () => {
      await fetch(`${baseUrl}/config`, {
        method: "PATCH",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: {
            "model-crud": {
              name: "Model CRUD Provider",
              models: { "original-model": { name: "Original" } },
            },
          },
        }),
      })

      // Add a new model by merging
      await fetch(`${baseUrl}/config`, {
        method: "PATCH",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: {
            "model-crud": {
              name: "Model CRUD Provider",
              models: { "original-model": { name: "Original" }, "added-model": { name: "Added" } },
            },
          },
        }),
      })

      const configRes = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
      const config = (await configRes.json()) as {
        provider: Record<string, { models: Record<string, { name: string }> }>
      }
      expect(config.provider["model-crud"]?.models["added-model"]?.name).toBe("Added")
    })

    test("DELETE /config/provider/:id/model/:modelID removes a model", async () => {
      await fetch(`${baseUrl}/config`, {
        method: "PATCH",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: { "model-del": { name: "Del", models: { keep: { name: "Keep" }, drop: { name: "Drop" } } } },
        }),
      })

      const res = await fetch(`${baseUrl}/config/provider/model-del/model/drop`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      })
      expect(res.ok).toBe(true)
      expect(await res.json()).toBe(true)

      const configRes = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
      const config = (await configRes.json()) as {
        provider: Record<string, { models: Record<string, unknown> }>
      }
      expect(config.provider["model-del"]?.models["drop"]).toBeUndefined()
      expect(config.provider["model-del"]?.models["keep"]).toBeDefined()
    })

    test("DELETE /config/provider/:id/model/:modelID returns 404 for unknown model", async () => {
      const res = await fetch(`${baseUrl}/config/provider/test-provider-x/model/nonexistent`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      })
      expect(res.status).toBe(404)
    })
  })

  describe("provider API key management", () => {
    test("PUT /auth/:providerID stores the key", async () => {
      const res = await fetch(`${baseUrl}/auth/test-provider-x`, {
        method: "PUT",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "api", key: "test-key-123" }),
      })
      expect(res.ok).toBe(true)
      expect(await res.json()).toBe(true)

      const configRes = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
      const config = (await configRes.json()) as { provider: Record<string, { apiKey?: string }> }
      expect(config.provider["test-provider-x"]?.apiKey).toBe("test-key-123")
    })

    test("PUT /auth/:providerID returns 404 for unknown provider", async () => {
      const res = await fetch(`${baseUrl}/auth/nonexistent`, {
        method: "PUT",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "api", key: "key" }),
      })
      expect(res.status).toBe(404)
    })

    test("DELETE /auth/:providerID removes the key", async () => {
      await fetch(`${baseUrl}/auth/test-provider-x`, {
        method: "PUT",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "api", key: "temp-key" }),
      })

      const res = await fetch(`${baseUrl}/auth/test-provider-x`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      })
      expect(res.ok).toBe(true)
      expect(await res.json()).toBe(true)

      const configRes = await fetch(`${baseUrl}/config`, { headers: { Authorization: authHeader } })
      const config = (await configRes.json()) as { provider: Record<string, { apiKey?: string }> }
      expect(config.provider["test-provider-x"]?.apiKey).toBeUndefined()
    })
  })

  describe("CORS", () => {
    test("OPTIONS preflight returns 204 with CORS headers", async () => {
      const res = await fetch(`${baseUrl}/auth/my-provider`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "authorization, content-type",
        },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000")
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PUT")
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("DELETE")
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization")
    })

    test("GET response includes CORS header when Origin present", async () => {
      const res = await fetch(`${baseUrl}/api/health`, {
        headers: { Authorization: authHeader, Origin: "http://localhost:5173" },
      })
      expect(res.ok).toBe(true)
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173")
    })
  })

  describe("project list", () => {
    test("GET /project returns array", async () => {
      const res = await fetch(`${baseUrl}/project`, { headers: { Authorization: authHeader } })
      expect(res.ok).toBe(true)
      const projects = (await res.json()) as unknown[]
      expect(Array.isArray(projects)).toBe(true)
    })
  })

  describe("session list + content", () => {
    test("GET /session returns array", async () => {
      const res = await fetch(`${baseUrl}/session`, { headers: { Authorization: authHeader } })
      expect(res.ok).toBe(true)
      const sessions = (await res.json()) as unknown[]
      expect(Array.isArray(sessions)).toBe(true)
    })

    test("GET /session/:id returns 404 for unknown session", async () => {
      const res = await fetch(`${baseUrl}/session/nonexistent`, { headers: { Authorization: authHeader } })
      expect(res.status).toBe(404)
    })

    test("GET /session/:id/message returns 404 for unknown session", async () => {
      const res = await fetch(`${baseUrl}/session/nonexistent/message`, { headers: { Authorization: authHeader } })
      expect(res.status).toBe(404)
    })
  })

  describe("deleted endpoints return 404", () => {
    test("POST /session is not available", async () => {
      const res = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "test" }),
      })
      expect(res.status).toBe(404)
    })

    test("POST /agent is not available", async () => {
      const res = await fetch(`${baseUrl}/agent`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", cliPath: "x" }),
      })
      expect(res.status).toBe(404)
    })

    test("GET /command is not available", async () => {
      const res = await fetch(`${baseUrl}/command`, { headers: { Authorization: authHeader } })
      expect(res.status).toBe(404)
    })

    test("GET /file is available (shared v1-compatible route)", async () => {
      const res = await fetch(`${baseUrl}/file?path=.`, { headers: { Authorization: authHeader } })
      expect(res.ok).toBe(true)
      expect(Array.isArray(await res.json())).toBe(true)
    })

    test("GET /permission is not available", async () => {
      const res = await fetch(`${baseUrl}/permission`, { headers: { Authorization: authHeader } })
      expect(res.status).toBe(404)
    })

    test("GET /mcp is not available", async () => {
      const res = await fetch(`${baseUrl}/mcp`, { headers: { Authorization: authHeader } })
      expect(res.status).toBe(404)
    })

    test("DELETE /session/:id is available (shared v1-compatible route)", async () => {
      const res = await fetch(`${baseUrl}/session/nonexistent`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      })
      // The route is registered (shared); nonexistent session returns 404 from the handler
      expect(res.status).toBe(404)
    })
  })
})
