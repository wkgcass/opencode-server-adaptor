import type { DatabaseService } from "../../db/index.ts"

const STATE_KEY = "_agentState"
const PI_KEY = "pi"

export interface PiConversationSessionState {
  activeSessionId?: string
  activeSessionFile?: string
  revert?: {
    previousSessionId: string
    previousSessionFile: string
    forkedSessionId: string
    forkedSessionFile: string
  }
}

interface JsonRow {
  value: string | null
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function nestedState(data: Record<string, unknown>): Record<string, unknown> {
  const state = data[STATE_KEY]
  return state && typeof state === "object" && !Array.isArray(state) ? (state as Record<string, unknown>) : {}
}

/**
 * Pi-owned persistence stored inside the existing session/message JSON
 * columns. OpenCode-facing repositories intentionally do not expose these
 * backend cursors.
 */
export class PiConversationStore {
  constructor(private readonly db: DatabaseService) {}

  getSession(sessionId: string): PiConversationSessionState {
    const row = this.db.prepare("SELECT metadata AS value FROM sessions WHERE id = ?").get(sessionId) as JsonRow | null
    const state = nestedState(parseObject(row?.value))
    const pi = state[PI_KEY]
    return pi && typeof pi === "object" && !Array.isArray(pi)
      ? ({ ...(pi as Record<string, unknown>) } as PiConversationSessionState)
      : {}
  }

  setSession(sessionId: string, value: PiConversationSessionState): void {
    const row = this.db.prepare("SELECT metadata AS value FROM sessions WHERE id = ?").get(sessionId) as JsonRow | null
    if (!row) throw new Error(`Session not found: ${sessionId}`)
    const data = parseObject(row.value)
    const state = nestedState(data)
    state[PI_KEY] = value
    data[STATE_KEY] = state
    this.db.prepare("UPDATE sessions SET metadata = ? WHERE id = ?").run(JSON.stringify(data), sessionId)
  }

  getMessageEntryId(messageId: string): string | undefined {
    const row = this.db.prepare("SELECT data AS value FROM messages WHERE id = ?").get(messageId) as JsonRow | null
    const state = nestedState(parseObject(row?.value))
    const pi = state[PI_KEY]
    if (!pi || typeof pi !== "object" || Array.isArray(pi)) return undefined
    const entryId = (pi as Record<string, unknown>).entryId
    return typeof entryId === "string" && entryId ? entryId : undefined
  }

  setMessageEntryId(messageId: string, entryId: string): void {
    const row = this.db.prepare("SELECT data AS value FROM messages WHERE id = ?").get(messageId) as JsonRow | null
    if (!row) throw new Error(`Message not found: ${messageId}`)
    const data = parseObject(row.value)
    const state = nestedState(data)
    const existing = state[PI_KEY]
    state[PI_KEY] = {
      ...(existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {}),
      entryId,
    }
    data[STATE_KEY] = state
    this.db.prepare("UPDATE messages SET data = ? WHERE id = ?").run(JSON.stringify(data), messageId)
  }
}
