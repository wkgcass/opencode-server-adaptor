import type { DatabaseService } from "../db/index.ts"
import type { SessionRow } from "../db/index.ts"
import { resolve } from "node:path"
import { OPENCODE_COMPAT_VERSION } from "../config/index.ts"
import { projectIDForDirectory } from "../project/index.ts"
import { createSessionId } from "../id/index.ts"

export interface Session {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  agent: string
  version: string
  time: {
    created: number
    updated: number
    archived?: number
  }
  status: string
  parentID?: string
  model?: { id: string; providerID: string; variant?: string }
  metadata?: Record<string, unknown>
  permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
  revert?: {
    messageID: string
    partID?: string
  }
}

export interface SessionCreateInput {
  id?: string
  directory?: string
  title?: string
  agent?: string
  parentId?: string
  parentID?: string
  model?: { id: string; providerID: string; variant?: string }
  metadata?: Record<string, unknown>
  permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
}

export interface SessionUpdateInput {
  title?: string
  status?: string
  directory?: string
  agent?: string
  model?: Session["model"]
  time?: { archived?: number | null }
}

interface StoredSessionMetadata {
  model?: Session["model"]
  metadata?: Session["metadata"]
  permission?: Session["permission"]
  archived?: number
  revert?: Session["revert"]
}

function parseMetadata(value: string | null): StoredSessionMetadata {
  if (!value) return {}
  try {
    return JSON.parse(value) as StoredSessionMetadata
  } catch {
    return {}
  }
}

function generateId(): string {
  return createSessionId()
}

function rowToSession(row: SessionRow, compatibilityVersion: string): Session {
  const stored = parseMetadata(row.metadata)
  return {
    id: row.id,
    slug: row.id.slice(0, 8),
    projectID: projectIDForDirectory(row.directory),
    directory: row.directory,
    title: row.title,
    agent: row.agent_id,
    version: compatibilityVersion,
    time: {
      created: row.created_at,
      updated: row.updated_at,
      archived: stored.archived,
    },
    status: row.status,
    parentID: row.parent_id ?? undefined,
    model: stored.model,
    metadata: stored.metadata,
    permission: stored.permission,
    revert: stored.revert,
  }
}

export class SessionRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly compatibilityVersion = OPENCODE_COMPAT_VERSION,
  ) {}

  create(input: SessionCreateInput): Session {
    const now = Date.now()
    const id = input.id ?? generateId()
    const directory = resolve(input.directory ?? process.cwd())
    const title = input.title ?? "Untitled"
    const agent = input.agent ?? "default"
    const parentId = input.parentID ?? input.parentId ?? null
    const metadata = JSON.stringify({
      model: input.model,
      metadata: input.metadata,
      permission: input.permission,
    } satisfies StoredSessionMetadata)

    this.db
      .prepare(
        "INSERT INTO sessions (id, directory, title, agent_id, status, created_at, updated_at, last_active_at, metadata, parent_id) VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?)",
      )
      .run(id, directory, title, agent, now, now, now, metadata, parentId)

    return this.get(id)!
  }

  get(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null
    if (!row) return null
    return rowToSession(row, this.compatibilityVersion)
  }

  list(): Session[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as SessionRow[]
    return rows.map((row) => rowToSession(row, this.compatibilityVersion))
  }

  listByDirectory(directory: string): Session[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE directory = ? ORDER BY updated_at DESC")
      .all(resolve(directory)) as SessionRow[]
    return rows.map((row) => rowToSession(row, this.compatibilityVersion))
  }

  update(id: string, input: SessionUpdateInput): Session | null {
    const now = Date.now()
    const sets: string[] = ["updated_at = ?"]
    const params: (string | number)[] = [now]

    if (input.title !== undefined) {
      sets.push("title = ?")
      params.push(input.title)
    }
    if (input.status !== undefined) {
      sets.push("status = ?")
      params.push(input.status)
    }
    if (input.directory !== undefined) {
      sets.push("directory = ?")
      params.push(resolve(input.directory))
    }
    if (input.agent !== undefined) {
      sets.push("agent_id = ?")
      params.push(input.agent)
    }
    if (input.model !== undefined || (input.time && "archived" in input.time)) {
      const row = this.db.prepare("SELECT metadata FROM sessions WHERE id = ?").get(id) as {
        metadata: string | null
      } | null
      const metadata = parseMetadata(row?.metadata ?? null)
      if (input.model !== undefined) metadata.model = input.model
      if (input.time && "archived" in input.time) {
        if (input.time.archived === null || input.time.archived === undefined) {
          delete metadata.archived
        } else {
          metadata.archived = input.time.archived
        }
      }
      sets.push("metadata = ?")
      params.push(JSON.stringify(metadata))
    }
    sets.push("last_active_at = ?")
    params.push(now)
    params.push(id)

    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params)
    return this.get(id)
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
        SELECT id FROM sessions WHERE id = ?
        UNION ALL
        SELECT child.id FROM sessions child JOIN descendants parent ON child.parent_id = parent.id
      )
      DELETE FROM sessions WHERE id IN (SELECT id FROM descendants)`,
      )
      .run(id)
    return result.changes > 0
  }

  setStatus(id: string, status: string): void {
    const now = Date.now()
    this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ?, last_active_at = ? WHERE id = ?")
      .run(status, now, now, id)
  }

  setRevert(id: string, revert: NonNullable<Session["revert"]>): Session | null {
    const row = this.db.prepare("SELECT metadata FROM sessions WHERE id = ?").get(id) as {
      metadata: string | null
    } | null
    if (!row) return null
    const metadata = parseMetadata(row.metadata)
    metadata.revert = revert
    const now = Date.now()
    this.db
      .prepare("UPDATE sessions SET metadata = ?, updated_at = ?, last_active_at = ? WHERE id = ?")
      .run(JSON.stringify(metadata), now, now, id)
    return this.get(id)
  }

  clearRevert(id: string): Session | null {
    const row = this.db.prepare("SELECT metadata FROM sessions WHERE id = ?").get(id) as {
      metadata: string | null
    } | null
    if (!row) return null
    const metadata = parseMetadata(row.metadata)
    delete metadata.revert
    const now = Date.now()
    this.db
      .prepare("UPDATE sessions SET metadata = ?, updated_at = ?, last_active_at = ? WHERE id = ?")
      .run(JSON.stringify(metadata), now, now, id)
    return this.get(id)
  }

  getStatus(id: string): string | null {
    const row = this.db.prepare("SELECT status FROM sessions WHERE id = ?").get(id) as { status: string } | null
    return row?.status ?? null
  }

  listChildren(parentId: string): Session[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE parent_id = ? ORDER BY created_at ASC")
      .all(parentId) as SessionRow[]
    return rows.map((row) => rowToSession(row, this.compatibilityVersion))
  }

  getParent(childId: string): Session | null {
    const row = this.db.prepare("SELECT parent_id FROM sessions WHERE id = ?").get(childId) as {
      parent_id: string | null
    } | null
    if (!row?.parent_id) return null
    return this.get(row.parent_id)
  }

  getDepth(sessionId: string): number {
    let depth = 0
    let currentId: string | null = sessionId
    const visited = new Set<string>()
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      const row = this.db.prepare("SELECT parent_id FROM sessions WHERE id = ?").get(currentId) as {
        parent_id: string | null
      } | null
      if (!row?.parent_id) break
      depth++
      currentId = row.parent_id
    }
    return depth
  }

  listByStatus(status: string): Session[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC")
      .all(status) as SessionRow[]
    return rows.map((row) => rowToSession(row, this.compatibilityVersion))
  }

  listByStatuses(statuses: string[]): Session[] {
    const placeholders = statuses.map(() => "?").join(",")
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE status IN (${placeholders}) ORDER BY created_at DESC`)
      .all(...statuses) as SessionRow[]
    return rows.map((row) => rowToSession(row, this.compatibilityVersion))
  }
}
