import { Hono } from "hono"
import type { AgentService } from "../../agents/agent-service.ts"
import type { EventBus } from "../../event/index.ts"
import { createEvent } from "../../event/index.ts"
import type { Permission, PermissionRepository } from "../../permission/index.ts"
import { projectIDForDirectory } from "../../project/index.ts"
import type { SessionService } from "../../session/session-service.ts"
import { requestDirectory } from "../request-directory.ts"

export interface V2PermissionRoutesOptions {
  sessions: SessionService
  permissions: PermissionRepository
  agentService: AgentService
  events: EventBus
}

/** Routes for the complete v2 permission lifecycle. */
export function createV2PermissionRoutes(options: V2PermissionRoutesOptions): Hono {
  const app = new Hono()
  const location = (c: {
    req: { query(name: string): string | undefined; header(name: string): string | undefined }
  }) => {
    const directory = requestDirectory(c.req)
    return { directory, project: { id: projectIDForDirectory(directory), directory } }
  }

  app.get("/api/permission/request", (c) => {
    const current = requestDirectory(c.req)
    return c.json({
      location: location(c),
      data: options.permissions.listPendingByDirectory(current).map(toV2Permission),
    })
  })

  app.get("/api/permission/saved", (c) => c.json({ data: [] }))
  app.delete("/api/permission/saved/:id", (c) => c.body(null, 204))

  app.get("/api/session/:sessionID/permission", (c) => {
    const sessionID = c.req.param("sessionID")
    try {
      options.sessions.requireSession(sessionID)
      return c.json({ data: options.permissions.listPendingBySession(sessionID).map(toV2Permission) })
    } catch {
      return sessionNotFound(c, sessionID)
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
      options.permissions.create({ id, sessionId: sessionID, tool: body.action, input })
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
    const sessionID = c.req.param("sessionID")
    try {
      options.sessions.requireSession(sessionID)
    } catch {
      return sessionNotFound(c, sessionID)
    }
    const row = options.permissions.getPending(sessionID, c.req.param("requestID"))
    if (!row) return permissionNotFound(c, sessionID, c.req.param("requestID"))
    return c.json({ data: toV2Permission(row) })
  })

  app.post("/api/session/:sessionID/permission/:requestID/reply", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!body || !["once", "always", "reject"].includes(String(body.reply))) {
      return c.json({ _tag: "InvalidRequestError", message: "Invalid permission reply" }, 400)
    }
    const sessionID = c.req.param("sessionID")
    const requestID = c.req.param("requestID")
    const row = options.permissions.getPending(sessionID, requestID)
    if (!row) {
      try {
        options.sessions.requireSession(sessionID)
      } catch {
        return sessionNotFound(c, sessionID)
      }
      return permissionNotFound(c, sessionID, requestID)
    }
    const action = body.reply === "reject" ? "deny" : "allow"
    const message = typeof body.message === "string" ? body.message : undefined
    if (!options.permissions.resolve(row.id, action, message)) {
      return permissionNotFound(c, sessionID, requestID)
    }
    await options.agentService.respondToPermission(row.sessionId, row.id, action, message)
    options.events.publish(
      createEvent("permission.replied", {
        sessionID: row.sessionId,
        requestID: row.id,
        reply: body.reply,
      }),
    )
    return c.body(null, 204)
  })

  return app
}

function toV2Permission(row: Permission) {
  const metadata = row.input
  const resources = Array.isArray(metadata.resources)
    ? metadata.resources.filter((value): value is string => typeof value === "string")
    : []
  return {
    id: row.id,
    sessionID: row.sessionId,
    action: row.tool,
    resources,
    metadata,
  }
}

function sessionNotFound(c: { json(value: unknown, status?: number): Response }, sessionID: string): Response {
  return c.json({ _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` }, 404)
}

function permissionNotFound(
  c: { json(value: unknown, status?: number): Response },
  sessionID: string,
  requestID: string,
): Response {
  return c.json(
    {
      _tag: "PermissionNotFoundError",
      sessionID,
      requestID,
      message: `Permission not found: ${requestID}`,
    },
    404,
  )
}
