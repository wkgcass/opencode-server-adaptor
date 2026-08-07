import type { DatabaseService } from "../db/index.ts"
import type { MessageRow, PartRow } from "../db/index.ts"
import {
  createMessageId,
  createMessageIdAfter,
  createPartId,
  observeOrderedId,
  orderedIdFormat,
  type OrderedIdFormat,
} from "../id/index.ts"

export interface UserMessage {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
  system?: string
  tools?: Record<string, boolean>
}

export interface AssistantMessage {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: { cwd: string; root: string }
  cost: number
  tokens: { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  error?: {
    name: string
    data: {
      message: string
      [key: string]: unknown
    }
  }
  finish?: string
}

export type Message = UserMessage | AssistantMessage

export interface TextPart {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  time?: { start: number; end?: number }
  synthetic?: boolean
  ignored?: boolean
  metadata?: Record<string, unknown>
}

export interface ReasoningPart {
  id: string
  sessionID: string
  messageID: string
  type: "reasoning"
  text: string
  time: { start: number; end?: number }
}

export interface ToolPart {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: string
  state: {
    status: "pending" | "running" | "completed" | "error" | "aborted" | "waiting_permission"
    input: Record<string, unknown>
    raw?: string
    title?: string
    output?: string
    error?: string
    metadata?: Record<string, unknown>
    time?: { start: number; end?: number }
  }
}

export interface SubtaskPart {
  id: string
  sessionID: string
  messageID: string
  type: "subtask"
  prompt: string
  description: string
  agent: string
  model?: { providerID: string; modelID: string }
  command?: string
}

export interface FilePart {
  id: string
  sessionID: string
  messageID: string
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: Record<string, unknown>
}

export interface AgentPart {
  id: string
  sessionID: string
  messageID: string
  type: "agent"
  name: string
  source?: { value: string; start: number; end: number }
}

export type Part = TextPart | ReasoningPart | ToolPart | SubtaskPart | FilePart | AgentPart

export interface MessageWithParts {
  info: Message
  parts: Part[]
}

function isTerminalToolStatus(status: string | undefined): boolean {
  return status === "completed" || status === "error" || status === "aborted"
}

export interface SessionIdFormatResolver {
  getIdFormat(sessionId: string): OrderedIdFormat
}

function rowToMessage(row: MessageRow): Message {
  const data = JSON.parse(row.data) as Record<string, unknown>
  if (row.role === "user") {
    return {
      id: row.id,
      sessionID: row.session_id,
      role: "user",
      time: { created: row.created_at },
      agent: row.agent,
      model: (data.model as { providerID: string; modelID: string; variant?: string }) ?? {
        providerID: row.provider_id ?? row.agent,
        modelID: row.model_id ?? "default",
      },
      system: data.system as string | undefined,
      tools: data.tools as Record<string, boolean> | undefined,
    }
  }
  return {
    id: row.id,
    sessionID: row.session_id,
    role: "assistant",
    time: { created: row.created_at, completed: row.completed_at ?? undefined },
    parentID: row.parent_id ?? "",
    modelID: row.model_id ?? "default",
    providerID: row.provider_id ?? row.agent,
    mode: (data.mode as string) ?? "default",
    agent: row.agent,
    path: (data.path as { cwd: string; root: string }) ?? { cwd: process.cwd(), root: process.cwd() },
    cost: (data.cost as number) ?? 0,
    tokens: (data.tokens as AssistantMessage["tokens"]) ?? {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    error: data.error as AssistantMessage["error"],
    finish: data.finish as string | undefined,
  }
}

function rowToPart(row: PartRow): Part {
  const data = JSON.parse(row.data) as Record<string, unknown>
  const base = { id: row.id, sessionID: row.session_id, messageID: row.message_id }
  switch (row.type) {
    case "text":
      return {
        ...base,
        type: "text",
        text: (data.text as string) ?? "",
        time: (data.time as TextPart["time"] | undefined) ?? { start: row.created_at },
        synthetic: data.synthetic as boolean | undefined,
        ignored: data.ignored as boolean | undefined,
        metadata: data.metadata as Record<string, unknown> | undefined,
      }
    case "reasoning":
      return {
        ...base,
        type: "reasoning",
        text: (data.text as string) ?? "",
        time: (data.time as ReasoningPart["time"] | undefined) ?? { start: row.created_at },
      }
    case "tool":
      return {
        ...base,
        type: "tool",
        callID: (data.callID as string) ?? "",
        tool: (data.tool as string) ?? "",
        state: (data.state as ToolPart["state"]) ?? { status: "pending", input: {} },
      }
    case "subtask":
      return {
        ...base,
        type: "subtask",
        prompt: (data.prompt as string) ?? "",
        description: (data.description as string) ?? "",
        agent: (data.agent as string) ?? "default",
        model: data.model as SubtaskPart["model"],
        command: data.command as string | undefined,
      }
    case "file":
      return {
        ...base,
        type: "file",
        mime: (data.mime as string) ?? "application/octet-stream",
        filename: data.filename as string | undefined,
        url: (data.url as string) ?? "",
        source: data.source as Record<string, unknown> | undefined,
      }
    case "agent":
      return {
        ...base,
        type: "agent",
        name: (data.name as string) ?? "",
        source: data.source as AgentPart["source"],
      }
    default:
      return { ...base, type: "text", text: JSON.stringify(data) }
  }
}

export class MessageRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly idFormats?: SessionIdFormatResolver,
  ) {}

  private idFormat(sessionId: string): OrderedIdFormat {
    return this.idFormats?.getIdFormat(sessionId) ?? "legacy"
  }

  nextMessageId(sessionId: string): string {
    return createMessageId(undefined, this.idFormat(sessionId))
  }

  private finalizeOpenTextParts(messageId: string, end: number): void {
    const rows = this.db
      .prepare("SELECT * FROM parts WHERE message_id = ? AND type IN ('text', 'reasoning')")
      .all(messageId) as PartRow[]
    for (const row of rows) {
      const data = JSON.parse(row.data) as Record<string, unknown>
      const time = data.time as { start?: number; end?: number } | undefined
      if (typeof time?.end === "number") continue
      data.time = {
        start: typeof time?.start === "number" ? time.start : row.created_at,
        end,
      }
      this.db.prepare("UPDATE parts SET data = ? WHERE id = ?").run(JSON.stringify(data), row.id)
    }
  }

  private finalizeOpenToolParts(messageId: string, end: number, error?: string): void {
    const rows = this.db
      .prepare("SELECT * FROM parts WHERE message_id = ? AND type = 'tool'")
      .all(messageId) as PartRow[]
    for (const row of rows) {
      const data = JSON.parse(row.data) as Record<string, unknown>
      const state = (data.state ?? {}) as {
        status?: string
        input?: Record<string, unknown>
        title?: string
        output?: string
        error?: string
        metadata?: Record<string, unknown>
        time?: { start?: number; end?: number }
      }
      if (isTerminalToolStatus(state.status)) continue

      const start = typeof state.time?.start === "number" ? state.time.start : row.created_at
      const metadata = {
        ...(state.metadata ?? {}),
        recovered: true,
        recoveryReason: error ?? "The assistant message ended without a terminal tool event",
      }
      if (error) {
        data.state = {
          status: "error",
          input: state.input ?? {},
          error,
          metadata,
          time: { start, end },
        }
      } else {
        const partialOutput =
          typeof state.metadata?.partialOutput === "string" ? state.metadata.partialOutput : undefined
        data.state = {
          status: "completed",
          input: state.input ?? {},
          output: state.output ?? partialOutput ?? "",
          title: state.title ?? (typeof data.tool === "string" ? data.tool : "tool"),
          metadata,
          time: { start, end },
        }
      }
      this.db.prepare("UPDATE parts SET data = ? WHERE id = ?").run(JSON.stringify(data), row.id)
    }
  }

  recoverOpenToolParts(reason: string): number {
    const rows = this.db.prepare("SELECT * FROM parts WHERE type = 'tool'").all() as PartRow[]
    const messageIds = new Set<string>()
    let count = 0
    for (const row of rows) {
      const data = JSON.parse(row.data) as { state?: { status?: string } }
      if (isTerminalToolStatus(data.state?.status)) continue
      messageIds.add(row.message_id)
      count++
    }
    const now = Date.now()
    for (const messageId of messageIds) {
      this.finalizeOpenToolParts(messageId, now, reason)
    }
    return count
  }

  recoverOpenAssistantMessages(reason: string): number {
    const rows = this.db
      .prepare(
        "SELECT id FROM messages WHERE role = 'assistant' AND completed_at IS NULL ORDER BY created_at ASC, rowid ASC",
      )
      .all() as Array<{ id: string }>
    for (const row of rows) {
      this.setMessageError(row.id, { type: "interrupted", message: reason })
    }
    return rows.length
  }

  createUserMessage(
    sessionId: string,
    agent: string,
    model?: { providerID: string; modelID: string; variant?: string },
    requestedId?: string,
    details?: { system?: string; tools?: Record<string, boolean> },
  ): UserMessage {
    const requested = requestedId?.trim()
    if (requested) observeOrderedId(requested)
    const format = requested && orderedIdFormat(requested) === "wide" ? "wide" : this.idFormat(sessionId)
    const id = requested || createMessageId(undefined, format)
    const now = Date.now()
    const providerID = model?.providerID ?? agent
    const modelID = model?.modelID ?? "default"
    const modelInfo = { providerID, modelID, variant: model?.variant }
    const data = JSON.stringify({
      model: modelInfo,
      system: details?.system,
      tools: details?.tools,
    })
    this.db
      .prepare(
        "INSERT INTO messages (id, session_id, role, created_at, completed_at, parent_id, model_id, provider_id, agent, data) VALUES (?, ?, 'user', ?, NULL, NULL, ?, ?, ?, ?)",
      )
      .run(id, sessionId, now, modelID, providerID, agent, data)
    return {
      id,
      sessionID: sessionId,
      role: "user",
      time: { created: now },
      agent,
      model: modelInfo,
      system: details?.system,
      tools: details?.tools,
    }
  }

  createAssistantMessage(
    sessionId: string,
    parentId: string,
    agent: string,
    model?: { providerID: string; modelID: string },
    afterId?: string,
  ): AssistantMessage {
    const now = Date.now()
    const id = createMessageIdAfter(afterId ?? parentId, this.idFormat(sessionId))
    const providerID = model?.providerID ?? agent
    const modelID = model?.modelID ?? "default"
    const session = this.db.prepare("SELECT directory FROM sessions WHERE id = ?").get(sessionId) as {
      directory: string
    } | null
    const directory = session?.directory ?? process.cwd()
    const data = JSON.stringify({
      mode: "default",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    this.db
      .prepare(
        "INSERT INTO messages (id, session_id, role, created_at, completed_at, parent_id, model_id, provider_id, agent, data) VALUES (?, ?, 'assistant', ?, NULL, ?, ?, ?, ?, ?)",
      )
      .run(id, sessionId, now, parentId, modelID, providerID, agent, data)
    return {
      id,
      sessionID: sessionId,
      role: "assistant",
      time: { created: now },
      parentID: parentId,
      modelID,
      providerID,
      mode: "default",
      agent,
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | null
    if (!row) return null
    return rowToMessage(row)
  }

  listMessages(sessionId: string): MessageWithParts[] {
    const msgRows = this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(sessionId) as MessageRow[]
    return msgRows.map((msgRow) => {
      const partRows = this.db
        .prepare("SELECT * FROM parts WHERE message_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(msgRow.id) as PartRow[]
      return {
        info: rowToMessage(msgRow),
        parts: partRows.map(rowToPart),
      }
    })
  }

  completeMessage(id: string, finish?: string): void {
    const now = Date.now()
    this.finalizeOpenTextParts(id, now)
    this.finalizeOpenToolParts(id, now)
    this.db.prepare("UPDATE messages SET completed_at = ? WHERE id = ?").run(now, id)
    if (finish) {
      const row = this.db.prepare("SELECT data FROM messages WHERE id = ?").get(id) as { data: string } | null
      if (row) {
        const data = JSON.parse(row.data) as Record<string, unknown>
        data.finish = finish
        this.db.prepare("UPDATE messages SET data = ? WHERE id = ?").run(JSON.stringify(data), id)
      }
    }
  }

  setMessageError(id: string, error: { type?: string; name?: string; message: string }): void {
    const row = this.db.prepare("SELECT data FROM messages WHERE id = ?").get(id) as { data: string } | null
    if (row) {
      const now = Date.now()
      this.finalizeOpenTextParts(id, now)
      this.finalizeOpenToolParts(id, now, error.message)
      const data = JSON.parse(row.data) as Record<string, unknown>
      data.error = {
        name: error.name ?? (error.type === "aborted" ? "MessageAbortedError" : "UnknownError"),
        data: { message: error.message },
      }
      this.db
        .prepare("UPDATE messages SET data = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?")
        .run(JSON.stringify(data), now, id)
    }
  }

  updateMessageUsage(
    id: string,
    usage: {
      cost?: number
      input?: number
      output?: number
      cacheRead?: number
      cacheWrite?: number
      total?: number
      turns?: number
    },
  ): void {
    const row = this.db.prepare("SELECT data FROM messages WHERE id = ?").get(id) as { data: string } | null
    if (!row) return
    const data = JSON.parse(row.data) as Record<string, unknown>
    if (usage.cost !== undefined) data.cost = usage.cost
    if (
      usage.input !== undefined ||
      usage.output !== undefined ||
      usage.cacheRead !== undefined ||
      usage.cacheWrite !== undefined ||
      usage.total !== undefined
    ) {
      const existing = (data.tokens ?? {}) as {
        input?: number
        output?: number
        total?: number
        cache?: { read: number; write: number }
      }
      const existingCache = existing.cache ?? { read: 0, write: 0 }
      data.tokens = {
        ...existing,
        ...(usage.input !== undefined ? { input: usage.input } : {}),
        ...(usage.output !== undefined ? { output: usage.output } : {}),
        ...(usage.total !== undefined ? { total: usage.total } : {}),
        cache: {
          read: existingCache.read,
          write: existingCache.write,
          ...(usage.cacheRead !== undefined ? { read: usage.cacheRead } : {}),
          ...(usage.cacheWrite !== undefined ? { write: usage.cacheWrite } : {}),
        },
      }
    }
    this.db.prepare("UPDATE messages SET data = ? WHERE id = ?").run(JSON.stringify(data), id)
  }

  createPart(
    sessionId: string,
    messageId: string,
    type: Part["type"],
    data: Omit<Part, "id" | "sessionID" | "messageID" | "type">,
    requestedId?: string,
  ): Part {
    const requested = requestedId?.trim()
    if (requested) observeOrderedId(requested)
    const id = requested || createPartId(undefined, this.idFormat(sessionId))
    const now = Date.now()
    const partData: Record<string, unknown> = { ...data }
    this.db
      .prepare("INSERT INTO parts (id, session_id, message_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, sessionId, messageId, type, JSON.stringify(partData), now)

    return { id, sessionID: sessionId, messageID: messageId, type, ...data } as Part
  }

  getPart(id: string): Part | null {
    const row = this.db.prepare("SELECT * FROM parts WHERE id = ?").get(id) as PartRow | null
    if (!row) return null
    return rowToPart(row)
  }

  updatePart(id: string, data: Partial<Part>): Part | null {
    const row = this.db.prepare("SELECT * FROM parts WHERE id = ?").get(id) as PartRow | null
    if (!row) return null

    const existing = JSON.parse(row.data) as Record<string, unknown>
    const merged = { ...existing, ...data }
    this.db.prepare("UPDATE parts SET data = ? WHERE id = ?").run(JSON.stringify(merged), id)
    return this.getPart(id)
  }

  listParts(messageId: string): Part[] {
    const rows = this.db
      .prepare("SELECT * FROM parts WHERE message_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(messageId) as PartRow[]
    return rows.map(rowToPart)
  }

  deletePartsByMessage(messageId: string): void {
    this.db.prepare("DELETE FROM parts WHERE message_id = ?").run(messageId)
  }

  deleteMessage(sessionId: string, messageId: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM parts WHERE session_id = ? AND message_id = ?").run(sessionId, messageId)
      const result = this.db.prepare("DELETE FROM messages WHERE session_id = ? AND id = ?").run(sessionId, messageId)
      return result.changes > 0
    })
  }

  deleteMessagesFrom(sessionId: string, messageId: string): string[] {
    const target = this.db
      .prepare("SELECT rowid AS position FROM messages WHERE session_id = ? AND id = ?")
      .get(sessionId, messageId) as { position: number } | null
    if (!target) return []
    const rows = this.db
      .prepare("SELECT id FROM messages WHERE session_id = ? AND rowid >= ? ORDER BY created_at ASC, rowid ASC")
      .all(sessionId, target.position) as Array<{ id: string }>
    const ids = rows.map((row) => row.id)
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM parts WHERE session_id = ? AND message_id IN (SELECT id FROM messages WHERE session_id = ? AND rowid >= ?)",
        )
        .run(sessionId, sessionId, target.position)
      this.db.prepare("DELETE FROM messages WHERE session_id = ? AND rowid >= ?").run(sessionId, target.position)
    })
    return ids
  }

  deletePart(sessionId: string, messageId: string, partId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM parts WHERE session_id = ? AND message_id = ? AND id = ?")
      .run(sessionId, messageId, partId)
    return result.changes > 0
  }
}
