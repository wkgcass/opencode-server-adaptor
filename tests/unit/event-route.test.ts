import { describe, expect, test } from "bun:test"
import { createEventRoutes, SSE_HEARTBEAT_INTERVAL_MS } from "../../src/api/routes/event.ts"
import {
  createEvent,
  EventBus,
  GLOBAL_EVENT_RECONNECT_BACKLOG_LIMIT,
  GLOBAL_EVENT_RECONNECT_GRACE_MS,
  type CurrentOpenCodeEvent,
} from "../../src/event/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { configureStreamingRequestTimeout } from "../../src/server.ts"

function createCurrentSseReader(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  return {
    async next(): Promise<CurrentOpenCodeEvent> {
      while (true) {
        const boundary = buffer.indexOf("\n\n")
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n")
          if (data) return JSON.parse(data) as CurrentOpenCodeEvent
        }

        const next = await reader.read()
        if (next.done) throw new Error("SSE stream ended")
        buffer += decoder.decode(next.value, { stream: true })
      }
    },
    cancel: () => reader.cancel(),
  }
}

describe("OpenCode Desktop event stream compatibility", () => {
  test("heartbeat arrives before Desktop's 15 second reconnect deadline", () => {
    expect(SSE_HEARTBEAT_INTERVAL_MS).toBeLessThan(15_000)
    expect(SSE_HEARTBEAT_INTERVAL_MS).toBe(10_000)
  })

  test("replays events produced before Desktop reconnects without replaying them twice", () => {
    const events = new EventBus(new Logger())
    const missed = createEvent("message.updated", { sessionID: "ses_restart" })
    events.publish(missed)

    const first: string[] = []
    const unsubscribe = events.subscribeGlobal((event) => first.push(event.payload.id))
    expect(first).toEqual([missed.id])
    unsubscribe()

    const second: string[] = []
    events.subscribeGlobal((event) => second.push(event.payload.id))()
    expect(second).toEqual([])
    events.close()
  })

  test("sends server.connected before events buffered during adaptor restart", async () => {
    const logger = new Logger()
    const events = new EventBus(logger)
    const missed = createEvent("message.part.updated", {
      sessionID: "ses_restart",
      part: { id: "prt_restart" },
    })
    events.publish(missed)

    const response = await createEventRoutes({ events, logger }).request("/api/event")
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let output = ""
    while (!output.includes(missed.id)) {
      const next = await reader.read()
      expect(next.done).toBe(false)
      output += decoder.decode(next.value, { stream: true })
    }

    expect(output.indexOf("server.connected")).toBeGreaterThanOrEqual(0)
    expect(output.indexOf("server.connected")).toBeLessThan(output.indexOf(missed.id))
    await reader.cancel()
    events.close()
  })

  test("keeps the reconnect replay window bounded", () => {
    expect(GLOBAL_EVENT_RECONNECT_GRACE_MS).toBe(60_000)
    expect(GLOBAL_EVENT_RECONNECT_BACKLOG_LIMIT).toBe(10_000)
  })

  test("serves current Desktop events from /api/event", async () => {
    const logger = new Logger()
    const events = new EventBus(logger, () => "/workspace")
    const response = await createEventRoutes({ events, logger }).request("/api/event")
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    const connected = JSON.parse(
      decoder
        .decode((await reader.read()).value)
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice(6),
    )
    expect(connected).toMatchObject({ type: "server.connected", data: {} })
    expect(connected).not.toHaveProperty("payload")

    const event = createEvent("message.updated", {
      sessionID: "ses_current",
      info: { id: "msg_current" },
    })
    events.publish(event)
    const current = JSON.parse(
      decoder
        .decode((await reader.read()).value)
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice(6),
    )
    expect(current).toEqual({
      id: event.id,
      type: "message.updated",
      data: event.properties,
      location: { directory: "/workspace" },
    })

    await reader.cancel()
    events.close()
  })

  test("broadcasts session and message lifecycle events identically to multiple clients", async () => {
    const logger = new Logger({ minLevel: "ERROR" })
    const events = new EventBus(logger, () => "/workspace")
    const app = createEventRoutes({ events, logger })
    const clients = await Promise.all(
      Array.from({ length: 3 }, async () => createCurrentSseReader(await app.request("/api/event"))),
    )

    try {
      const connected = await Promise.all(clients.map((client) => client.next()))
      expect(connected.map((event) => event.type)).toEqual(["server.connected", "server.connected", "server.connected"])

      const sessionID = "ses_multiple_clients"
      const messageID = "msg_multiple_clients"
      const partID = "prt_multiple_clients"
      const published = [
        createEvent("session.created", {
          sessionID,
          info: { id: sessionID, directory: "/workspace" },
        }),
        createEvent("message.updated", {
          sessionID,
          info: { id: messageID, sessionID, role: "assistant" },
        }),
        createEvent("message.part.updated", {
          sessionID,
          part: { id: partID, messageID, sessionID, type: "text", text: "shared" },
        }),
        createEvent("session.deleted", {
          sessionID,
          info: { id: sessionID, directory: "/workspace" },
        }),
      ]

      for (const event of published) events.publish(event)

      const received = await Promise.all(
        clients.map(async (client) => {
          const clientEvents: CurrentOpenCodeEvent[] = []
          for (let index = 0; index < published.length; index++) clientEvents.push(await client.next())
          return clientEvents
        }),
      )
      const expected = published.map((event) => ({
        id: event.id,
        type: event.type,
        data: event.properties,
        location: { directory: "/workspace" },
      }))

      for (const clientEvents of received) expect(clientEvents).toEqual(expected)
    } finally {
      await Promise.all(clients.map((client) => client.cancel()))
      events.close()
    }
  })

  test("disables Bun's idle timeout for every long-lived route", () => {
    const calls: Array<{ request: Request; seconds: number }> = []
    const server = {
      timeout(request: Request, seconds: number) {
        calls.push({ request, seconds })
      },
    }

    for (const path of ["/api/event", "/api/session/ses_1/event"]) {
      const request = new Request(`http://localhost${path}?directory=/workspace`)
      expect(configureStreamingRequestTimeout(request, server)).toBe(true)
      expect(calls.at(-1)).toEqual({ request, seconds: 0 })
    }

    const waitRequest = new Request("http://localhost/api/session/ses_1/wait", { method: "POST" })
    expect(configureStreamingRequestTimeout(waitRequest, server)).toBe(true)
    expect(calls.at(-1)).toEqual({ request: waitRequest, seconds: 0 })
  })

  test("keeps Bun's normal idle timeout for non-streaming requests", () => {
    let calls = 0
    const server = {
      timeout() {
        calls++
      },
    }

    expect(configureStreamingRequestTimeout(new Request("http://localhost/api/health"), server)).toBe(false)
    expect(
      configureStreamingRequestTimeout(new Request("http://localhost/api/event", { method: "POST" }), server),
    ).toBe(false)
    expect(configureStreamingRequestTimeout(new Request("http://localhost/api/session/ses_1/wait"), server)).toBe(false)
    expect(calls).toBe(0)
  })

  test("keeps a real Bun SSE response alive beyond the server idle timeout", async () => {
    const logger = new Logger()
    const events = new EventBus(logger)
    const app = createEventRoutes({ events, logger })
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 1,
      fetch(request, bunServer) {
        configureStreamingRequestTimeout(request, bunServer)
        return app.fetch(request)
      },
    })
    const abort = new AbortController()

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/event`, {
        signal: abort.signal,
      })
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      expect(decoder.decode((await reader.read()).value)).toContain("server.connected")

      // No heartbeat or application event is written during this pause. Without
      // server.timeout(request, 0), Bun resets the connection after one second.
      await Bun.sleep(1_250)
      events.publish(createEvent("test.after-idle", { alive: true }))

      const next = await Promise.race([
        reader.read(),
        Bun.sleep(2_000).then(() => {
          throw new Error("Timed out waiting for SSE after Bun idle timeout")
        }),
      ])
      expect(next.done).toBe(false)
      expect(decoder.decode(next.value)).toContain("test.after-idle")
      await reader.cancel()
    } finally {
      abort.abort()
      events.close()
      await server.stop(true)
    }
  })
})
