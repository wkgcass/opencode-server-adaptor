import { Hono } from "hono"
import type { EventBus } from "../../event/index.ts"
import type { Logger } from "../../logging/index.ts"
import { createEvent, formatCurrentSSE, toCurrentOpenCodeEvent, type CurrentOpenCodeEvent } from "../../event/index.ts"

// OpenCode Desktop currently reconnects a stream after 15 seconds without an
// event. Keep this comfortably below that deadline; matching it exactly creates
// a timer race that can drop terminal message/session events during reconnect.
export const SSE_HEARTBEAT_INTERVAL_MS = 10_000

export function createEventRoutes(options: { events: EventBus; logger: Logger }): Hono {
  const app = new Hono()
  const { events, logger } = options

  function createSSEStream<Event>(
    subscribe: (cb: (event: Event) => void) => () => void,
    format: (event: Event) => string,
    connected: Event,
    makeHeartbeat: () => Event,
    signal: AbortSignal | undefined,
    path: string,
  ): Response {
    let cancelStream: (() => void) | undefined
    const stream = new ReadableStream({
      start(controller) {
        const queue: string[] = []
        let closed = false
        let heartbeatTimer: ReturnType<typeof setInterval> | undefined
        let unsubscribe: (() => void) | undefined

        const cleanup = (reason: "client_abort" | "stream_cancel" | "write_error", error?: unknown) => {
          if (closed) return
          closed = true
          unsubscribe?.()
          if (heartbeatTimer) clearInterval(heartbeatTimer)
          signal?.removeEventListener("abort", onAbort)
          logger.debug("SSE stream closed", {
            path,
            reason,
            ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
          })
          try {
            if (error) {
              controller.error(error)
            } else {
              controller.close()
            }
          } catch {}
        }

        const onAbort = () => cleanup("client_abort")

        const logEvent = (event: Event) => {
          if ((event as { type?: unknown }).type === "server.heartbeat") return
          logger.interaction("opencode", "out", { kind: "SSE message", path }, event)
        }

        const flush = () => {
          if (closed) return
          while (queue.length > 0) {
            const data = queue.shift()!
            try {
              controller.enqueue(new TextEncoder().encode(data))
            } catch (error) {
              // Never leave a response alive after its EventBus subscription
              // has been removed. A half-open stream prevents Desktop from
              // observing EOF and reconnecting, so all later events disappear
              // until a tab navigation forces a history reload.
              cleanup("write_error", error)
              return
            }
          }
        }

        cancelStream = () => cleanup("stream_cancel")

        signal?.addEventListener("abort", onAbort)
        if (signal?.aborted) {
          cleanup("client_abort")
          return
        }
        logEvent(connected)
        queue.push(format(connected))
        flush()
        if (closed) return

        // Subscribe only after server.connected has been enqueued. EventBus may
        // synchronously replay events buffered while the adaptor had no
        // Desktop connection, and clients must observe the reconnect boundary
        // before those application events.
        const stopSubscription = subscribe((event) => {
          if (closed) return
          try {
            logEvent(event)
            queue.push(format(event))
            flush()
          } catch (error) {
            cleanup("write_error", error)
          }
        })
        if (closed) {
          stopSubscription()
          return
        }
        unsubscribe = stopSubscription

        heartbeatTimer = setInterval(() => {
          if (closed) return
          try {
            const heartbeat = makeHeartbeat()
            logEvent(heartbeat)
            queue.push(format(heartbeat))
            flush()
          } catch (error) {
            cleanup("write_error", error)
          }
        }, SSE_HEARTBEAT_INTERVAL_MS)
      },
      cancel() {
        cancelStream?.()
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    })
  }

  app.get("/api/event", (c) => {
    return createSSEStream<CurrentOpenCodeEvent>(
      (cb) => events.subscribeGlobal((event) => cb(toCurrentOpenCodeEvent(event))),
      formatCurrentSSE,
      {
        id: createEvent("server.connected", {}).id,
        type: "server.connected",
        data: {},
      },
      () => ({
        id: createEvent("server.heartbeat", {}).id,
        type: "server.heartbeat",
        data: {},
      }),
      c.req.raw.signal,
      "/api/event",
    )
  })

  return app
}
