import { Hono } from "hono"
import { existsSync, statSync } from "node:fs"
import { basename, resolve } from "node:path"
import type { AgentAdapterRegistry } from "../../agents/registry.ts"
import type { AppConfig } from "../../config/index.ts"
import type { ProviderConfigStore, ProviderConfig } from "../../config/provider-config.ts"
import type { ProviderConfigChangeListener } from "../../config/provider-config.ts"
import { buildDefaultProviderMap, buildProviders, type BuiltinProviderDefinition } from "../provider.ts"
import { explicitRequestDirectory, requestDirectory } from "../request-directory.ts"
import type { SessionService } from "../../session/session-service.ts"
import { projectIDForDirectory } from "../../project/index.ts"

/**
 * v1-only API surface — a minimal configuration and inspection layer.
 *
 * The adaptor runs primarily in v2 mode. v1 mode exists for the rare scenario
 * where a tool or client only speaks v1: start with --api-version=v1, perform
 * the needed provider/model configuration or session inspection, then restart
 * in v2 mode.
 *
 * v1-only routes (this file):
 *   - Session list + content  — GET /session, GET /session/:id, GET /session/:id/message
 *   - Agent list              — GET /agent
 *   - Provider/model CRUD     — PATCH /config, DELETE /config/provider/:id, DELETE /config/provider/:id/model/:modelID
 *   - Provider/model list     — GET /config/providers
 *   - Provider API key        — PUT/DELETE /auth/:id
 *   - Project list            — GET /project
 *
 * Shared routes (v1-compatible-legacy.ts, mounted in both v1 and v2 mode):
 *   - DELETE /session/:id  — session deletion (v2 uses DELETE /api/session/:id)
 *   - GET /config          — legacy config object (v2 has no equivalent)
 *   - GET /file, /file/content, /find/file — legacy filesystem routes driven by
 *     the OpenCode desktop's v1 SDK File/Find classes (client.file.list /
 *     client.file.read / client.find.files). Mounted in both modes because the
 *     desktop calls these even over the v2 protocol. The remaining v1 SDK
 *     File/Find methods (file.status, find.text, find.symbols) are unused by
 *     the desktop and intentionally not mounted.
 */
export function createV1LegacyRoutes(options: {
  sessionService: SessionService
  registry: AgentAdapterRegistry
  config: AppConfig
  providerConfig: ProviderConfigStore
  builtinProviders: readonly BuiltinProviderDefinition[]
  providerConfigListeners?: readonly ProviderConfigChangeListener[]
}): Hono {
  const app = new Hono()
  const service = options.sessionService
  const notifyProviderConfigChanged = () => {
    for (const listener of options.providerConfigListeners ?? []) listener.markDirty()
  }

  function getDefaultModel(): { modelID: string; providerID: string } | undefined {
    const providers = buildProviders(options.providerConfig, [...options.builtinProviders])
    const defaultMap = buildDefaultProviderMap(providers)
    for (const provider of providers) {
      const modelID = defaultMap[provider.id]
      if (modelID) return { providerID: provider.id, modelID }
    }
    return undefined
  }

  // ===== Session list + content (read-only) =====

  app.get("/session", (c) => {
    const directory = explicitRequestDirectory(c.req)
    let sessions = directory ? service.sessions.listByDirectory(directory) : service.sessions.list()
    if (c.req.query("roots") === "true") sessions = sessions.filter((session) => !session.parentID)
    const search = c.req.query("search")?.trim().toLocaleLowerCase()
    if (search) sessions = sessions.filter((session) => session.title.toLocaleLowerCase().includes(search))
    const start = Number(c.req.query("start"))
    if (Number.isFinite(start) && start > 0) {
      sessions = sessions.filter((session) => session.time.updated >= start)
    }
    const limit = Number(c.req.query("limit"))
    if (Number.isInteger(limit) && limit >= 0) sessions = sessions.slice(0, limit)
    return c.json(sessions)
  })

  app.get("/session/:id", (c) => {
    try {
      return c.json(service.requireSession(c.req.param("id")))
    } catch {
      return c.json({ error: "Session not found" }, 404)
    }
  })

  app.get("/session/:id/message", (c) => {
    try {
      service.requireSession(c.req.param("id"))
      return c.json(service.messages.listMessages(c.req.param("id")))
    } catch {
      return c.json({ error: "Session not found" }, 404)
    }
  })

  // ===== Agent list =====

  app.get("/agent", (c) => {
    const adapters = options.registry.list()
    const defaultModel = getDefaultModel()
    const agents = adapters.map((adapter) => ({
      name: adapter.id,
      description: adapter.displayName,
      mode:
        adapter.mode ??
        (adapter.id === options.registry.getDefault().id ? ("primary" as const) : ("subagent" as const)),
      native: adapter.subagents?.mode === "native",
      hidden: false,
      permission: [],
      options: {},
      model: adapter.id === options.registry.getDefault().id ? defaultModel : undefined,
    }))

    const existingNames = new Set(agents.map((agent) => agent.name))
    for (const adapter of adapters) {
      if (!adapter.subagents) continue
      try {
        const cwd = options.config.defaultWorkspace ?? process.cwd()
        for (const agent of adapter.subagents.listProfiles(cwd)) {
          if (!existingNames.has(agent.name)) {
            agents.push({
              name: agent.name,
              description: agent.description,
              mode: "subagent" as const,
              native: adapter.subagents.mode === "native",
              hidden: false,
              permission: [],
              options: {},
              model: agent.model ? defaultModel : undefined,
            })
          }
        }
      } catch {
        // Agent discovery is best-effort
      }
    }

    return c.json(agents)
  })

  // ===== Provider + model list =====

  app.get("/config/providers", (c) => {
    const providers = buildProviders(options.providerConfig, [...options.builtinProviders])
    const defaultMap = buildDefaultProviderMap(providers)
    return c.json({ providers, default: defaultMap })
  })

  // ===== Provider + model CRUD =====

  app.patch("/config", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
    const providersChanged = body.provider && typeof body.provider === "object"
    options.providerConfig.update({
      ...(providersChanged ? { provider: body.provider as Record<string, ProviderConfig> } : {}),
      ...("model" in body ? { model: typeof body.model === "string" ? body.model : null } : {}),
    })
    if (providersChanged) notifyProviderConfigChanged()
    return c.json({ ...options.providerConfig.snapshot(), ...body })
  })

  app.delete("/config/provider/:providerID", (c) => {
    const providerID = c.req.param("providerID")
    if (!options.providerConfig.deleteProvider(providerID)) {
      return c.json({ error: `Provider not found: ${providerID}` }, 404)
    }
    notifyProviderConfigChanged()
    return c.json(true)
  })

  app.delete("/config/provider/:providerID/model/:modelID", (c) => {
    const providerID = c.req.param("providerID")
    const modelID = c.req.param("modelID")
    if (!options.providerConfig.deleteModel(providerID, modelID)) {
      return c.json({ error: `Model not found: ${providerID}/${modelID}` }, 404)
    }
    notifyProviderConfigChanged()
    return c.json(true)
  })

  // ===== Provider API key management (v2 uses integration/credential) =====

  app.put("/auth/:providerID", async (c) => {
    const providerID = c.req.param("providerID")
    const body = await c.req.json().catch(() => ({}))
    if (body.type !== undefined && body.type !== "api") {
      return c.json({ error: "Only API key authentication is supported" }, 400)
    }
    if (typeof body.key !== "string" || !body.key.trim()) {
      return c.json({ error: "A non-empty API key is required" }, 400)
    }
    if (!options.providerConfig.setApiKey(providerID, body.key)) {
      return c.json({ error: `Provider not found: ${providerID}` }, 404)
    }
    notifyProviderConfigChanged()
    return c.json(true)
  })

  app.delete("/auth/:providerID", (c) => {
    const providerID = c.req.param("providerID")
    if (!options.providerConfig.setApiKey(providerID, undefined)) {
      return c.json({ error: `Provider not found: ${providerID}` }, 404)
    }
    notifyProviderConfigChanged()
    return c.json(true)
  })

  // ===== Project list =====

  app.get("/project", (c) => {
    const requested = requestDirectory(c.req)
    const directories = [requested, ...service.sessions.listDirectories()]
    return c.json([...new Set(directories)].map((worktree) => projectInfo(worktree)))
  })

  return app
}

function projectInfo(worktree: string) {
  const stat = existsSync(worktree) ? statSync(worktree) : undefined
  const now = Date.now()
  return {
    id: projectIDForDirectory(worktree),
    worktree,
    vcs: existsSync(resolve(worktree, ".git")) ? ("git" as const) : undefined,
    name: basename(worktree) || "default",
    time: {
      created: stat?.birthtimeMs || stat?.ctimeMs || now,
      updated: stat?.mtimeMs || now,
    },
    sandboxes: [] as string[],
  }
}
