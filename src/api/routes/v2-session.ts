import { Hono } from "hono"
import type { Logger } from "../../logging/index.ts"
import type { MessageWithParts, Part, ToolPart } from "../../message/index.ts"
import type { Session } from "../../session/index.ts"
import type { SessionPromptPartInput, SessionService } from "../../session/session-service.ts"
import { SessionServiceError } from "../../session/session-service.ts"

interface Cursor {
  version: 1
  order: "asc" | "desc"
  direction: "previous" | "next"
  created: number
  id: string
  filters: {
    directory?: string
    project?: string
    subpath?: string
    search?: string
    workspace?: string
  }
}

interface MessageCursor {
  version: 1
  order: "asc" | "desc"
  direction: "previous" | "next"
  id: string
}

function encodeCursor(cursor: Cursor | MessageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

function decodeCursor<T extends Cursor | MessageCursor>(value: string): T | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<T>
    if (parsed.version !== 1 || typeof parsed.id !== "string") return undefined
    return parsed as T
  } catch {
    return undefined
  }
}

function sameFilters(left: Cursor["filters"], right: Cursor["filters"]): boolean {
  return (
    left.directory === right.directory &&
    left.project === right.project &&
    left.subpath === right.subpath &&
    left.search === right.search &&
    left.workspace === right.workspace
  )
}

export function toV2Session(session: Session, messages: MessageWithParts[] = []) {
  const assistants = messages.filter(
    (message): message is MessageWithParts & { info: Extract<MessageWithParts["info"], { role: "assistant" }> } =>
      message.info.role === "assistant",
  )
  return {
    id: session.id,
    parentID: session.parentID,
    projectID: session.projectID,
    agent: session.agent,
    model: session.model,
    cost: assistants.reduce((total, message) => total + message.info.cost, 0),
    tokens: assistants.reduce(
      (total, message) => ({
        input: total.input + message.info.tokens.input,
        output: total.output + message.info.tokens.output,
        reasoning: total.reasoning + message.info.tokens.reasoning,
        cache: {
          read: total.cache.read + message.info.tokens.cache.read,
          write: total.cache.write + message.info.tokens.cache.write,
        },
      }),
      { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ),
    time: session.time,
    title: session.title,
    status: session.status,
    location: { directory: session.directory },
    subpath: "",
    revert: session.revert,
  }
}

export function toV2Message(message: MessageWithParts) {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n\n")
    const files = message.parts
      .filter((part): part is Extract<Part, { type: "file" }> => part.type === "file")
      .map((part) => ({
        uri: part.url,
        mime: part.mime,
        name: part.filename,
        source: part.source,
      }))
    const agents = message.parts
      .filter((part): part is Extract<Part, { type: "agent" }> => part.type === "agent")
      .map((part) => ({ name: part.name, source: part.source }))
    const subtasks = message.parts.filter((part) => part.type === "subtask").map((part) => ({ ...part }))
    return {
      id: message.info.id,
      time: message.info.time,
      text,
      agent: message.info.agent,
      model: message.info.model,
      system: message.info.system,
      ...(files.length ? { files } : {}),
      ...(agents.length ? { agents } : {}),
      ...(subtasks.length ? { subtasks } : {}),
      type: "user" as const,
    }
  }

  const content: Array<Record<string, unknown>> = []
  for (const part of message.parts) {
    if (part.type === "text") {
      content.push({
        type: "text",
        id: part.id,
        text: part.text,
        time: part.time ? { created: part.time.start, completed: part.time.end } : undefined,
      })
      continue
    }
    if (part.type === "reasoning") {
      content.push({
        type: "reasoning",
        id: part.id,
        text: part.text,
        time: part.time ? { created: part.time.start, completed: part.time.end } : undefined,
      })
      continue
    }
    if (part.type === "tool") content.push(toV2Tool(part))
  }
  return {
    id: message.info.id,
    time: message.info.time,
    type: "assistant" as const,
    agent: message.info.agent,
    model: { id: message.info.modelID, providerID: message.info.providerID },
    content,
    finish: message.info.finish,
    cost: message.info.cost,
    tokens: message.info.tokens,
    error: message.info.error ? { type: "unknown" as const, message: message.info.error.data.message } : undefined,
  }
}

function toV2Tool(part: ToolPart) {
  const base = {
    type: "tool" as const,
    id: part.callID || part.id,
    name: part.tool,
    partID: part.id,
    callID: part.callID,
    title: "title" in part.state ? part.state.title : undefined,
    metadata: "metadata" in part.state ? part.state.metadata : undefined,
    time: {
      created: part.state.time?.start ?? Date.now(),
      ran: part.state.time?.start,
      completed: part.state.time?.end,
    },
  }
  if (part.state.status === "pending") {
    return { ...base, state: { status: "pending" as const, input: part.state.raw ?? JSON.stringify(part.state.input) } }
  }
  if (part.state.status === "running" || part.state.status === "waiting_permission") {
    return {
      ...base,
      state: {
        status: "running" as const,
        input: part.state.input,
        structured: {},
        content: part.state.output ? [{ type: "text" as const, text: part.state.output }] : [],
      },
    }
  }
  if (part.state.status === "completed") {
    return {
      ...base,
      state: {
        status: "completed" as const,
        input: part.state.input,
        structured: {},
        content: part.state.output ? [{ type: "text" as const, text: part.state.output }] : [],
        result: part.state.output,
      },
    }
  }
  return {
    ...base,
    state: {
      status: "error" as const,
      input: part.state.input,
      structured: {},
      content: [],
      error: {
        type: "unknown" as const,
        message: part.state.error ?? (part.state.status === "aborted" ? "Tool call aborted" : "Tool call failed"),
      },
      result: part.state.output,
    },
  }
}

export function createV2SessionRoutes(options: { service: SessionService; logger: Logger }): Hono {
  const app = new Hono()
  const service = options.service

  app.get("/api/session", (c) => {
    const requestedOrder = c.req.query("order")
    const requestedFilters: Cursor["filters"] = {
      directory: c.req.query("directory") || undefined,
      project: c.req.query("project") || undefined,
      subpath: c.req.query("subpath") || undefined,
      search: c.req.query("search")?.trim().toLocaleLowerCase() || undefined,
      workspace: c.req.query("workspace") || undefined,
    }
    const rawLimit = c.req.query("limit")
    const limit = rawLimit === undefined ? 50 : Number(rawLimit)
    if (!Number.isInteger(limit) || limit <= 0) {
      return c.json({ _tag: "InvalidRequestError", message: "limit must be a positive integer" }, 400)
    }
    const rawCursor = c.req.query("cursor")
    const cursor = rawCursor ? decodeCursor<Cursor>(rawCursor) : undefined
    if (
      rawCursor &&
      (!cursor ||
        (cursor.order !== "asc" && cursor.order !== "desc") ||
        (cursor.direction !== "previous" && cursor.direction !== "next") ||
        !cursor.filters ||
        (requestedOrder !== undefined && requestedOrder !== cursor.order) ||
        (Object.values(requestedFilters).some((value) => value !== undefined) &&
          !sameFilters(cursor.filters, requestedFilters)))
    ) {
      return c.json({ _tag: "InvalidCursorError", message: "Invalid cursor" }, 400)
    }
    const order = cursor?.order ?? (requestedOrder === "asc" ? "asc" : "desc")
    const filters = cursor?.filters ?? requestedFilters

    let list = service.sessions.list()
    if (filters.workspace) list = []
    if (filters.directory) list = list.filter((session) => session.directory === filters.directory)
    if (filters.project) list = list.filter((session) => session.projectID === filters.project)
    if (filters.subpath) list = []
    if (filters.search) {
      list = list.filter((session) => session.title.toLocaleLowerCase().includes(filters.search!))
    }
    const direction = order === "asc" ? 1 : -1
    list.sort((left, right) => {
      const byTime = (left.time.created - right.time.created) * direction
      return byTime || left.id.localeCompare(right.id) * direction
    })
    let pageStart = 0
    if (cursor) {
      const index = list.findIndex((session) => session.id === cursor.id && session.time.created === cursor.created)
      if (index < 0) return c.json({ _tag: "InvalidCursorError", message: "Invalid cursor" }, 400)
      pageStart = cursor.direction === "next" ? index + 1 : Math.max(0, index - limit)
    }
    const page = list.slice(pageStart, pageStart + limit)
    const first = page[0]
    const last = page.at(-1)
    const hasPrevious = pageStart > 0
    const hasNext = pageStart + page.length < list.length
    return c.json({
      data: page.map((session) => toV2Session(session, service.messages.listMessages(session.id))),
      cursor: {
        previous:
          hasPrevious && first
            ? encodeCursor({
                version: 1,
                order,
                direction: "previous",
                created: first.time.created,
                id: first.id,
                filters,
              })
            : undefined,
        next:
          hasNext && last
            ? encodeCursor({
                version: 1,
                order,
                direction: "next",
                created: last.time.created,
                id: last.id,
                filters,
              })
            : undefined,
      },
    })
  })

  app.post("/api/session", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!body) return v2Error(c, new SessionServiceError("invalid_request", "Invalid JSON body"))
    const location = body.location as { directory?: string; workspaceID?: string } | undefined
    if (location?.workspaceID) {
      return v2Error(c, new SessionServiceError("invalid_request", "Remote workspaces are not supported"))
    }
    try {
      const model = body.model as { id: string; providerID: string; variant?: string } | undefined
      const session = service.create({
        id: typeof body.id === "string" ? body.id : undefined,
        directory: location?.directory ?? process.cwd(),
        agent: typeof body.agent === "string" ? body.agent : undefined,
        model,
      })
      return c.json({ data: toV2Session(session) })
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.get("/api/session/active", (c) => {
    return c.json({
      data: Object.fromEntries(
        service.sessions
          .list()
          .filter((session) => ["busy", "running", "waiting_permission"].includes(session.status))
          .map((session) => [session.id, { type: "running" as const }]),
      ),
    })
  })

  app.get("/api/session/:sessionID", (c) => {
    try {
      const session = service.requireSession(c.req.param("sessionID"))
      return c.json({ data: toV2Session(session, service.messages.listMessages(session.id)) })
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.get("/api/session/:sessionID/children", (c) => {
    try {
      service.requireSession(c.req.param("sessionID"))
      return c.json({
        data: service.sessions
          .listChildren(c.req.param("sessionID"))
          .map((session) => toV2Session(session, service.messages.listMessages(session.id))),
      })
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.patch("/api/session/:sessionID", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!body) return v2Error(c, new SessionServiceError("invalid_request", "Invalid JSON body"))
    try {
      const session = service.update(c.req.param("sessionID"), {
        title: typeof body.title === "string" ? body.title : undefined,
        status: typeof body.status === "string" ? body.status : undefined,
      })
      return c.json({ data: toV2Session(session, service.messages.listMessages(session.id)) })
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.delete("/api/session/:sessionID", async (c) => {
    try {
      await service.delete(c.req.param("sessionID"))
      return c.body(null, 204)
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.post("/api/session/:sessionID/agent", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!body || typeof body.agent !== "string") {
      return v2Error(c, new SessionServiceError("invalid_request", "agent is required"))
    }
    try {
      service.update(c.req.param("sessionID"), { agent: body.agent })
      return c.body(null, 204)
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.post("/api/session/:sessionID/model", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    const model = body?.model as { id?: string; providerID?: string; variant?: string } | undefined
    if (!model?.id || !model.providerID) {
      return v2Error(c, new SessionServiceError("invalid_request", "model is required"))
    }
    try {
      service.update(c.req.param("sessionID"), {
        model: { id: model.id, providerID: model.providerID, variant: model.variant },
      })
      return c.body(null, 204)
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.post("/api/session/:sessionID/prompt", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    const nested = body?.prompt
    const prompt =
      nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : body
    if (!prompt || typeof prompt.text !== "string") {
      return v2Error(c, new SessionServiceError("invalid_request", "text is required"))
    }
    const files = Array.isArray(prompt.files) ? prompt.files : []
    if (
      files.some(
        (file) => !file || typeof file !== "object" || typeof (file as Record<string, unknown>).uri !== "string",
      )
    ) {
      return v2Error(c, new SessionServiceError("invalid_request", "files must contain a uri"))
    }
    const agents = Array.isArray(prompt.agents) ? prompt.agents : []
    if (
      agents.some(
        (agent) => !agent || typeof agent !== "object" || typeof (agent as Record<string, unknown>).name !== "string",
      )
    ) {
      return v2Error(c, new SessionServiceError("invalid_request", "agents must contain a name"))
    }
    const subtasks = Array.isArray(prompt.subtasks) ? prompt.subtasks : []
    if (
      subtasks.some(
        (subtask) =>
          !subtask ||
          typeof subtask !== "object" ||
          typeof (subtask as Record<string, unknown>).prompt !== "string" ||
          typeof (subtask as Record<string, unknown>).agent !== "string",
      )
    ) {
      return v2Error(c, new SessionServiceError("invalid_request", "subtasks must contain prompt and agent"))
    }
    const parts: SessionPromptPartInput[] = [
      {
        type: "text",
        text: prompt.text,
        metadata:
          prompt.metadata && typeof prompt.metadata === "object" && !Array.isArray(prompt.metadata)
            ? prompt.metadata
            : undefined,
      },
      ...files.map((value) => {
        const file = value as Record<string, unknown>
        return {
          type: "file",
          uri: file.uri,
          name: typeof file.name === "string" ? file.name : undefined,
          description: typeof file.description === "string" ? file.description : undefined,
          source:
            file.source && typeof file.source === "object" && !Array.isArray(file.source)
              ? file.source
              : file.mention && typeof file.mention === "object" && !Array.isArray(file.mention)
                ? file.mention
                : undefined,
        }
      }),
      ...agents.map((value) => {
        const agent = value as Record<string, unknown>
        return {
          type: "agent",
          name: agent.name,
          source:
            agent.source && typeof agent.source === "object" && !Array.isArray(agent.source)
              ? agent.source
              : agent.mention && typeof agent.mention === "object" && !Array.isArray(agent.mention)
                ? agent.mention
                : undefined,
        }
      }),
      ...subtasks.map((value) => ({ type: "subtask", ...(value as Record<string, unknown>) })),
    ]
    try {
      const admitted = await service.prompt(c.req.param("sessionID"), {
        messageID: typeof body?.id === "string" ? body.id : undefined,
        parts,
        agent: typeof body?.agent === "string" ? body.agent : undefined,
        model:
          body?.model && typeof body.model === "object" && !Array.isArray(body.model)
            ? {
                providerID: String((body.model as Record<string, unknown>).providerID ?? ""),
                modelID: String(
                  (body.model as Record<string, unknown>).id ?? (body.model as Record<string, unknown>).modelID ?? "",
                ),
                variant:
                  typeof (body.model as Record<string, unknown>).variant === "string"
                    ? ((body.model as Record<string, unknown>).variant as string)
                    : undefined,
              }
            : undefined,
        noReply: body?.noReply === true,
        system: typeof body?.system === "string" ? body.system : undefined,
        tools:
          body?.tools && typeof body.tools === "object" && !Array.isArray(body.tools)
            ? (body.tools as Record<string, boolean>)
            : undefined,
        subtaskMode: typeof body?.subtaskMode === "string" ? body.subtaskMode : undefined,
        delivery: body?.delivery === "queue" ? "queue" : "steer",
        resume: typeof body?.resume === "boolean" ? body.resume : undefined,
      })
      return c.json({
        data: {
          admittedSeq: admitted.admittedSeq,
          id: admitted.id,
          sessionID: admitted.sessionID,
          prompt: admitted.prompt,
          delivery: admitted.delivery,
          timeCreated: admitted.timeCreated,
          promotedSeq: admitted.promotedSeq,
        },
      })
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.post("/api/session/:sessionID/compact", async (c) => {
    try {
      await service.compact(c.req.param("sessionID"))
      return c.body(null, 204)
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.post("/api/session/:sessionID/wait", async (c) => {
    try {
      await service.wait(c.req.param("sessionID"), c.req.raw.signal)
      return c.body(null, 204)
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.post("/api/session/:sessionID/revert/stage", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null)
    if (!body || typeof body.messageID !== "string") {
      return v2Error(c, new SessionServiceError("invalid_request", "messageID is required"))
    }
    try {
      const session = await service.revert(c.req.param("sessionID"), body.messageID)
      return c.json({ data: session.revert! })
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.post("/api/session/:sessionID/revert/clear", async (c) => {
    try {
      await service.clearRevert(c.req.param("sessionID"))
      return c.body(null, 204)
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.post("/api/session/:sessionID/revert/commit", async (c) => {
    try {
      await service.commitRevert(c.req.param("sessionID"))
      return c.body(null, 204)
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.get("/api/session/:sessionID/context", (c) => {
    try {
      service.requireSession(c.req.param("sessionID"))
      return c.json({
        data: service.messages.listMessages(c.req.param("sessionID")).map(toV2Message),
      })
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.get("/api/session/:sessionID/history", (c) => {
    try {
      service.requireSession(c.req.param("sessionID"))
      const limit = c.req.query("limit") === undefined ? 50 : Number(c.req.query("limit"))
      const after = c.req.query("after") === undefined ? 0 : Number(c.req.query("after"))
      if (!Number.isInteger(limit) || limit <= 0 || limit > 100 || !Number.isInteger(after) || after < 0) {
        throw new SessionServiceError("invalid_request", "Invalid history pagination")
      }
      const page = service.sessionEvents.list(c.req.param("sessionID"), after, limit)
      return c.json({ data: page.events, hasMore: page.hasMore })
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.get("/api/session/:sessionID/event", (c) => {
    const sessionID = c.req.param("sessionID")
    try {
      service.requireSession(sessionID)
      const after = c.req.query("after") === undefined ? 0 : Number(c.req.query("after"))
      if (!Number.isInteger(after) || after < 0) {
        throw new SessionServiceError("invalid_request", "after must be a non-negative integer")
      }
      return sessionEventStream(service, options.logger, sessionID, after, c.req.raw.signal)
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.post("/api/session/:sessionID/interrupt", async (c) => {
    try {
      await service.interrupt(c.req.param("sessionID"))
      return c.body(null, 204)
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.get("/api/session/:sessionID/message/:messageID", (c) => {
    try {
      return c.json({
        data: toV2Message(service.requireMessage(c.req.param("sessionID"), c.req.param("messageID"))),
      })
    } catch (error) {
      return v2Error(c, error)
    }
  })

  app.get("/api/session/:sessionID/message", (c) => {
    const sessionID = c.req.param("sessionID")
    try {
      service.requireSession(sessionID)
      const rawCursor = c.req.query("cursor")
      if (rawCursor && c.req.query("order")) {
        throw new SessionServiceError("invalid_request", "Cursor cannot be combined with order")
      }
      const cursor = rawCursor ? decodeCursor<MessageCursor>(rawCursor) : undefined
      if (
        rawCursor &&
        (!cursor ||
          (cursor.order !== "asc" && cursor.order !== "desc") ||
          (cursor.direction !== "previous" && cursor.direction !== "next"))
      ) {
        throw new SessionServiceError("invalid_request", "Invalid cursor")
      }
      const order = cursor?.order ?? (c.req.query("order") === "asc" ? "asc" : "desc")
      const rawLimit = c.req.query("limit")
      const limit = rawLimit === undefined ? 50 : Number(rawLimit)
      if (!Number.isInteger(limit) || limit <= 0 || limit > 200) {
        throw new SessionServiceError("invalid_request", "limit must be between 1 and 200")
      }
      let messages = service.messages.listMessages(sessionID)
      if (order === "desc") messages = messages.reverse()
      let pageStart = 0
      if (cursor) {
        const index = messages.findIndex((message) => message.info.id === cursor.id)
        if (index < 0) throw new SessionServiceError("invalid_request", "Invalid cursor")
        pageStart = cursor.direction === "next" ? index + 1 : Math.max(0, index - limit)
      }
      const page = messages.slice(pageStart, pageStart + limit)
      const first = page[0]
      const last = page.at(-1)
      const hasPrevious = pageStart > 0
      const hasNext = pageStart + page.length < messages.length
      return c.json({
        data: page.map(toV2Message),
        cursor: {
          previous:
            hasPrevious && first
              ? encodeCursor({
                  version: 1,
                  order,
                  direction: "previous",
                  id: first.info.id,
                })
              : undefined,
          next:
            hasNext && last
              ? encodeCursor({
                  version: 1,
                  order,
                  direction: "next",
                  id: last.info.id,
                })
              : undefined,
        },
      })
    } catch (error) {
      return v2Error(c, error)
    }
  })

  return app
}

function sessionEventStream(
  service: SessionService,
  logger: Logger,
  sessionID: string,
  after: number,
  signal: AbortSignal,
): Response {
  let cancel: (() => void) | undefined
  const stream = new ReadableStream({
    start(controller) {
      let closed = false
      let last = after
      let replaying = true
      const pending: Array<ReturnType<SessionService["sessionEvents"]["append"]>> = []
      const encoder = new TextEncoder()
      const send = (event: ReturnType<SessionService["sessionEvents"]["append"]>) => {
        if (closed || event.durable.seq <= last) return
        last = event.durable.seq
        logger.interaction("opencode", "out", { kind: "SSE message", path: `/api/session/${sessionID}/event` }, event)
        controller.enqueue(
          encoder.encode(`id: ${event.durable.seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`),
        )
      }
      const unsubscribe = service.sessionEvents.subscribe(sessionID, (event) => {
        if (replaying) {
          pending.push(event)
          return
        }
        send(event)
      })
      let replayAfter = after
      while (true) {
        const page = service.sessionEvents.list(sessionID, replayAfter, 100)
        for (const event of page.events) {
          send(event)
          replayAfter = event.durable.seq
        }
        if (!page.hasMore) break
      }
      replaying = false
      pending.sort((left, right) => left.durable.seq - right.durable.seq)
      for (const event of pending) send(event)
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"))
      }, 10_000)
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        unsubscribe()
        signal.removeEventListener("abort", close)
        try {
          controller.close()
        } catch {}
      }
      signal.addEventListener("abort", close)
      if (signal.aborted) close()
      cancel = close
    },
    cancel() {
      cancel?.()
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

function v2Error(c: { json(value: unknown, status?: number): Response }, error: unknown): Response {
  const serviceError =
    error instanceof SessionServiceError
      ? error
      : new SessionServiceError("invalid_request", error instanceof Error ? error.message : String(error))
  if (serviceError.code === "not_found") {
    const sessionID = String(serviceError.details.sessionID ?? "")
    return c.json({ _tag: "SessionNotFoundError", sessionID, message: serviceError.message }, 404)
  }
  if (serviceError.code === "message_not_found") {
    return c.json(
      {
        _tag: "MessageNotFoundError",
        sessionID: String(serviceError.details.sessionID ?? ""),
        messageID: String(serviceError.details.messageID ?? ""),
        message: serviceError.message,
      },
      404,
    )
  }
  if (serviceError.code === "conflict") {
    return c.json(
      {
        _tag: "ConflictError",
        message: serviceError.message,
        resource: serviceError.details.resource,
      },
      409,
    )
  }
  if (serviceError.code === "unavailable") {
    return c.json(
      {
        _tag: "ServiceUnavailableError",
        message: serviceError.message,
        service: serviceError.details.service,
      },
      503,
    )
  }
  return c.json({ _tag: "InvalidRequestError", message: serviceError.message }, 400)
}
