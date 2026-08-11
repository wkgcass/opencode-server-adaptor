import type { Logger } from "../logging/index.ts"
import { createEventId, orderedIdFormat, type OrderedIdFormat } from "../id/index.ts"

export interface OpenCodeEvent {
  id: string
  created?: number
  type: string
  metadata?: Record<string, unknown>
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  properties: Record<string, unknown>
}

export interface GlobalEvent {
  directory?: string
  project?: string
  workspace?: string
  payload: OpenCodeEvent
}

export interface CurrentOpenCodeEvent {
  id: string
  created?: number
  type: string
  metadata?: Record<string, unknown>
  durable?: {
    aggregateID: string
    seq: number
    version: number
  }
  data: Record<string, unknown>
  location?: {
    directory: string
  }
}

type EventListener = (event: OpenCodeEvent) => void
type GlobalEventListener = (event: GlobalEvent) => void

interface BufferedGlobalEvent {
  event: GlobalEvent
  publishedAt: number
}

/**
 * Desktop may need several seconds to notice that an adaptor process was
 * restarted and establish a new /api/event request. Preserve
 * events from that short subscriber-free window so a continued prompt is not
 * visible only after the user forces a history reload.
 */
export const GLOBAL_EVENT_RECONNECT_GRACE_MS = 60_000
export const GLOBAL_EVENT_RECONNECT_BACKLOG_LIMIT = 10_000

export class EventBus {
  private internalListeners = new Set<EventListener>()
  private globalListeners = new Set<GlobalEventListener>()
  private globalReconnectBacklog: BufferedGlobalEvent[] = []
  private globalReconnectBacklogDropped = 0
  private globalSubscriberGapLogged = false
  private readonly logger: Logger
  private readonly resolveDirectory?: (event: OpenCodeEvent) => string | undefined
  private readonly resolveIdFormat?: (event: OpenCodeEvent) => OrderedIdFormat

  constructor(
    logger: Logger,
    resolveDirectory?: (event: OpenCodeEvent) => string | undefined,
    resolveIdFormat?: (event: OpenCodeEvent) => OrderedIdFormat,
  ) {
    this.logger = logger
    this.resolveDirectory = resolveDirectory
    this.resolveIdFormat = resolveIdFormat
  }

  publish(event: OpenCodeEvent, directory?: string): void {
    const idFormat = this.resolveIdFormat?.(event) ?? "legacy"
    const publishedEvent =
      idFormat === "wide" && orderedIdFormat(event.id) !== "wide"
        ? { ...event, id: createEventId(undefined, "wide") }
        : event
    this.logger.debug("Event published", {
      type: publishedEvent.type,
      id: publishedEvent.id,
      globalListeners: this.globalListeners.size,
    })
    for (const listener of this.internalListeners) {
      try {
        listener(publishedEvent)
      } catch (err) {
        this.logger.error("Internal event listener error", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const globalEvent: GlobalEvent = {
      directory:
        directory ??
        (publishedEvent.properties as { directory?: string; info?: { directory?: string } }).directory ??
        (publishedEvent.properties as { info?: { directory?: string } }).info?.directory ??
        this.resolveDirectory?.(publishedEvent) ??
        process.cwd(),
      payload: publishedEvent,
    }
    if (this.globalListeners.size === 0) {
      this.bufferGlobalEvent(globalEvent)
      return
    }
    for (const listener of this.globalListeners) {
      try {
        listener(globalEvent)
      } catch (err) {
        this.logger.error("Global event listener error", { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  subscribeInternal(listener: EventListener): () => void {
    this.internalListeners.add(listener)
    return () => this.internalListeners.delete(listener)
  }

  subscribeGlobal(listener: GlobalEventListener): () => void {
    this.globalListeners.add(listener)
    this.replayBufferedGlobalEvents(listener)
    return () => this.globalListeners.delete(listener)
  }

  hasSubscribers(): boolean {
    return this.globalListeners.size > 0
  }

  close(): void {
    this.internalListeners.clear()
    this.globalListeners.clear()
    this.globalReconnectBacklog = []
    this.globalReconnectBacklogDropped = 0
    this.globalSubscriberGapLogged = false
  }

  private bufferGlobalEvent(event: GlobalEvent): void {
    const now = Date.now()
    const cutoff = now - GLOBAL_EVENT_RECONNECT_GRACE_MS
    const firstLiveIndex = this.globalReconnectBacklog.findIndex((item) => item.publishedAt >= cutoff)
    if (firstLiveIndex > 0) {
      this.globalReconnectBacklog.splice(0, firstLiveIndex)
    } else if (firstLiveIndex === -1) {
      this.globalReconnectBacklog = []
    }

    this.globalReconnectBacklog.push({ event, publishedAt: now })
    if (this.globalReconnectBacklog.length > GLOBAL_EVENT_RECONNECT_BACKLOG_LIMIT) {
      const overflow = this.globalReconnectBacklog.length - GLOBAL_EVENT_RECONNECT_BACKLOG_LIMIT
      this.globalReconnectBacklog.splice(0, overflow)
      this.globalReconnectBacklogDropped += overflow
    }

    if (!this.globalSubscriberGapLogged) {
      this.globalSubscriberGapLogged = true
      this.logger.warn("OpenCode event has no Desktop event-stream subscriber; buffering for reconnect", {
        type: event.payload.type,
        id: event.payload.id,
        graceMs: GLOBAL_EVENT_RECONNECT_GRACE_MS,
      })
    }
  }

  private replayBufferedGlobalEvents(listener: GlobalEventListener): void {
    const now = Date.now()
    const buffered = this.globalReconnectBacklog
    this.globalReconnectBacklog = []
    this.globalSubscriberGapLogged = false

    const cutoff = now - GLOBAL_EVENT_RECONNECT_GRACE_MS
    const replay = buffered.filter((item) => item.publishedAt >= cutoff)
    const expired = buffered.length - replay.length
    const dropped = this.globalReconnectBacklogDropped
    this.globalReconnectBacklogDropped = 0

    if (replay.length > 0 || expired > 0 || dropped > 0) {
      this.logger.info("Replaying OpenCode events buffered during Desktop event-stream reconnect", {
        replayed: replay.length,
        expired,
        dropped,
      })
    }

    for (const item of replay) {
      try {
        listener(item.event)
      } catch (err) {
        this.logger.error("Global event replay listener error", {
          type: item.event.payload.type,
          id: item.event.payload.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
}

export function createEvent(type: string, properties: Record<string, unknown>): OpenCodeEvent {
  return {
    id: createEventId(),
    type,
    properties,
  }
}

export function toCurrentOpenCodeEvent(event: GlobalEvent): CurrentOpenCodeEvent {
  return {
    id: event.payload.id,
    ...(event.payload.created === undefined ? {} : { created: event.payload.created }),
    type: event.payload.type,
    ...(event.payload.metadata ? { metadata: event.payload.metadata } : {}),
    ...(event.payload.durable ? { durable: event.payload.durable } : {}),
    data: event.payload.properties,
    ...(event.directory ? { location: { directory: event.directory } } : {}),
  }
}

export function formatCurrentSSE(event: CurrentOpenCodeEvent): string {
  const data = JSON.stringify(event)
  return `event: message\ndata: ${data}\n\n`
}
