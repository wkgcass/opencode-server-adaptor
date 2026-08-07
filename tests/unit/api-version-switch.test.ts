import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../src/config/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { createServerContext } from "../../src/server.ts"

/**
 * The --api-version switch selects which API surface is mounted. The
 * v1-compatible routes (DELETE /session/:id, GET /config) are always present
 * in both modes.
 */
describe("api-version switch", () => {
  function makeContext(directory: string, apiVersion: "v1" | "v2") {
    const config = {
      ...loadConfig(),
      databasePath: join(directory, "adaptor.db"),
      defaultAgent: "stub",
      serverUsername: null,
      serverPassword: null,
    }
    const logger = new Logger({ minLevel: "ERROR" })
    return createServerContext(config, logger, { agentIntegrations: [], apiVersion })
  }

  test("v1 mode exposes v1 routes and hides v2 routes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "api-v1-"))
    try {
      const ctx = makeContext(directory, "v1")
      // v1-only routes present
      expect((await ctx.app.request("/agent")).status).toBe(200)
      expect((await ctx.app.request("/session")).status).toBe(200)
      expect((await ctx.app.request("/config/providers")).status).toBe(200)
      expect((await ctx.app.request("/project")).status).toBe(200)
      // v1-compatible routes always present
      expect((await ctx.app.request("/config")).status).toBe(200)
      // v2 routes absent
      expect((await ctx.app.request("/api/agent")).status).toBe(404)
      expect((await ctx.app.request("/api/session")).status).toBe(404)
      ctx.db.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("v2 mode exposes v2 routes and hides v1-only routes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "api-v2-"))
    try {
      const ctx = makeContext(directory, "v2")
      // v2 routes present
      expect((await ctx.app.request("/api/agent")).status).toBe(200)
      expect((await ctx.app.request("/api/session")).status).toBe(200)
      // v1-compatible routes always present
      expect((await ctx.app.request("/config")).status).toBe(200)
      // v1-only routes absent
      expect((await ctx.app.request("/agent")).status).toBe(404)
      expect((await ctx.app.request("/session")).status).toBe(404)
      expect((await ctx.app.request("/config/providers")).status).toBe(404)
      ctx.db.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("defaults to v2 when apiVersion is omitted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "api-default-"))
    try {
      const config = {
        ...loadConfig(),
        databasePath: join(directory, "adaptor.db"),
        defaultAgent: "stub",
        serverUsername: null,
        serverPassword: null,
      }
      const ctx = createServerContext(config, new Logger({ minLevel: "ERROR" }), { agentIntegrations: [] })
      expect((await ctx.app.request("/api/agent")).status).toBe(200)
      expect((await ctx.app.request("/agent")).status).toBe(404)
      // v1-compatible always present
      expect((await ctx.app.request("/config")).status).toBe(200)
      ctx.db.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("disableV1Compatible hides the shared routes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "api-no-compat-"))
    try {
      const config = {
        ...loadConfig(),
        databasePath: join(directory, "adaptor.db"),
        defaultAgent: "stub",
        serverUsername: null,
        serverPassword: null,
      }
      const ctx = createServerContext(config, new Logger({ minLevel: "ERROR" }), {
        agentIntegrations: [],
        disableV1Compatible: true,
      })
      // v1-compatible routes absent
      expect((await ctx.app.request("/config")).status).toBe(404)
      // v2 routes still work
      expect((await ctx.app.request("/api/agent")).status).toBe(200)
      ctx.db.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
