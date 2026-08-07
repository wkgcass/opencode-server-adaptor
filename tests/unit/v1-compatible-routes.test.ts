import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../src/config/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { createServerContext } from "../../src/server.ts"

/**
 * The v1-compatible routes (GET /config, DELETE /session/:id) are mounted in
 * both v1 and v2 mode because they have no v2 equivalent. These tests verify
 * they work in v2 mode (the primary mode).
 */
describe("v1-compatible routes (shared, tested in v2 mode)", () => {
  function makeContext(directory: string) {
    const config = {
      ...loadConfig(),
      databasePath: join(directory, "adaptor.db"),
      defaultAgent: "stub",
      serverUsername: null,
      serverPassword: null,
    }
    const logger = new Logger({ minLevel: "ERROR" })
    return createServerContext(config, logger, { agentIntegrations: [], apiVersion: "v2" })
  }

  test("GET /config returns the legacy config object", async () => {
    const directory = mkdtempSync(join(tmpdir(), "v1compat-config-"))
    try {
      const ctx = makeContext(directory)
      const res = await ctx.app.request("/config")
      expect(res.status).toBe(200)
      const config = (await res.json()) as { default_agent: string; provider: Record<string, unknown> }
      expect(config.default_agent).toBeDefined()
      expect(typeof config.provider).toBe("object")
      ctx.db.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("DELETE /session/:id deletes a session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "v1compat-delete-"))
    try {
      const ctx = makeContext(directory)
      // Create a session via v2 API
      const createRes = await ctx.app.request("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "stub", model: { id: "model", providerID: "stub" } }),
      })
      const session = ((await createRes.json()) as { data: { id: string } }).data

      // Delete via the shared v1-compatible route
      const delRes = await ctx.app.request(`/session/${session.id}`, { method: "DELETE" })
      expect(delRes.status).toBe(200)
      expect(await delRes.json()).toBe(true)

      // Confirm it's gone via v2 API
      const getRes = await ctx.app.request(`/api/session/${session.id}`)
      expect(getRes.status).toBe(404)
      ctx.db.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
