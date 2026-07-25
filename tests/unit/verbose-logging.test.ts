import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Logger } from "../../src/logging/index.ts"
import { verboseLoggingMiddleware } from "../../src/server.ts"
import { EventBus } from "../../src/event/index.ts"
import { createEventRoutes } from "../../src/api/routes/event.ts"
import { optimizePiInteractionPayload } from "../../src/agents/pi/pi-interaction-payload.ts"
import { registerInteractionPayloadOptimizer } from "../../src/logging/interaction-payload.ts"

registerInteractionPayloadOptimizer("pi", optimizePiInteractionPayload)

const ANSI_BLUE = "\u001b[94m"
const ANSI_CYAN = "\u001b[96m"
const ANSI_MAGENTA = "\u001b[95m"
const ANSI_WHITE = "\u001b[97m"
const ANSI_ORANGE = "\u001b[38;5;208m"

function capturingLogger(options?: { verbose?: boolean }): { logger: Logger; output: () => string } {
  let text = ""
  const logger = new Logger({
    minLevel: "DEBUG",
    printLogs: true,
    verbose: options?.verbose ?? true,
    stream: { write: (data) => void (text += data) },
  })
  return { logger, output: () => text }
}

describe("human-readable verbose interaction logging", () => {
  test("uses channel colors and prints an untruncated payload as single-line JSON", () => {
    const capture = capturingLogger()
    const longText = "complete payload ".repeat(40)

    capture.logger.interaction(
      "opencode",
      "in",
      { kind: "HTTP request", method: "POST", url: "/session" },
      { prompt: longText, nested: { enabled: true } },
    )
    capture.logger.interaction("pi", "out", { stream: "stdin", type: "prompt" }, { message: longText })

    const output = capture.output()
    expect(output).toContain(`${ANSI_BLUE}`)
    expect(output).toContain("[OpenCode Request →]")
    expect(output).toContain(`${ANSI_MAGENTA}`)
    expect(output).toContain("[Pi ←]")
    expect(output).toContain(`${ANSI_WHITE}Request Payload: {`)
    expect(output).toContain(longText)
    expect(output).toContain('"nested":{"enabled":true}')
    const payloadLines = output.split("\n").filter((line) => line.includes("Payload:"))
    expect(payloadLines).toHaveLength(2)
    expect(payloadLines.every((line) => line.includes("complete payload"))).toBe(true)
    expect(output).not.toContain('{"level":')
  })

  test("ordinary logs are human-readable instead of JSON records", () => {
    const capture = capturingLogger({ verbose: false })
    capture.logger.info("Server is ready", { port: 4096, healthy: true })

    const output = capture.output()
    expect(output).toContain("[INFO]")
    expect(output).toContain("Server is ready")
    expect(output).toContain("port=4096")
    expect(output).not.toContain('"level":"INFO"')
  })

  test("renders WARN logs in orange", () => {
    const capture = capturingLogger({ verbose: false })
    capture.logger.warn("Pi event produced no OpenCode event", { piEvent: "turn_start" })

    const output = capture.output()
    expect(output).toContain(`${ANSI_ORANGE}[WARN]`)
    expect(output).toContain("Pi event produced no OpenCode event")
    expect(output).toContain("piEvent=turn_start")
  })

  test("interaction records stay disabled without --verbose", () => {
    const capture = capturingLogger({ verbose: false })
    capture.logger.interaction("pi", "in", { type: "secret" }, { complete: true })
    expect(capture.output()).toBe("")
  })

  test("HTTP middleware logs complete request and response payloads", async () => {
    const capture = capturingLogger()
    const app = new Hono()
    app.use("*", verboseLoggingMiddleware(capture.logger))
    app.post("/echo", async (c) => {
      const body = await c.req.json()
      return c.json({ echoed: body, extra: "response detail" }, 201)
    })

    const response = await app.request("/echo?source=desktop", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Basic must-not-be-printed",
      },
      body: JSON.stringify({ message: "完整请求", parts: [{ type: "text", text: "hello" }] }),
    })
    expect(response.status).toBe(201)

    const output = capture.output()
    expect(output).toContain(`${ANSI_BLUE}`)
    expect(output).toContain("[OpenCode Request →]")
    expect(output).toContain("Request Payload:")
    expect(output).toContain("url=/echo?source=desktop")
    expect(output).toContain('"message":"完整请求"')
    expect(output).toContain('"parts":[{"type":"text","text":"hello"}]')
    expect(output).toContain(`${ANSI_CYAN}`)
    expect(output).toContain("[OpenCode Response ←]")
    expect(output).toContain("Response Payload:")
    expect(output).toContain("status=201")
    expect(output).toContain('"extra":"response detail"')
    expect(output).toContain("<redacted>")
    expect(output).not.toContain("must-not-be-printed")
    expect(output.match(/\[OpenCode Request →]/g)).toHaveLength(1)
    expect(output.match(/\[OpenCode Response ←]/g)).toHaveLength(1)
    expect(output.match(/Request Payload:/g)).toHaveLength(1)
    expect(output.match(/Response Payload:/g)).toHaveLength(1)
  })

  test("v2 active-session polling logs response metadata but suppresses its repetitive payload", async () => {
    const capture = capturingLogger()
    const app = new Hono()
    app.use("*", verboseLoggingMiddleware(capture.logger))
    app.get("/api/session/active", (c) =>
      c.json({
        data: {
          ses_one: { type: "idle" },
          ses_two: { type: "busy" },
        },
      }),
    )

    const response = await app.request("/api/session/active?directory=%2Fworkspace")
    expect(response.status).toBe(200)

    const output = capture.output()
    expect(output).toContain("[OpenCode Request →]")
    expect(output).toContain("url=/api/session/active?directory=%2Fworkspace")
    expect(output).toContain("Request Payload:")
    expect(output).toContain("[OpenCode Response ←]")
    expect(output).toContain("status=200")
    expect(output).not.toContain("Response Payload:")
    expect(output).not.toContain("ses_one")
    expect(output).not.toContain("ses_two")
  })

  test("GET /api/session logs response metadata without its payload", async () => {
    const capture = capturingLogger()
    const app = new Hono()
    app.use("*", verboseLoggingMiddleware(capture.logger))
    app.get("/api/session", (c) =>
      c.json({
        sessions: [{ id: "ses_one", title: "payload must not be logged" }],
        total: 1,
      }),
    )

    const response = await app.request("/api/session?directory=%2Fworkspace")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sessions: [{ id: "ses_one", title: "payload must not be logged" }],
      total: 1,
    })

    const output = capture.output()
    expect(output).toContain("[OpenCode Response ←]")
    expect(output).toContain("url=/api/session?directory=%2Fworkspace")
    expect(output).toContain("status=200")
    expect(output).not.toContain("Response Payload:")
    expect(output).not.toContain("payload must not be logged")
  })

  test("session message responses stay complete on the wire but use compact verbose logs", async () => {
    const capture = capturingLogger()
    const app = new Hono()
    app.use("*", verboseLoggingMiddleware(capture.logger))
    app.get("/api/session/:id/message", (c) =>
      c.json({
        data: [
          {
            id: "msg_1",
            type: "assistant",
            time: { created: 1, completed: 2 },
            finish: "stop",
            content: [
              {
                id: "prt_1",
                type: "text",
                text: "complete response that must remain on the HTTP wire",
              },
            ],
          },
        ],
        cursor: {},
      }),
    )

    const response = await app.request("/api/session/ses_1/message?directory=%2Fworkspace")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ content: Array<{ text: string }> }> }
    expect(body.data[0]!.content[0]!.text).toBe("complete response that must remain on the HTTP wire")

    const output = capture.output()
    expect(output).toContain('"textLength":51')
    expect(output).not.toContain("complete response that must remain on the HTTP wire")
  })

  test("SSE logs the complete event at the point it is written", async () => {
    const capture = capturingLogger()
    const events = new EventBus(capture.logger)
    const app = createEventRoutes({ events, logger: capture.logger })
    const response = await app.request("/api/event")
    const reader = response.body!.getReader()

    try {
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain("server.connected")
    } finally {
      await reader.cancel()
      events.close()
    }

    const output = capture.output()
    expect(output).toContain("kind=SSE message")
    expect(output).toContain("path=/api/event")
    expect(output).toContain('"type":"server.connected"')
  })

  test("escapes embedded newlines so every payload remains on one physical line", () => {
    const capture = capturingLogger()
    capture.logger.interaction("pi", "in", { stream: "stdout" }, { text: "first\nsecond", value: 1n })

    const payloadLine = capture
      .output()
      .split("\n")
      .find((line) => line.includes("Payload:"))
    expect(payloadLine).toContain('{"text":"first\\nsecond","value":"1"}')
    expect(capture.output().split("\n")).toHaveLength(3)
  })
})
