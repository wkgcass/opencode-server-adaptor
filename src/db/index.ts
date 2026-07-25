import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Logger } from "../logging/index.ts"
import { createMessageId, createPartId, isOrderedId } from "../id/index.ts"

export interface SessionRow {
  id: string
  directory: string
  title: string
  agent_id: string
  status: string
  created_at: number
  updated_at: number
  last_active_at: number
  metadata: string | null
  parent_id: string | null
}

export interface MessageRow {
  id: string
  session_id: string
  role: string
  created_at: number
  completed_at: number | null
  parent_id: string | null
  model_id: string | null
  provider_id: string | null
  agent: string
  data: string
}

export interface PartRow {
  id: string
  session_id: string
  message_id: string
  type: string
  data: string
  created_at: number
}

export interface PermissionRow {
  id: string
  session_id: string
  tool: string
  input: string
  status: string
  response: string | null
  created_at: number
  responded_at: number | null
  expires_at: number | null
}

export interface SessionEventRow {
  session_id: string
  seq: number
  id: string
  type: string
  data: string
  created_at: number
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    directory TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    agent_id TEXT NOT NULL DEFAULT 'default',
    status TEXT NOT NULL DEFAULT 'idle',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    metadata TEXT,
    parent_id TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    parent_id TEXT,
    model_id TEXT,
    provider_id TEXT,
    agent TEXT NOT NULL DEFAULT 'default',
    data TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS parts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    response TEXT,
    created_at INTEGER NOT NULL,
    responded_at INTEGER,
    expires_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS session_events (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_directory ON sessions(directory);
  CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_parts_session ON parts(session_id);
  CREATE INDEX IF NOT EXISTS idx_parts_message ON parts(message_id);
  CREATE INDEX IF NOT EXISTS idx_permissions_session ON permissions(session_id);
  CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, seq);
`

export class DatabaseService {
  private db: Database
  private readonly logger: Logger

  constructor(dbPath: string, logger: Logger) {
    const dir = dirname(dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(dbPath, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.logger = logger

    this.initializeSchema()
    this.normalizeLegacyIdentifiers()
  }

  /**
   * OpenCode clients sort messages and parts lexicographically by ID. Early
   * adaptor builds used random UUID fragments, which made the rendered order
   * nondeterministic. Rewrite an affected session as one atomic unit so old
   * databases gain the same monotonic IDs as newly created data.
   */
  private normalizeLegacyIdentifiers(): void {
    type RowWithOrder<T> = T & { rowid: number }
    const messages = this.db
      .query("SELECT rowid AS rowid, * FROM messages ORDER BY session_id ASC, created_at ASC, rowid ASC")
      .all() as Array<RowWithOrder<MessageRow>>
    const parts = this.db
      .query("SELECT rowid AS rowid, * FROM parts ORDER BY session_id ASC, message_id ASC, created_at ASC, rowid ASC")
      .all() as Array<RowWithOrder<PartRow>>

    const affected = new Set<string>()
    for (const message of messages) {
      if (!isOrderedId(message.id, "message")) affected.add(message.session_id)
    }
    for (const part of parts) {
      if (!isOrderedId(part.id, "part")) affected.add(part.session_id)
    }
    if (affected.size === 0) return

    for (const sessionId of affected) {
      const sessionMessages = messages.filter((row) => row.session_id === sessionId)
      const messageIds = new Map<string, string>()
      for (const row of sessionMessages) {
        messageIds.set(row.id, createMessageId(row.created_at))
      }

      const sessionParts = parts.filter((row) => row.session_id === sessionId)
      const partIds = new Map<string, string>()
      for (const row of sessionParts) {
        partIds.set(row.id, createPartId(row.created_at))
      }

      this.db.transaction(() => {
        const insertMessage = this.db.query(
          `INSERT INTO messages
            (id, session_id, role, created_at, completed_at, parent_id, model_id, provider_id, agent, data)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        for (const row of sessionMessages) {
          insertMessage.run(
            messageIds.get(row.id)!,
            row.session_id,
            row.role,
            row.created_at,
            row.completed_at,
            row.model_id,
            row.provider_id,
            row.agent,
            row.data,
          )
        }

        const insertPart = this.db.query(
          `INSERT INTO parts (id, session_id, message_id, type, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        for (const row of sessionParts) {
          insertPart.run(
            partIds.get(row.id)!,
            row.session_id,
            messageIds.get(row.message_id)!,
            row.type,
            row.data,
            row.created_at,
          )
        }

        this.db
          .query("DELETE FROM parts WHERE session_id = ? AND id NOT IN (SELECT value FROM json_each(?))")
          .run(sessionId, JSON.stringify([...partIds.values()]))
        this.db
          .query("DELETE FROM messages WHERE session_id = ? AND id NOT IN (SELECT value FROM json_each(?))")
          .run(sessionId, JSON.stringify([...messageIds.values()]))

        for (const row of sessionMessages) {
          if (!row.parent_id) continue
          const parentId = messageIds.get(row.parent_id) ?? row.parent_id
          this.db.query("UPDATE messages SET parent_id = ? WHERE id = ?").run(parentId, messageIds.get(row.id)!)
        }
      })()
    }

    this.logger.info("Normalized legacy OpenCode message and part identifiers", {
      sessions: affected.size,
    })
  }

  private initializeSchema(): void {
    this.db.exec(SCHEMA)
    this.logger.info("Database schema initialized")
  }

  prepare(sql: string): ReturnType<Database["prepare"]> {
    return this.db.prepare(sql)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  close(): void {
    try {
      this.db.close()
      this.logger.info("Database closed")
    } catch (err) {
      this.logger.error("Error closing database", { error: err instanceof Error ? err.message : String(err) })
    }
  }
}
