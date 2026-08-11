import type { DatabaseService, SessionEventRow } from "../db/index.ts"
import { createEventId } from "../id/index.ts"
import type { OrderedIdFormat } from "../id/index.ts"
import type { Logger } from "../logging/index.ts"

export interface SessionDurableEvent {
  id: string
  created: number
  type: string
  metadata?: Record<string, unknown>
  durable: {
    aggregateID: string
    seq: number
    version: number
  }
  location?: {
    directory: string
  }
  data: Record<string, unknown>
}

type Listener = (event: SessionDurableEvent) => void

export class SessionEventStore {
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger,
    private readonly idFormats?: { getIdFormat(sessionId: string): OrderedIdFormat },
  ) {}

  append(
    sessionID: string,
    type: string,
    data: Record<string, unknown>,
    location?: { directory: string },
    options?: { id?: string; created?: number; metadata?: Record<string, unknown>; version?: number },
  ): SessionDurableEvent {
    const event = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_events WHERE session_id = ?")
        .get(sessionID) as { seq: number }
      const id = options?.id ?? createEventId(undefined, this.idFormats?.getIdFormat(sessionID) ?? "legacy")
      const created = options?.created ?? Date.now()
      const durable = { aggregateID: sessionID, seq: row.seq, version: options?.version ?? 1 }
      const stored = { durable, location, data, metadata: options?.metadata }
      this.db
        .prepare("INSERT INTO session_events (session_id, seq, id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(sessionID, row.seq, id, type, JSON.stringify(stored), created)
      return { id, created, type, durable, location, data, metadata: options?.metadata }
    })

    for (const listener of this.listeners.get(sessionID) ?? []) {
      try {
        listener(event)
      } catch (error) {
        this.logger.error("Session event listener error", {
          sessionID,
          type,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return event
  }

  list(sessionID: string, after = 0, limit = 50): { events: SessionDurableEvent[]; hasMore: boolean } {
    const rows = this.db
      .prepare("SELECT * FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
      .all(sessionID, after, limit + 1) as SessionEventRow[]
    return {
      events: rows.slice(0, limit).map(rowToEvent),
      hasMore: rows.length > limit,
    }
  }

  getById(id: string): SessionDurableEvent | null {
    const row = this.db.prepare("SELECT * FROM session_events WHERE id = ?").get(id) as SessionEventRow | null
    return row ? rowToEvent(row) : null
  }

  listByTypes(sessionID: string, types: readonly string[]): SessionDurableEvent[] {
    if (types.length === 0) return []
    const placeholders = types.map(() => "?").join(", ")
    const rows = this.db
      .prepare(`SELECT * FROM session_events WHERE session_id = ? AND type IN (${placeholders}) ORDER BY seq ASC`)
      .all(sessionID, ...types) as SessionEventRow[]
    return rows.map(rowToEvent)
  }

  subscribe(sessionID: string, listener: Listener): () => void {
    const listeners = this.listeners.get(sessionID) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(sessionID, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionID)
    }
  }

  close(): void {
    this.listeners.clear()
  }
}

function rowToEvent(row: SessionEventRow): SessionDurableEvent {
  const stored = JSON.parse(row.data) as {
    durable?: SessionDurableEvent["durable"]
    location?: SessionDurableEvent["location"]
    data?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }
  return {
    id: row.id,
    created: row.created_at,
    type: row.type,
    durable: stored.durable ?? { aggregateID: row.session_id, seq: row.seq, version: 1 },
    location: stored.location,
    data: stored.data ?? {},
    metadata: stored.metadata,
  }
}
