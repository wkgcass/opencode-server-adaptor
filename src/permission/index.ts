import type { DatabaseService, PermissionRow } from "../db/index.ts"

export type PermissionDecision = "allow" | "deny"
export type PermissionStatus = "pending" | PermissionDecision

export interface Permission {
  id: string
  sessionId: string
  tool: string
  input: Record<string, unknown>
  status: PermissionStatus
  response?: Record<string, unknown>
  createdAt: number
  respondedAt?: number
  expiresAt?: number
}

export interface PermissionCreateInput {
  id: string
  sessionId: string
  tool: string
  input: Record<string, unknown>
  createdAt?: number
  expiresAt?: number
}

/**
 * Persistence boundary for permission requests.
 *
 * Permission state is shared by runtime event projection, startup recovery,
 * and multiple HTTP routes. Keeping the SQL here prevents those layers from
 * developing subtly different definitions of a pending request.
 */
export class PermissionRepository {
  constructor(private readonly db: DatabaseService) {}

  create(input: PermissionCreateInput): Permission {
    const createdAt = input.createdAt ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO permissions
          (id, session_id, tool, input, status, response, created_at, responded_at, expires_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)`,
      )
      .run(input.id, input.sessionId, input.tool, JSON.stringify(input.input), createdAt, input.expiresAt ?? null)
    return this.get(input.id)!
  }

  get(id: string): Permission | null {
    return mapPermission(this.db.prepare("SELECT * FROM permissions WHERE id = ?").get(id) as PermissionRow | null)
  }

  getPending(sessionId: string, id: string): Permission | null {
    return mapPermission(
      this.db
        .prepare("SELECT * FROM permissions WHERE session_id = ? AND id = ? AND status = 'pending'")
        .get(sessionId, id) as PermissionRow | null,
    )
  }

  listPendingBySession(sessionId: string): Permission[] {
    const rows = this.db
      .prepare("SELECT * FROM permissions WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC")
      .all(sessionId) as PermissionRow[]
    return rows.map(mapPermissionRow)
  }

  listPendingByDirectory(directory: string): Permission[] {
    const rows = this.db
      .prepare(
        `SELECT permissions.*
         FROM permissions
         JOIN sessions ON sessions.id = permissions.session_id
         WHERE permissions.status = 'pending' AND sessions.directory = ?
         ORDER BY permissions.created_at DESC`,
      )
      .all(directory) as PermissionRow[]
    return rows.map(mapPermissionRow)
  }

  resolve(id: string, decision: PermissionDecision, reason?: string, respondedAt = Date.now()): boolean {
    const result = this.db
      .prepare("UPDATE permissions SET status = ?, response = ?, responded_at = ? WHERE id = ? AND status = 'pending'")
      .run(decision, JSON.stringify({ action: decision, reason }), respondedAt, id)
    return result.changes > 0
  }

  denyAllPending(reason: string, respondedAt = Date.now()): number {
    const result = this.db
      .prepare("UPDATE permissions SET status = 'deny', response = ?, responded_at = ? WHERE status = 'pending'")
      .run(JSON.stringify({ action: "deny", reason }), respondedAt)
    return result.changes
  }
}

function mapPermission(row: PermissionRow | null): Permission | null {
  return row ? mapPermissionRow(row) : null
}

function mapPermissionRow(row: PermissionRow): Permission {
  return {
    id: row.id,
    sessionId: row.session_id,
    tool: row.tool,
    input: JSON.parse(row.input) as Record<string, unknown>,
    status: row.status as PermissionStatus,
    response: row.response ? (JSON.parse(row.response) as Record<string, unknown>) : undefined,
    createdAt: row.created_at,
    respondedAt: row.responded_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
  }
}
