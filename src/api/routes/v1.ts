import { Hono } from "hono"
import type { AppConfig } from "../../config/index.ts"
import type { ProviderConfigStore } from "../../config/provider-config.ts"
import type { SessionService } from "../../session/session-service.ts"
import { SessionServiceError } from "../../session/session-service.ts"
import { loadProviderConfigObject } from "../provider.ts"

export function createV1Routes(options: {
  config: AppConfig
  providerConfig: ProviderConfigStore
  sessionService: SessionService
}): Hono {
  const app = new Hono()

  app.delete("/session/:sessionID", async (c) => {
    try {
      await options.sessionService.delete(c.req.param("sessionID"))
      return c.json(true, 200)
    } catch (error) {
      return v1Error(c, error)
    }
  })

  app.get("/config", (c) => {
    const file = options.providerConfig.snapshot()
    return c.json({
      $schema: undefined,
      logLevel: options.config.logLevel as "DEBUG" | "INFO" | "WARN" | "ERROR",
      share: "manual" as const,
      autoshare: false,
      autoupdate: "notify" as const,
      model: file.model,
      small_model: undefined,
      default_agent: options.config.defaultAgent,
      username: undefined,
      provider: loadProviderConfigObject(options.providerConfig),
      mcp: {},
      formatter: undefined,
      lsp: undefined,
      instructions: [],
      permission: undefined,
      tools: {},
      experimental: {
        disable_paste_summary: false,
        batch_tool: false,
        openTelemetry: false,
        primary_tools: [],
        continue_loop_on_deny: false,
      },
      compaction: {
        auto: true,
        prune: true,
        tail_turns: 0,
        preserve_recent_tokens: 0,
        reserved: 0,
      },
    })
  })

  return app
}

function v1Error(c: { json(value: unknown, status?: number): Response }, error: unknown): Response {
  const serviceError =
    error instanceof SessionServiceError
      ? error
      : new SessionServiceError("invalid_request", error instanceof Error ? error.message : String(error))
  if (serviceError.code === "not_found" || serviceError.code === "message_not_found") {
    return c.json({ name: "NotFoundError", data: { message: serviceError.message } }, 404)
  }
  return c.json({ name: "BadRequest", data: { message: serviceError.message } }, 400)
}
