import { Hono } from "hono"
import type { Logger } from "./logging/index.ts"
import type { AppConfig } from "./config/index.ts"
import { DatabaseService } from "./db/index.ts"
import { SessionRepository } from "./session/index.ts"
import { MessageRepository } from "./message/index.ts"
import { EventBus } from "./event/index.ts"
import { createEventRoutes } from "./api/routes/event.ts"
import { AgentAdapterRegistry } from "./agents/registry.ts"
import { AgentService } from "./agents/agent-service.ts"
import { StubAgentAdapter } from "./agents/stub-adapter.ts"
import { installAgentIntegrations, type AgentIntegrationFactory } from "./agents/agent-integration.ts"
import { createPiAgentIntegration } from "./agents/pi/pi-integration.ts"
import { createV2SessionRoutes } from "./api/routes/v2-session.ts"
import { createV2Routes } from "./api/routes/v2.ts"
import { createV2PermissionRoutes } from "./api/routes/v2-permission.ts"
import { createV1Routes } from "./api/routes/v1.ts"
import { createV1CompatibleRoutes } from "./api/routes/v1-compatible.ts"
import { registerInteractionPayloadOptimizer } from "./logging/interaction-payload.ts"
import { ProviderConfigStore } from "./config/provider-config.ts"
import { SessionEventStore } from "./event/session-event-store.ts"
import { SessionService } from "./session/session-service.ts"
import { PtyManager, type PtySocketData } from "./api/pty-manager.ts"
import { requestDirectory } from "./api/request-directory.ts"
import { DEFAULT_API_VERSION, type ApiVersion } from "./api/version.ts"
import { PermissionRepository } from "./permission/index.ts"
import { SkillService } from "./skill/skill-service.ts"
import { CommandService } from "./skill/command-service.ts"

export interface ServerStartOptions {
  hostname: string
  port: number
  cors: string[]
  verbose: boolean
  disablePtyTokenCheck?: boolean
  disableV1Compatible?: boolean
  msgPartEncap?: boolean
  apiVersion?: ApiVersion
  config: AppConfig
  logger: Logger
}

export interface ServerHandle {
  port: number
  hostname: string
  close(): Promise<void>
}

export interface ServerReadiness {
  isReady(): boolean
  setReady(v: boolean): void
}

export interface RequestTimeoutController {
  timeout(request: Request, seconds: number): void
}

const STREAMING_EVENT_PATHS = new Set(["/api/event"])

/**
 * Bun applies its idle timeout while a response body is streaming. SSE
 * connections are intentionally long-lived and may be quiet between
 * heartbeats, so they must opt out per request. Keeping this scoped to event
 * routes preserves the normal timeout protection for every REST endpoint.
 */
export function configureStreamingRequestTimeout(request: Request, server: RequestTimeoutController): boolean {
  if (request.method !== "GET") return false
  const path = new URL(request.url).pathname
  if (!STREAMING_EVENT_PATHS.has(path) && !/^\/api\/session\/[^/]+\/event$/.test(path)) {
    return false
  }
  server.timeout(request, 0)
  return true
}

export function createReadiness(): ServerReadiness {
  let ready = false
  return {
    isReady: () => ready,
    setReady: (v: boolean) => {
      ready = v
    },
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const bufA = enc.encode(a)
  const bufB = enc.encode(b)
  if (bufA.length !== bufB.length) return false
  let result = 0
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i]! ^ bufB[i]!
  }
  return result === 0
}

function basicAuthMiddleware(username: string, password: string) {
  return async (c: any, next: () => Promise<void>) => {
    const authHeader = c.req.header("authorization")
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      return c.json({ error: "Unauthorized" }, 401)
    }
    try {
      const encoded = authHeader.slice(6)
      const decoded = Buffer.from(encoded, "base64").toString("utf-8")
      const colonIndex = decoded.indexOf(":")
      if (colonIndex === -1) {
        return c.json({ error: "Unauthorized" }, 401)
      }
      const user = decoded.slice(0, colonIndex)
      const pass = decoded.slice(colonIndex + 1)
      if (!timingSafeEqual(user, username) || !timingSafeEqual(pass, password)) {
        return c.json({ error: "Unauthorized" }, 401)
      }
    } catch {
      return c.json({ error: "Unauthorized" }, 401)
    }
    await next()
  }
}

function corsMiddleware(allowedOrigins: string[]) {
  return async (c: any, next: () => Promise<void>) => {
    const origin = c.req.header("origin")

    if (origin) {
      if (allowedOrigins.length > 0) {
        if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
          c.header("Access-Control-Allow-Origin", origin)
          c.header("Access-Control-Allow-Credentials", "true")
        }
      } else {
        c.header("Access-Control-Allow-Origin", origin)
        c.header("Access-Control-Allow-Credentials", "true")
      }
    }

    if (c.req.method === "OPTIONS") {
      c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-Requested-With, x-opencode-*")
      c.header("Access-Control-Max-Age", "86400")
      return c.body(null, 204)
    }

    await next()
  }
}

function payloadFromText(text: string, contentType: string | undefined): unknown {
  if (text.length === 0) return "<empty>"
  if (contentType?.toLowerCase().includes("json")) {
    try {
      return JSON.parse(text)
    } catch {}
  }
  return text
}

function interactionHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = key.toLowerCase() === "authorization" ? "<redacted>" : value
  })
  return result
}

export function verboseLoggingMiddleware(logger: Logger) {
  return async (c: any, next: () => Promise<void>) => {
    const start = Date.now()
    const method = c.req.method
    const path = c.req.path
    const request = c.req.raw as Request
    const query = new URL(request.url).search
    let requestText = ""
    try {
      requestText = await request.clone().text()
    } catch (error) {
      requestText = `<unable to read request body: ${error instanceof Error ? error.message : String(error)}>`
    }
    logger.interaction(
      "opencode",
      "in",
      {
        kind: "HTTP request",
        method,
        url: path + query,
        headers: interactionHeaders(request.headers),
      },
      payloadFromText(requestText, request.headers.get("content-type") ?? undefined),
    )

    await next()

    const duration = Date.now() - start
    const status = c.res.status
    const response = c.res as Response
    const contentType = response.headers.get("content-type") ?? undefined
    const isEventStream = contentType?.toLowerCase().includes("text/event-stream") ?? false
    let responsePayload: unknown = "<stream; individual SSE messages are logged separately>"
    if (!isEventStream) {
      try {
        responsePayload = payloadFromText(await response.clone().text(), contentType)
      } catch (error) {
        responsePayload = `<unable to read response body: ${error instanceof Error ? error.message : String(error)}>`
      }
    }
    logger.interaction(
      "opencode",
      "out",
      {
        kind: "HTTP response",
        method,
        url: path + query,
        status,
        durationMs: duration,
        headers: interactionHeaders(response.headers),
      },
      responsePayload,
      {
        omitPayload: method === "GET" && (path === "/api/session" || path === "/api/session/active"),
      },
    )
  }
}

export interface ServerContext {
  app: Hono
  db: DatabaseService
  sessions: SessionRepository
  messages: MessageRepository
  permissions: PermissionRepository
  events: EventBus
  agentService: AgentService
  sessionService: SessionService
  sessionEvents: SessionEventStore
  ptys: PtyManager
  skills: SkillService
  commands: CommandService
  readiness: ServerReadiness
  logger: Logger
}

export interface ServerContextOptions {
  cors?: string[]
  verbose?: boolean
  /**
   * Replaces the built-in Pi integration set. This is primarily useful for
   * embedding the server with another backend and for contract testing.
   */
  agentIntegrations?: readonly AgentIntegrationFactory[]
  /**
   * Skips the PTY WebSocket connect-ticket check. Use only when the client
   * cannot obtain a connect token (e.g. an OpenCode Desktop v2 build whose
   * PTY connectToken call is not wired up).
   */
  disablePtyTokenCheck?: boolean
  /**
   * Selects the API surface: v1 mounts the legacy v1 routes, v2 mounts the
   * v2 routes. The v1-compatible routes (DELETE /session/:id, GET /config) are
   * always mounted unless disableV1Compatible is set. Defaults to v2.
   */
  apiVersion?: ApiVersion
  /**
   * Skips mounting the v1-compatible routes (GET /config, DELETE /session/:id).
   */
  disableV1Compatible?: boolean
  /** Places each server-generated assistant part in its own sibling message. */
  msgPartEncap?: boolean
}

export function createServerContext(config: AppConfig, logger: Logger, options?: ServerContextOptions): ServerContext {
  const apiVersion = options?.apiVersion ?? DEFAULT_API_VERSION
  const cors = options?.cors ?? []
  const verbose = options?.verbose ?? false
  const readiness = createReadiness()

  const db = new DatabaseService(config.databasePath, logger)
  const providerConfig = new ProviderConfigStore(config.providerConfigPath, logger)
  const sessions = new SessionRepository(db, config.compatibilityVersion)
  const messages = new MessageRepository(db, sessions)
  const permissions = new PermissionRepository(db)
  const startupSessionIds = new Set(sessions.list().map((session) => session.id))
  const eventSessionID = (event: { properties: Record<string, unknown> }): string | undefined => {
    const properties = event.properties as {
      sessionID?: string
      info?: { sessionID?: string }
      part?: { sessionID?: string }
    }
    return properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID
  }
  const events = new EventBus(
    logger,
    (event) => {
      const sessionID = eventSessionID(event)
      return sessionID ? sessions.getDirectory(sessionID) : undefined
    },
    (event) => {
      const sessionID = eventSessionID(event)
      return sessionID ? sessions.getIdFormat(sessionID) : "legacy"
    },
  )
  const ptys = new PtyManager(events, logger, options?.disablePtyTokenCheck ?? false)

  const registry = new AgentAdapterRegistry()
  registry.register(new StubAgentAdapter())
  const integrations = (options?.agentIntegrations ?? [createPiAgentIntegration]).map((factory) =>
    factory({ config, db, providerConfig, logger }),
  )
  const installedIntegrations = installAgentIntegrations(registry, integrations, config.defaultAgent)
  for (const registration of installedIntegrations.interactionPayloadOptimizers) {
    registerInteractionPayloadOptimizer(registration.channel, registration.optimizer)
  }
  const effectiveDefaultAgent = registry.has(config.defaultAgent) ? config.defaultAgent : registry.getDefault().id
  registry.setDefault(effectiveDefaultAgent)
  const builtinProviders = installedIntegrations.providers
  const providerConfigListeners = installedIntegrations.providerConfigListeners
  const defaultAdapterType = installedIntegrations.defaultAdapterType ?? effectiveDefaultAgent
  const skills = new SkillService(logger, { directories: installedIntegrations.skillDirectories })
  const commands = new CommandService(skills)

  const agentService = new AgentService(registry, sessions, messages, events, logger, config, permissions, skills, {
    encapsulateMessageParts: options?.msgPartEncap,
  })
  const sessionEvents = new SessionEventStore(db, logger, sessions)
  const sessionService = new SessionService(
    sessions,
    messages,
    events,
    sessionEvents,
    agentService,
    effectiveDefaultAgent,
    config,
    providerConfig,
    builtinProviders,
    startupSessionIds,
    commands,
  )

  agentService.recoverOnStartup()

  const app = new Hono()

  app.use("*", corsMiddleware(cors))

  if (verbose) {
    app.use("*", verboseLoggingMiddleware(logger))
  }

  if (config.serverPassword) {
    const username = config.serverUsername ?? "opencode"
    const password = config.serverPassword
    app.use("*", basicAuthMiddleware(username, password))
  }

  app.get("/api/health", (c) => {
    if (!readiness.isReady()) {
      return c.json({ status: "starting" }, 503)
    }
    return c.json({ healthy: true, version: config.compatibilityVersion, pid: process.pid })
  })

  // The v1-compatible routes (DELETE /session/:id, GET /config) have no v2
  // counterpart and are mounted in both api versions unless explicitly disabled.
  if (!options?.disableV1Compatible) {
    app.route("/", createV1CompatibleRoutes({ config, providerConfig, sessionService: sessionService }))
  }

  if (apiVersion === "v1") {
    app.route(
      "/",
      createV1Routes({
        sessionService,
        registry,
        config,
        providerConfig,
        builtinProviders,
        providerConfigListeners,
      }),
    )
  } else {
    app.route("/", createV2SessionRoutes({ service: sessionService, logger }))
    app.route(
      "/",
      createV2Routes({
        registry,
        config,
        providerConfig,
        builtinProviders,
        sessions: sessionService,
        ptys,
        defaultAdapterType,
        providerConfigListeners,
        skills,
        commands,
      }),
    )
    app.route("/", createV2PermissionRoutes({ sessions: sessionService, permissions, agentService, events }))
    app.route("/", createEventRoutes({ events, logger }))
  }

  app.all("*", (c) => c.text(`Cannot ${c.req.method} ${c.req.url}`, 404))

  return {
    app,
    db,
    sessions,
    messages,
    permissions,
    events,
    agentService,
    sessionService,
    sessionEvents,
    ptys,
    skills,
    commands,
    readiness,
    logger,
  }
}

async function checkPortAvailable(hostname: string, port: number): Promise<void> {
  if (port === 0) return
  const checkHost = hostname === "0.0.0.0" ? "127.0.0.1" : hostname
  try {
    const socket = await Bun.connect({
      hostname: checkHost,
      port,
      socket: {
        data() {},
        error() {},
      },
    })
    socket.end()
    throw new Error(`Port ${port} is already in use`)
  } catch (err) {
    if (err instanceof Error && err.message.includes("already in use")) {
      throw err
    }
  }
}

export async function startServer(options: ServerStartOptions): Promise<ServerHandle> {
  const { hostname, port, config, logger } = options
  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION

  await checkPortAvailable(hostname, port)

  const ctx = createServerContext(config, logger, {
    cors: options.cors,
    verbose: options.verbose,
    disablePtyTokenCheck: options.disablePtyTokenCheck,
    disableV1Compatible: options.disableV1Compatible,
    msgPartEncap: options.msgPartEncap,
    apiVersion: options.apiVersion,
  })
  const { app, db, events, agentService, sessionService, sessionEvents, ptys, readiness } = ctx

  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve<PtySocketData>({
      hostname,
      port,
      fetch(request, bunServer) {
        configureStreamingRequestTimeout(request, bunServer)
        if (request.method === "GET" && /^\/api\/pty\/[^/]+\/connect$/.test(new URL(request.url).pathname)) {
          const url = new URL(request.url)
          return ptys.tryUpgrade(
            request,
            bunServer,
            requestDirectory({
              query: (name) => url.searchParams.get(name) ?? undefined,
              header: (name) => request.headers.get(name) ?? undefined,
            }),
          )
        }
        return app.fetch(request)
      },
      websocket: {
        open(socket) {
          ptys.open(socket)
        },
        message(socket, message) {
          ptys.message(socket, message)
        },
        close(socket) {
          ptys.closeSocket(socket)
        },
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error("Failed to start HTTP server", { hostname, port, error: msg })
    throw new Error(`Failed to start HTTP server on ${hostname}:${port}: ${msg}`)
  }

  logger.info("HTTP server listening", { hostname, port, apiVersion })

  readiness.setReady(true)
  logger.info("Server is ready", { hostname, port, apiVersion })

  let closed = false
  const cleanup = async (): Promise<void> => {
    if (closed) return
    closed = true
    logger.info("Shutting down server", { hostname, port })
    readiness.setReady(false)
    await agentService.closeAll()
    ptys.close()
    sessionService.close()
    sessionEvents.close()
    events.close()
    try {
      server.stop(true)
      logger.info("Server stopped", { hostname, port })
    } catch (err) {
      logger.error("Error stopping server", { error: err instanceof Error ? err.message : String(err) })
    }
    db.close()
  }

  const handleSignal = (signal: string): void => {
    logger.info("Received signal, shutting down", { signal })
    cleanup().then(() => {
      process.exit(0)
    })
  }

  process.on("SIGTERM", () => handleSignal("SIGTERM"))
  process.on("SIGINT", () => handleSignal("SIGINT"))

  return {
    port: server.port ?? port,
    hostname,
    async close() {
      await cleanup()
    },
  }
}
