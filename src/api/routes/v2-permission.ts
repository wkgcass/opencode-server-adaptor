import { Hono } from "hono"
import type { SessionService } from "../../session/session-service.ts"
import { projectIDForDirectory } from "../../project/index.ts"
import { requestDirectory } from "../request-directory.ts"

export interface V2PermissionRoutesOptions {
  sessions: SessionService
}

/**
 * OpenCode Desktop always bootstraps the permission endpoints, even when the
 * connected backend has no interactive permission lifecycle. Keep these
 * stateless responses so discovery succeeds without retaining permission
 * requests or decisions in the adaptor.
 */
export function createV2PermissionRoutes(options: V2PermissionRoutesOptions): Hono {
  const app = new Hono()
  const location = (c: {
    req: { query(name: string): string | undefined; header(name: string): string | undefined }
  }) => {
    const directory = requestDirectory(c.req)
    return { directory, project: { id: projectIDForDirectory(directory), directory } }
  }

  app.get("/api/permission/request", (c) => c.json({ location: location(c), data: [] }))
  app.get("/api/permission/saved", (c) => c.json({ data: [] }))
  app.delete("/api/permission/saved/:id", (c) => c.body(null, 204))

  app.get("/api/session/:sessionID/permission", (c) => {
    const sessionID = c.req.param("sessionID")
    try {
      options.sessions.requireSession(sessionID)
      return c.json({ data: [] })
    } catch {
      return sessionNotFound(c, sessionID)
    }
  })

  app.post("/api/session/:sessionID/permission", (c) => {
    const sessionID = c.req.param("sessionID")
    try {
      options.sessions.requireSession(sessionID)
    } catch {
      return sessionNotFound(c, sessionID)
    }
    return c.json({ _tag: "InvalidRequestError", message: "Interactive permissions are not supported" }, 400)
  })

  app.get("/api/session/:sessionID/permission/:requestID", (c) => {
    const sessionID = c.req.param("sessionID")
    try {
      options.sessions.requireSession(sessionID)
    } catch {
      return sessionNotFound(c, sessionID)
    }
    return permissionNotFound(c, sessionID, c.req.param("requestID"))
  })

  app.post("/api/session/:sessionID/permission/:requestID/reply", (c) => {
    const sessionID = c.req.param("sessionID")
    try {
      options.sessions.requireSession(sessionID)
    } catch {
      return sessionNotFound(c, sessionID)
    }
    return permissionNotFound(c, sessionID, c.req.param("requestID"))
  })

  return app
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
      message: `Permission request not found: ${requestID}`,
    },
    404,
  )
}
