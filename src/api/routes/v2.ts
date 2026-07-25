import { Hono } from "hono"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { basename, join, relative, resolve, sep } from "node:path"
import type { AgentAdapterRegistry } from "../../agents/registry.ts"
import type { AgentService } from "../../agents/agent-service.ts"
import type { AppConfig } from "../../config/index.ts"
import type { ProviderConfigStore } from "../../config/provider-config.ts"
import type { DatabaseService, PermissionRow } from "../../db/index.ts"
import type { EventBus } from "../../event/index.ts"
import { createEvent } from "../../event/index.ts"
import { projectIDForDirectory } from "../../project/index.ts"
import type { SessionService } from "../../session/session-service.ts"
import type { ProviderConfigChangeListener } from "../provider-config.ts"
import { buildProviders, type BuiltinProviderDefinition, type ProviderInfo, type ProviderModel } from "../provider.ts"
import type { PtyManager } from "../pty-manager.ts"
import { requestDirectory } from "../request-directory.ts"

interface McpInfo {
  name: string
  status: { status: "connected" | "disabled" }
}

interface IntegrationAttempt {
  attemptID: string
  integrationID: string
  label?: string
  created: number
  expires: number
  status: "pending" | "complete" | "failed"
  message?: string
}

interface ProjectCopyInfo {
  projectID: string
  sourceDirectory: string
  directory: string
}

export function createV2Routes(options: {
  registry: AgentAdapterRegistry
  config: AppConfig
  providerConfig: ProviderConfigStore
  builtinProviders: readonly BuiltinProviderDefinition[]
  sessions: SessionService
  db: DatabaseService
  agentService: AgentService
  events: EventBus
  ptys: PtyManager
  defaultAdapterType: string
  providerConfigListeners?: readonly ProviderConfigChangeListener[]
}): Hono {
  const app = new Hono()
  const mcpServers = new Map<string, McpInfo>()
  const integrationAttempts = new Map<string, IntegrationAttempt>()
  const projectCopies = new Map<string, ProjectCopyInfo>()
  const notifyProviderConfigChanged = () => {
    for (const listener of options.providerConfigListeners ?? []) listener.markDirty()
  }

  const directory = (c: {
    req: { query(name: string): string | undefined; header(name: string): string | undefined }
  }) => requestDirectory(c.req)
  const location = (c: {
    req: { query(name: string): string | undefined; header(name: string): string | undefined }
  }) => {
    const current = directory(c)
    return {
      directory: current,
      project: { id: projectIDForDirectory(current), directory: current },
    }
  }

  app.get("/api/location", (c) => c.json(location(c)))
  app.get("/api/server", (c) => c.json({ urls: [new URL(c.req.url).origin] }))
  app.get("/api/plugin", (c) => c.json({ location: location(c), data: [] }))

  app.get("/api/agent", (c) => {
    const providers = buildProviders(options.providerConfig, [...options.builtinProviders])
    const model = defaultModelRef(providers, options.sessions)
    const adapters = options.registry.list()
    const agents = adapters.map((adapter) => ({
      id: adapter.id,
      name: adapter.displayName,
      model: adapter.id === options.registry.getDefault().id ? model : undefined,
      request: { settings: {}, headers: {}, body: {} },
      description: adapter.displayName,
      mode:
        adapter.mode ??
        (adapter.id === options.registry.getDefault().id ? ("primary" as const) : ("subagent" as const)),
      hidden: false,
      permissions: [],
    }))
    const names = new Set(agents.map((agent) => agent.id))
    const profiles = adapters.flatMap((adapter) =>
      adapter.subagents
        ? adapter.subagents
            .listProfiles(directory(c))
            .filter((profile) => {
              if (names.has(profile.name)) return false
              names.add(profile.name)
              return true
            })
            .map((profile) => ({
              id: profile.name,
              name: profile.name,
              model: profile.model ? model : undefined,
              request: { settings: {}, headers: {}, body: {} },
              system: profile.systemPrompt,
              description: profile.description,
              mode: "subagent" as const,
              hidden: false,
              permissions: [],
            }))
        : [],
    )
    return c.json({
      location: location(c),
      data: [...agents, ...profiles],
    })
  })

  app.post("/api/agent", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!body) return c.json({ _tag: "InvalidRequestError", message: "Invalid JSON body" }, 400)
    const id = typeof body?.id === "string" ? body.id.trim() : typeof body?.name === "string" ? body.name.trim() : ""
    const cliPath = typeof body?.cliPath === "string" ? body.cliPath.trim() : ""
    if (!id || !/^[a-zA-Z0-9._-]+$/.test(id)) {
      return c.json({ _tag: "InvalidRequestError", message: "A valid agent id is required" }, 400)
    }
    if (!cliPath) return c.json({ _tag: "InvalidRequestError", message: "cliPath is required" }, 400)
    const profileExists = options.registry.list().some((adapter) => {
      try {
        return adapter.subagents?.listProfiles(directory(c)).some((profile) => profile.name === id)
      } catch {
        return false
      }
    })
    if (options.registry.has(id) || profileExists) {
      return c.json({ _tag: "ConflictError", resource: id, message: `Agent already exists: ${id}` }, 409)
    }
    const type = typeof body.type === "string" && body.type.trim() ? body.type.trim() : options.defaultAdapterType
    if (!options.registry.hasFactory(type)) {
      return c.json({ _tag: "InvalidRequestError", message: `Agent adapter type not found: ${type}` }, 400)
    }
    const description = typeof body.description === "string" && body.description.trim() ? body.description.trim() : id
    const adapter = options.registry.create(type, {
      id,
      displayName: description,
      cliPath,
      provider: typeof body.provider === "string" ? body.provider : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
      tools: Array.isArray(body.tools)
        ? body.tools.filter((tool): tool is string => typeof tool === "string")
        : undefined,
    })
    options.registry.register(adapter)
    return c.json(
      {
        location: location(c),
        data: {
          id,
          name: description,
          description,
          mode: "subagent",
          hidden: false,
          permissions: [],
          request: { settings: {}, headers: {}, body: {} },
        },
      },
      201,
    )
  })

  app.delete("/api/agent/:agentID", (c) => {
    const id = c.req.param("agentID")
    if (!options.registry.has(id)) {
      return c.json({ _tag: "AgentNotFoundError", message: `Agent not found: ${id}` }, 404)
    }
    const adapter = options.registry.get(id)
    if (adapter.removable === false || id === options.registry.getDefault().id) {
      return c.json({ _tag: "ConflictError", resource: id, message: `Cannot remove protected agent: ${id}` }, 409)
    }
    adapter.subagents?.unregisterProfile?.(id)
    options.registry.unregister(id)
    return c.body(null, 204)
  })

  app.get("/api/model", (c) => {
    const providers = buildProviders(options.providerConfig, [...options.builtinProviders])
    return c.json({
      location: location(c),
      data: providers.flatMap((provider) => Object.values(provider.models).map((model) => toV2Model(model))),
    })
  })

  app.get("/api/model/default", (c) => {
    const providers = buildProviders(options.providerConfig, [...options.builtinProviders])
    const model = defaultModel(providers, options.sessions)
    return c.json({ location: location(c), data: model ? toV2Model(model) : null })
  })

  app.get("/api/provider", (c) => {
    return c.json({
      location: location(c),
      data: buildProviders(options.providerConfig, [...options.builtinProviders]).map(toV2Provider),
    })
  })

  app.get("/api/provider/:providerID", (c) => {
    const provider = buildProviders(options.providerConfig, [...options.builtinProviders]).find(
      (candidate) => candidate.id === c.req.param("providerID"),
    )
    if (!provider) {
      return c.json(
        {
          _tag: "ProviderNotFoundError",
          providerID: c.req.param("providerID"),
          message: `Provider not found: ${c.req.param("providerID")}`,
        },
        404,
      )
    }
    return c.json({ location: location(c), data: toV2Provider(provider) })
  })

  app.get("/api/integration", (c) => {
    return c.json({
      location: location(c),
      data: integrations(options.providerConfig),
    })
  })

  app.get("/api/integration/:integrationID", (c) => {
    const integration = integrations(options.providerConfig).find(
      (candidate) => candidate.id === c.req.param("integrationID"),
    )
    if (!integration) {
      return c.json(
        { _tag: "InvalidRequestError", message: `Integration not found: ${c.req.param("integrationID")}` },
        400,
      )
    }
    return c.json({ location: location(c), data: integration })
  })

  app.post("/api/integration/:integrationID/connect/key", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!body || typeof body.key !== "string" || !body.key.trim()) {
      return c.json({ _tag: "InvalidRequestError", message: "A non-empty key is required" }, 400)
    }
    if (!options.providerConfig.setApiKey(c.req.param("integrationID"), body.key)) {
      return c.json(
        { _tag: "InvalidRequestError", message: `Integration not found: ${c.req.param("integrationID")}` },
        400,
      )
    }
    notifyProviderConfigChanged()
    return c.body(null, 204)
  })

  app.post("/api/integration/:integrationID/connect/oauth", async (c) => {
    const integrationID = c.req.param("integrationID")
    const integration = integrations(options.providerConfig).find((candidate) => candidate.id === integrationID)
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!integration || !body || typeof body.methodID !== "string" || !body.methodID.trim()) {
      return c.json({ _tag: "InvalidRequestError", message: "Authentication failed" }, 400)
    }
    const now = Date.now()
    const attempt: IntegrationAttempt = {
      attemptID: `con_${crypto.randomUUID().replaceAll("-", "")}`,
      integrationID,
      label: typeof body.label === "string" ? body.label : undefined,
      created: now,
      expires: now + 10 * 60_000,
      status: "pending",
    }
    integrationAttempts.set(attempt.attemptID, attempt)
    return c.json({
      location: location(c),
      data: {
        attemptID: attempt.attemptID,
        url: `https://localhost.invalid/opencode/integration/${encodeURIComponent(integrationID)}`,
        instructions: "Complete authorization and submit the returned code.",
        mode: "code",
        time: { created: attempt.created, expires: attempt.expires },
      },
    })
  })

  app.get("/api/integration/attempt/:attemptID", (c) => {
    const attempt = integrationAttempts.get(c.req.param("attemptID"))
    if (!attempt) {
      return c.json({
        location: location(c),
        data: {
          status: "expired",
          time: { created: 0, expires: 0 },
        },
      })
    }
    const expired = attempt.expires <= Date.now()
    return c.json({
      location: location(c),
      data: {
        status: expired ? "expired" : attempt.status,
        ...(attempt.status === "failed" && attempt.message ? { message: attempt.message } : {}),
        time: { created: attempt.created, expires: attempt.expires },
      },
    })
  })

  app.post("/api/integration/attempt/:attemptID/complete", async (c) => {
    const attempt = integrationAttempts.get(c.req.param("attemptID"))
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!attempt || attempt.expires <= Date.now()) {
      return c.json({ _tag: "InvalidRequestError", message: "Authentication failed" }, 400)
    }
    if (!body || typeof body.code !== "string" || !body.code.trim()) {
      return c.json(
        {
          _tag: "InvalidRequestError",
          message: "Authorization code is required",
          kind: "integration_code_required",
        },
        400,
      )
    }
    if (!options.providerConfig.setApiKey(attempt.integrationID, body.code)) {
      attempt.status = "failed"
      attempt.message = "Authentication failed"
      return c.json({ _tag: "InvalidRequestError", message: attempt.message }, 400)
    }
    attempt.status = "complete"
    notifyProviderConfigChanged()
    return c.body(null, 204)
  })

  app.delete("/api/integration/attempt/:attemptID", (c) => {
    integrationAttempts.delete(c.req.param("attemptID"))
    return c.body(null, 204)
  })

  app.delete("/api/credential/:credentialID", (c) => {
    const providerID = providerForCredential(options.providerConfig, c.req.param("credentialID"))
    if (providerID && options.providerConfig.setApiKey(providerID, undefined)) {
      notifyProviderConfigChanged()
    }
    return c.body(null, 204)
  })

  app.patch("/api/credential/:credentialID", async (c) => {
    await c.req.json<Record<string, unknown>>().catch(() => ({}))
    return c.body(null, 204)
  })

  app.get("/api/mcp", (c) => c.json({ location: location(c), data: [...mcpServers.values()] }))
  app.put("/api/mcp/:server", async (c) => {
    await c.req.json<Record<string, unknown>>().catch(() => ({}))
    const name = c.req.param("server")
    mcpServers.set(name, { name, status: { status: "disabled" } })
    return c.body(null, 204)
  })
  app.delete("/api/mcp/:server", (c) => {
    mcpServers.delete(c.req.param("server"))
    return c.body(null, 204)
  })
  app.post("/api/mcp/:server/connect", (c) => {
    const name = c.req.param("server")
    const server = mcpServers.get(name)
    if (!server) return c.json({ _tag: "InvalidRequestError", message: `MCP server not found: ${name}` }, 404)
    server.status = { status: "connected" }
    return c.body(null, 204)
  })
  app.post("/api/mcp/:server/disconnect", (c) => {
    const name = c.req.param("server")
    const server = mcpServers.get(name)
    if (!server) return c.json({ _tag: "InvalidRequestError", message: `MCP server not found: ${name}` }, 404)
    server.status = { status: "disabled" }
    return c.body(null, 204)
  })
  app.get("/api/mcp/resource", (c) => c.json({ location: location(c), data: { resources: [], templates: [] } }))

  app.get("/api/project", (c) => {
    const requested = directory(c)
    const rows = options.db.prepare("SELECT DISTINCT directory FROM sessions").all() as Array<{ directory: string }>
    const directories = [requested, ...rows.map((row) => resolve(row.directory))]
    return c.json([...new Set(directories)].map(projectInfo))
  })
  app.get("/api/project/current", (c) => {
    const current = directory(c)
    return c.json({ id: projectIDForDirectory(current), directory: current })
  })
  app.get("/api/project/:projectID/directories", (c) => {
    const requested = directory(c)
    const rows = options.db.prepare("SELECT DISTINCT directory FROM sessions").all() as Array<{ directory: string }>
    const directories = [requested, ...rows.map((row) => resolve(row.directory))]
    return c.json(
      [...new Set(directories)]
        .filter((candidate) => projectIDForDirectory(candidate) === c.req.param("projectID"))
        .map((candidate) => ({ directory: candidate })),
    )
  })

  app.get("/api/permission/request", (c) => {
    const rows = options.db
      .prepare(
        `SELECT permissions.*
         FROM permissions
         JOIN sessions ON sessions.id = permissions.session_id
         WHERE permissions.status = 'pending' AND sessions.directory = ?
         ORDER BY permissions.created_at DESC`,
      )
      .all(directory(c)) as PermissionRow[]
    return c.json({ location: location(c), data: rows.map(toV2Permission) })
  })

  app.get("/api/permission/saved", (c) => c.json({ data: [] }))
  app.delete("/api/permission/saved/:id", (c) => c.body(null, 204))

  app.get("/api/session/:sessionID/permission", (c) => {
    try {
      options.sessions.requireSession(c.req.param("sessionID"))
      const rows = options.db
        .prepare("SELECT * FROM permissions WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC")
        .all(c.req.param("sessionID")) as PermissionRow[]
      return c.json({ data: rows.map(toV2Permission) })
    } catch {
      return sessionNotFound(c, c.req.param("sessionID"))
    }
  })

  app.post("/api/session/:sessionID/permission", async (c) => {
    const sessionID = c.req.param("sessionID")
    try {
      options.sessions.requireSession(sessionID)
    } catch {
      return sessionNotFound(c, sessionID)
    }
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (
      !body ||
      typeof body.action !== "string" ||
      !Array.isArray(body.resources) ||
      !body.resources.every((resource) => typeof resource === "string")
    ) {
      return c.json({ _tag: "InvalidRequestError", message: "action and string resources are required" }, 400)
    }
    const id =
      typeof body.id === "string" && body.id.trim() ? body.id : `per_${crypto.randomUUID().replaceAll("-", "")}`
    const metadata =
      typeof body.metadata === "object" && body.metadata ? (body.metadata as Record<string, unknown>) : {}
    const input = {
      ...metadata,
      resources: body.resources,
      save: Array.isArray(body.save) ? body.save : undefined,
      source: body.source,
      agent: body.agent,
    }
    try {
      options.db
        .prepare(
          "INSERT INTO permissions (id, session_id, tool, input, status, response, created_at, responded_at, expires_at) VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL)",
        )
        .run(id, sessionID, body.action, JSON.stringify(input), Date.now())
    } catch {
      return c.json({ _tag: "InvalidRequestError", message: `Permission already exists: ${id}` }, 400)
    }
    options.events.publish(
      createEvent("permission.asked", {
        id,
        sessionID,
        permission: body.action,
        patterns: body.resources,
        metadata: input,
        always: Array.isArray(body.save) ? body.save : [],
      }),
    )
    return c.json({ data: { id, effect: "ask" as const } })
  })

  app.get("/api/session/:sessionID/permission/:requestID", (c) => {
    try {
      options.sessions.requireSession(c.req.param("sessionID"))
    } catch {
      return sessionNotFound(c, c.req.param("sessionID"))
    }
    const row = options.db
      .prepare("SELECT * FROM permissions WHERE session_id = ? AND id = ? AND status = 'pending'")
      .get(c.req.param("sessionID"), c.req.param("requestID")) as PermissionRow | null
    if (!row) {
      return c.json(
        {
          _tag: "PermissionNotFoundError",
          sessionID: c.req.param("sessionID"),
          requestID: c.req.param("requestID"),
          message: `Permission not found: ${c.req.param("requestID")}`,
        },
        404,
      )
    }
    return c.json({ data: toV2Permission(row) })
  })

  app.post("/api/session/:sessionID/permission/:requestID/reply", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!body || !["once", "always", "reject"].includes(String(body.reply))) {
      return c.json({ _tag: "InvalidRequestError", message: "Invalid permission reply" }, 400)
    }
    const row = options.db
      .prepare("SELECT * FROM permissions WHERE session_id = ? AND id = ? AND status = 'pending'")
      .get(c.req.param("sessionID"), c.req.param("requestID")) as PermissionRow | null
    if (!row) {
      try {
        options.sessions.requireSession(c.req.param("sessionID"))
      } catch {
        return sessionNotFound(c, c.req.param("sessionID"))
      }
      return c.json(
        {
          _tag: "PermissionNotFoundError",
          sessionID: c.req.param("sessionID"),
          requestID: c.req.param("requestID"),
          message: `Permission not found: ${c.req.param("requestID")}`,
        },
        404,
      )
    }
    const action = body.reply === "reject" ? "deny" : "allow"
    const message = typeof body.message === "string" ? body.message : undefined
    options.db
      .prepare("UPDATE permissions SET status = ?, response = ?, responded_at = ? WHERE id = ?")
      .run(action, JSON.stringify({ action, reason: message }), Date.now(), row.id)
    await options.agentService.respondToPermission(row.session_id, row.id, action, message)
    options.events.publish(
      createEvent("permission.replied", {
        sessionID: row.session_id,
        requestID: row.id,
        reply: body.reply,
      }),
    )
    return c.body(null, 204)
  })

  app.get("/api/question/request", (c) => c.json({ location: location(c), data: [] }))
  app.get("/api/session/:sessionID/question", (c) => {
    try {
      options.sessions.requireSession(c.req.param("sessionID"))
      return c.json({ data: [] })
    } catch {
      return sessionNotFound(c, c.req.param("sessionID"))
    }
  })
  app.post("/api/session/:sessionID/question/:requestID/reply", (c) => c.body(null, 204))
  app.post("/api/session/:sessionID/question/:requestID/reject", (c) => c.body(null, 204))

  app.get("/api/fs/read/*", (c) => {
    const base = directory(c)
    const path = decodeURIComponent(c.req.path.slice("/api/fs/read/".length))
    const target = safePath(base, path)
    if (!target || !existsSync(target) || !statSync(target).isFile()) {
      return c.json({ _tag: "InvalidRequestError", message: "File not found" }, 400)
    }
    return new Response(Bun.file(target))
  })

  app.get("/api/fs/list", (c) => {
    const base = directory(c)
    const target = safePath(base, c.req.query("path") ?? ".")
    if (!target || !existsSync(target) || !statSync(target).isDirectory()) {
      return c.json({ location: location(c), data: [] })
    }
    return c.json({
      location: location(c),
      data: readdirSync(target, { withFileTypes: true }).map((entry) => ({
        path: relative(base, resolve(target, entry.name)),
        type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      })),
    })
  })

  app.get("/api/fs/find", (c) => {
    const query = c.req.query("query")
    if (!query) return c.json({ _tag: "InvalidRequestError", message: "query is required" }, 400)
    const base = directory(c)
    const type = c.req.query("type")
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200)
    return c.json({
      location: location(c),
      data: findEntries(base, query, type === "directory" ? "directory" : type === "file" ? "file" : undefined, limit),
    })
  })

  app.get("/api/command", (c) => {
    return c.json({
      location: location(c),
      data: [
        {
          name: "init",
          template: "",
          description: "Initialize a new project with opencode configuration",
          subtask: false,
        },
        {
          name: "compact",
          template: "",
          description: "Compact the conversation history",
          subtask: false,
        },
      ],
    })
  })

  app.get("/api/skill", (c) => c.json({ location: location(c), data: [] }))
  app.get("/api/reference", (c) => c.json({ location: location(c), data: [] }))

  app.post("/experimental/project/:projectID/copy", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    const sourceDirectory = directory(c)
    const projectID = c.req.param("projectID")
    if (
      !body ||
      body.strategy !== "git-worktree" ||
      typeof body.directory !== "string" ||
      projectIDForDirectory(sourceDirectory) !== projectID ||
      !existsSync(resolve(sourceDirectory, ".git"))
    ) {
      return projectCopyError(c, "Project copy requires a matching Git project and the git-worktree strategy")
    }
    const parent = resolve(body.directory)
    const baseName =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim().replaceAll(/[^a-zA-Z0-9._-]+/g, "-")
        : `copy-${Date.now().toString(36)}`
    const target = resolve(parent, baseName)
    if (target === parent || existsSync(target))
      return projectCopyError(c, `Project copy destination exists: ${target}`)
    mkdirSync(parent, { recursive: true })
    const result = await runGitWorktree(sourceDirectory, ["worktree", "add", target, "HEAD"])
    if (!result.ok) return projectCopyError(c, result.error)
    projectCopies.set(target, { projectID, sourceDirectory, directory: target })
    return c.json({ directory: target })
  })

  app.delete("/experimental/project/:projectID/copy", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!body || typeof body.directory !== "string" || typeof body.force !== "boolean") {
      return projectCopyError(c, "directory and force are required")
    }
    const target = resolve(body.directory)
    const copy = projectCopies.get(target)
    if (!copy || copy.projectID !== c.req.param("projectID")) {
      return projectCopyError(c, `Invalid project copy directory: ${target}`)
    }
    const result = await runGitWorktree(copy.sourceDirectory, [
      "worktree",
      "remove",
      ...(body.force ? ["--force"] : []),
      target,
    ])
    if (!result.ok) return projectCopyError(c, result.error, !body.force)
    projectCopies.delete(target)
    return c.body(null, 204)
  })

  app.post("/experimental/project/:projectID/copy/refresh", async (c) => {
    const projectID = c.req.param("projectID")
    for (const [copyDirectory, copy] of projectCopies) {
      if (copy.projectID === projectID && !existsSync(copyDirectory)) projectCopies.delete(copyDirectory)
    }
    return c.body(null, 204)
  })

  app.get("/api/pty", (c) => c.json({ location: location(c), data: options.ptys.list(directory(c)) }))
  app.post("/api/pty", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
    try {
      const pty = await options.ptys.create({
        command: typeof body.command === "string" ? body.command : undefined,
        args: Array.isArray(body.args)
          ? body.args.filter((arg: unknown): arg is string => typeof arg === "string")
          : [],
        directory: directory(c),
        cwd: typeof body.cwd === "string" ? resolve(directory(c), body.cwd) : directory(c),
        title: typeof body.title === "string" ? body.title : undefined,
        env:
          body.env && typeof body.env === "object" && !Array.isArray(body.env)
            ? Object.fromEntries(
                Object.entries(body.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
              )
            : undefined,
      })
      return c.json({ location: location(c), data: pty })
    } catch (error) {
      return c.json(
        { _tag: "InvalidRequestError", message: error instanceof Error ? error.message : String(error) },
        400,
      )
    }
  })
  app.get("/api/pty/:ptyID", (c) => {
    const pty = options.ptys.get(c.req.param("ptyID"), directory(c))
    if (!pty) {
      return c.json({ _tag: "PtyNotFoundError", message: "PTY not found" }, 404)
    }
    return c.json({ location: location(c), data: pty })
  })
  app.put("/api/pty/:ptyID", async (c) => {
    const existing = options.ptys.get(c.req.param("ptyID"), directory(c))
    if (!existing) {
      return c.json({ _tag: "PtyNotFoundError", message: "PTY not found" }, 404)
    }
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
    const size =
      body.size && typeof body.size === "object" && !Array.isArray(body.size)
        ? (body.size as { cols?: number; rows?: number })
        : undefined
    const pty = options.ptys.update(c.req.param("ptyID"), {
      title: typeof body.title === "string" ? body.title : undefined,
      size,
    })!
    return c.json({ location: location(c), data: pty })
  })
  app.delete("/api/pty/:ptyID", (c) => {
    const pty = options.ptys.get(c.req.param("ptyID"), directory(c))
    if (!pty || !options.ptys.remove(c.req.param("ptyID"))) {
      return c.json({ _tag: "PtyNotFoundError", message: "PTY not found" }, 404)
    }
    return c.body(null, 204)
  })

  app.post("/api/pty/:ptyID/connect-token", (c) => {
    if (c.req.header("x-opencode-ticket") !== "1") {
      return c.json({ _tag: "ForbiddenError", message: "Invalid PTY connect token request" }, 403)
    }
    const ticket = options.ptys.issueTicket(c.req.param("ptyID"), directory(c))
    if (!ticket) return c.json({ _tag: "PtyNotFoundError", message: "PTY not found" }, 404)
    return c.json({ location: location(c), data: ticket })
  })

  app.get("/api/pty/:ptyID/connect", (c) => {
    const pty = options.ptys.get(c.req.param("ptyID"), directory(c))
    if (!pty) return c.body(null, 404)
    return c.json({ _tag: "UpgradeRequiredError", message: "WebSocket upgrade required" }, 426)
  })

  return app
}

function defaultModel(providers: ProviderInfo[], sessions: SessionService): ProviderModel | undefined {
  const selected = sessions.resolveModel()
  if (selected) {
    const provider = providers.find((candidate) => candidate.id === selected.providerID)
    const model = provider?.models[selected.modelID]
    if (model) return model
  }
  for (const provider of providers) {
    const model = Object.values(provider.models)[0]
    if (model) return model
  }
  return undefined
}

function defaultModelRef(providers: ProviderInfo[], sessions: SessionService) {
  const model = defaultModel(providers, sessions)
  return model ? { id: model.id, providerID: model.providerID } : undefined
}

function toV2Provider(provider: ProviderInfo) {
  const model = Object.values(provider.models)[0]
  return {
    id: provider.id,
    name: provider.name,
    package: model?.api.npm || provider.id,
    settings: provider.options,
    headers: {},
    body: {},
  }
}

function toV2Model(model: ProviderModel) {
  return {
    id: model.id,
    modelID: model.api.id || model.id,
    providerID: model.providerID,
    name: model.name,
    package: model.api.npm || model.providerID,
    settings: model.options,
    headers: model.headers,
    body: {},
    capabilities: {
      tools: model.capabilities.toolcall,
      input: Object.entries(model.capabilities.input)
        .filter(([, enabled]) => enabled)
        .map(([type]) => type),
      output: Object.entries(model.capabilities.output)
        .filter(([, enabled]) => enabled)
        .map(([type]) => type),
    },
    variants: [],
    time: { released: model.release_date ? Date.parse(model.release_date) || 0 : 0 },
    cost: [model.cost],
    status: model.status,
    enabled: true,
    limit: model.limit,
  }
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

function toV2Permission(row: PermissionRow) {
  const metadata = JSON.parse(row.input) as Record<string, unknown>
  const resources = Array.isArray(metadata.resources)
    ? metadata.resources.filter((value): value is string => typeof value === "string")
    : []
  return {
    id: row.id,
    sessionID: row.session_id,
    action: row.tool,
    resources,
    metadata,
  }
}

function integrations(providerConfig: ProviderConfigStore) {
  return Object.entries(providerConfig.snapshot().provider ?? {}).map(([id, provider]) => ({
    id,
    name: provider.name ?? id,
    methods: [{ type: "key" as const, label: `API Key for ${provider.name ?? id}` }],
    connections: provider.apiKey
      ? [{ type: "credential" as const, id: `credential_${id}`, label: provider.name ?? id }]
      : [],
  }))
}

function providerForCredential(providerConfig: ProviderConfigStore, credentialID: string): string | undefined {
  return Object.keys(providerConfig.snapshot().provider ?? {}).find(
    (providerID) => `credential_${providerID}` === credentialID,
  )
}

function sessionNotFound(c: { json(value: unknown, status?: number): Response }, sessionID: string): Response {
  return c.json({ _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` }, 404)
}

function safePath(base: string, path: string): string | undefined {
  const target = resolve(base, path)
  const rel = relative(base, target)
  if (rel === ".." || rel.startsWith(`..${sep}`)) return undefined
  if (!existsSync(target)) return target
  const realBase = realpathSync(base)
  const realTarget = realpathSync(target)
  const realRel = relative(realBase, realTarget)
  if (realRel === ".." || realRel.startsWith(`..${sep}`)) return undefined
  return target
}

function findEntries(
  base: string,
  query: string,
  type: "file" | "directory" | undefined,
  limit: number,
): Array<{ path: string; type: "file" | "directory" }> {
  const results: Array<{ path: string; type: "file" | "directory" }> = []
  const walk = (directory: string, depth: number) => {
    if (depth > 8 || results.length >= limit) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue
      const target = resolve(directory, entry.name)
      try {
        if (lstatSync(target).isSymbolicLink()) continue
      } catch {
        continue
      }
      const entryType = entry.isDirectory() ? "directory" : "file"
      if (entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (!type || type === entryType)) {
        results.push({ path: relative(base, target), type: entryType })
        if (results.length >= limit) return
      }
      if (entry.isDirectory()) walk(target, depth + 1)
    }
  }
  walk(base, 0)
  return results
}

async function runGitWorktree(directory: string, args: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const process = Bun.spawn(["git", "-C", directory, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()])
    return exitCode === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `git exited with status ${exitCode}` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function projectCopyError(
  c: { json(value: unknown, status?: number): Response },
  message: string,
  forceRequired?: boolean,
): Response {
  return c.json(
    {
      name: "ProjectCopyError",
      data: {
        message,
        ...(forceRequired ? { forceRequired: true } : {}),
      },
    },
    400,
  )
}
