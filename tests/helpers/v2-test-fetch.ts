type Fetch = typeof globalThis.fetch
type JsonRecord = Record<string, any>

/**
 * Migrates the existing backend-behavior scenarios onto the v2 wire protocol.
 *
 * The scenarios intentionally keep their detailed repository-style assertions
 * for Pi events and parts. This adapter only lives in tests: it translates
 * their setup/read helpers to `/api/*`, then expands the public v2 projection
 * back into the assertion-friendly shape used by those scenarios.
 */
export function createV2TestFetch(nativeFetch: Fetch = globalThis.fetch): Fetch {
  const permissionSessions = new Map<string, string>()

  return (async (input: Parameters<Fetch>[0], init?: RequestInit) => {
    const original = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
    const path = original.pathname
    if (path.startsWith("/api/") || path.startsWith("/experimental/")) {
      return nativeFetch(input, init)
    }

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const json = parseBody(init?.body)
    const sessionMatch = path.match(/^\/session\/([^/]+)(.*)$/)

    if (path === "/session" && (!init?.method || init.method === "GET")) {
      const target = apiURL(original, "/api/session")
      target.searchParams.set("limit", "5000")
      target.searchParams.set("order", "asc")
      const response = await nativeFetch(target, { ...init, headers })
      const body = await response.json() as { data: JsonRecord[] }
      return jsonResponse(body.data.map(legacySession), response)
    }

    if (path === "/session" && init?.method === "POST") {
      const model = modelRef(json?.model)
      const payload = {
        id: json?.id,
        agent: json?.agent,
        model,
        location: {
          directory: requestDirectory(original, headers, json?.directory),
        },
      }
      const response = await nativeFetch(apiURL(original, "/api/session"), jsonInit(init, headers, payload))
      const body = await response.json() as { data: JsonRecord }
      if (typeof json?.title === "string" && json.title !== "Untitled") {
        await nativeFetch(
          apiURL(original, `/api/session/${body.data.id}`),
          jsonInit({ method: "PATCH" }, headers, { title: json.title }),
        )
        body.data.title = json.title
      }
      return jsonResponse(legacySession(body.data), response)
    }

    if (path === "/session/status") {
      const [sessionsResponse, activeResponse] = await Promise.all([
        nativeFetch(apiURL(original, "/api/session?limit=5000&order=asc"), { headers }),
        nativeFetch(apiURL(original, "/api/session/active"), { headers }),
      ])
      const sessions = (await sessionsResponse.json() as { data: JsonRecord[] }).data
      const active = (await activeResponse.json() as { data: Record<string, unknown> }).data
      return jsonResponse(
        Object.fromEntries(
          sessions.map((session) => [
            session.id,
            {
              type: active[session.id] ? "busy" : "idle",
              status: session.status,
              title: session.title,
            },
          ]),
        ),
        activeResponse,
      )
    }

    if (sessionMatch) {
      const sessionID = sessionMatch[1]!
      const suffix = sessionMatch[2]!
      if (suffix === "" && (!init?.method || init.method === "GET")) {
        const response = await nativeFetch(apiURL(original, `/api/session/${sessionID}`), { ...init, headers })
        const body = await response.json() as { data: JsonRecord }
        return jsonResponse(legacySession(body.data), response)
      }
      if (suffix === "" && init?.method === "PATCH") {
        const response = await nativeFetch(
          apiURL(original, `/api/session/${sessionID}`),
          jsonInit(init, headers, json ?? {}),
        )
        const body = await response.json() as { data: JsonRecord }
        return jsonResponse(legacySession(body.data), response)
      }
      if (suffix === "" && init?.method === "DELETE") {
        const response = await nativeFetch(apiURL(original, `/api/session/${sessionID}`), { ...init, headers })
        return response.ok ? jsonResponse(true, response) : response
      }
      if (suffix === "/children") {
        const response = await nativeFetch(apiURL(original, `/api/session/${sessionID}/children`), {
          ...init,
          headers,
        })
        const body = await response.json() as { data: JsonRecord[] }
        return jsonResponse(body.data.map(legacySession), response)
      }
      if (suffix === "/message" && (!init?.method || init.method === "GET")) {
        const target = apiURL(original, `/api/session/${sessionID}/message`)
        target.searchParams.set("limit", "200")
        target.searchParams.set("order", "asc")
        const response = await nativeFetch(target, { ...init, headers })
        const body = await response.json() as { data: JsonRecord[] }
        return jsonResponse(body.data.map((message) => legacyMessage(message, sessionID)), response)
      }
      if (suffix === "/message" && init?.method === "POST") {
        const admitted = await prompt(nativeFetch, original, headers, sessionID, json ?? {}, "steer")
        if (!admitted.ok) return admitted
        const waited = await nativeFetch(apiURL(original, `/api/session/${sessionID}/wait`), {
          method: "POST",
          headers,
        })
        if (!waited.ok) return waited
        const messages = await nativeFetch(
          apiURL(original, `/api/session/${sessionID}/message?limit=200&order=asc`),
          { headers },
        )
        const data = (await messages.json() as { data: JsonRecord[] }).data
        const assistant = [...data].reverse().find((message) => message.type === "assistant")
        return jsonResponse(legacyMessage(assistant ?? {}, sessionID), messages)
      }
      if (suffix === "/prompt_async") {
        const response = await prompt(nativeFetch, original, headers, sessionID, json ?? {}, "queue")
        return response.ok ? new Response(null, { status: 204, headers: response.headers }) : response
      }
      if (suffix === "/abort") {
        const response = await nativeFetch(apiURL(original, `/api/session/${sessionID}/interrupt`), {
          method: "POST",
          headers,
        })
        return response.ok ? jsonResponse(true, response) : response
      }
      if (suffix === "/summarize") {
        const response = await nativeFetch(apiURL(original, `/api/session/${sessionID}/compact`), {
          method: "POST",
          headers,
        })
        return response.ok ? jsonResponse(true, response) : response
      }
      if (suffix === "/revert") {
        const response = await nativeFetch(
          apiURL(original, `/api/session/${sessionID}/revert/stage`),
          jsonInit({ method: "POST" }, headers, { messageID: json?.messageID, files: json?.files }),
        )
        if (!response.ok) return response
        const session = await nativeFetch(apiURL(original, `/api/session/${sessionID}`), { headers })
        return jsonResponse(legacySession((await session.json() as { data: JsonRecord }).data), session)
      }
      if (suffix === "/unrevert") {
        const response = await nativeFetch(apiURL(original, `/api/session/${sessionID}/revert/clear`), {
          method: "POST",
          headers,
        })
        if (!response.ok) return response
        const session = await nativeFetch(apiURL(original, `/api/session/${sessionID}`), { headers })
        return jsonResponse(legacySession((await session.json() as { data: JsonRecord }).data), session)
      }
      if (suffix === "/permissions") {
        const response = await nativeFetch(apiURL(original, `/api/session/${sessionID}/permission`), {
          ...init,
          headers,
        })
        const body = await response.json() as { data: JsonRecord[] }
        for (const row of body.data) permissionSessions.set(row.id, sessionID)
        return jsonResponse(body.data.map(legacyPermission), response)
      }
      const permissionMatch = suffix.match(/^\/permissions\/([^/]+)$/)
      if (permissionMatch) {
        if (init?.method === "POST") {
          const response = await nativeFetch(
            apiURL(original, `/api/session/${sessionID}/permission/${permissionMatch[1]}/reply`),
            jsonInit({ method: "POST" }, headers, {
              reply: json?.action === "deny" ? "reject" : "once",
              message: json?.reason,
            }),
          )
          return response.ok ? jsonResponse(true, response) : response
        }
        const response = await nativeFetch(
          apiURL(original, `/api/session/${sessionID}/permission/${permissionMatch[1]}`),
          { ...init, headers },
        )
        const body = await response.json() as { data: JsonRecord }
        permissionSessions.set(body.data.id, sessionID)
        return jsonResponse(legacyPermission(body.data), response)
      }
    }

    if (path === "/permission") {
      const response = await nativeFetch(apiURL(original, "/api/permission/request"), { ...init, headers })
      const body = await response.json() as { data: JsonRecord[] }
      for (const row of body.data) permissionSessions.set(row.id, row.sessionID)
      return jsonResponse(body.data.map(legacyPermission), response)
    }

    const permissionReply = path.match(/^\/permission\/([^/]+)\/reply$/)
    if (permissionReply) {
      const requestID = permissionReply[1]!
      const sessionID = permissionSessions.get(requestID)
      if (!sessionID) return jsonResponse({ error: "Permission session is unknown" }, undefined, 404)
      const reply = json?.response === "deny" || json?.reply === "reject" ? "reject" : "once"
      const response = await nativeFetch(
        apiURL(original, `/api/session/${sessionID}/permission/${requestID}/reply`),
        jsonInit({ method: "POST" }, headers, { reply, message: json?.message }),
      )
      return response.ok ? jsonResponse(true, response) : response
    }

    if (path === "/agent" && (!init?.method || init.method === "GET")) {
      const response = await nativeFetch(apiURL(original, "/api/agent"), { ...init, headers })
      const body = await response.json() as { data: JsonRecord[] }
      return jsonResponse(body.data.map(legacyAgent), response)
    }
    if (path === "/agent" && init?.method === "POST") {
      const response = await nativeFetch(apiURL(original, "/api/agent"), jsonInit(init, headers, json ?? {}))
      if (!response.ok) return response
      const body = await response.json() as { data: JsonRecord }
      return jsonResponse(legacyAgent(body.data), response)
    }
    const agentDelete = path.match(/^\/agent\/([^/]+)$/)
    if (agentDelete && init?.method === "DELETE") {
      const response = await nativeFetch(apiURL(original, `/api/agent/${agentDelete[1]}`), { ...init, headers })
      return response.ok ? jsonResponse(true, response) : response
    }

    if (path === "/event" || path === "/global/event") {
      const response = await nativeFetch(apiURL(original, "/api/event"), { ...init, headers })
      return path === "/global/event" ? legacyGlobalSse(response) : response
    }

    return nativeFetch(input, init)
  }) as Fetch
}

async function prompt(
  nativeFetch: Fetch,
  original: URL,
  headers: Headers,
  sessionID: string,
  body: JsonRecord,
  delivery: "steer" | "queue",
) {
  if (body.agent) {
    const switched = await nativeFetch(
      apiURL(original, `/api/session/${sessionID}/agent`),
      jsonInit({ method: "POST" }, headers, { agent: body.agent }),
    )
    if (!switched.ok) return switched
  }
  const model = modelRef(body.model)
  if (model) {
    const switched = await nativeFetch(
      apiURL(original, `/api/session/${sessionID}/model`),
      jsonInit({ method: "POST" }, headers, { model }),
    )
    if (!switched.ok) return switched
  }
  const parts = Array.isArray(body.parts) ? body.parts : []
  const text = parts.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n\n")
  const files = parts
    .filter((part) => part?.type === "file")
    .map((part) => ({ uri: part.url ?? part.uri, name: part.filename ?? part.name, source: part.source }))
  const agents = parts
    .filter((part) => part?.type === "agent")
    .map((part) => ({ name: part.name, source: part.source }))
  const subtasks = parts.filter((part) => part?.type === "subtask")
  return nativeFetch(
    apiURL(original, `/api/session/${sessionID}/prompt`),
    jsonInit({ method: "POST" }, headers, {
      id: body.messageID,
      prompt: { text, files, agents, subtasks },
      delivery,
      resume: body.resume,
      noReply: body.noReply,
      system: body.system,
      tools: body.tools,
      subtaskMode: body.subtaskMode,
    }),
  )
}

function legacySession(session: JsonRecord) {
  return {
    ...session,
    directory: session.location?.directory,
    model: session.model
      ? { providerID: session.model.providerID, id: session.model.id, modelID: session.model.id, variant: session.model.variant }
      : undefined,
  }
}

function legacyMessage(message: JsonRecord, sessionID: string) {
  if (message.type === "user") {
    const parts: JsonRecord[] = [
      ...(message.text ? [{ type: "text", id: `${message.id}_text`, text: message.text }] : []),
      ...(message.files ?? []).map((file: JsonRecord, index: number) => ({
        type: "file",
        id: `${message.id}_file_${index}`,
        url: file.uri,
        mime: file.mime,
        filename: file.name,
        source: file.source,
      })),
      ...(message.agents ?? []).map((agent: JsonRecord, index: number) => ({
        type: "agent",
        id: `${message.id}_agent_${index}`,
        ...agent,
      })),
      ...(message.subtasks ?? []),
    ]
    return {
      info: {
        id: message.id,
        sessionID,
        role: "user",
        time: message.time,
        agent: message.agent,
        model: message.model,
        system: message.system,
      },
      parts,
    }
  }
  return {
    info: {
      id: message.id,
      sessionID,
      role: "assistant",
      time: message.time,
      agent: message.agent,
      modelID: message.model?.id,
      providerID: message.model?.providerID,
      finish: message.finish,
      cost: message.cost,
      tokens: message.tokens,
      error: message.error ? { name: "UnknownError", data: { message: message.error.message } } : undefined,
    },
    parts: (message.content ?? []).map((content: JsonRecord) => {
      if (content.type !== "tool") {
        return {
          ...content,
          sessionID,
          messageID: message.id,
          time: content.time
            ? { start: content.time.created ?? content.time.start, end: content.time.completed ?? content.time.end }
            : undefined,
        }
      }
      const output =
        content.state?.result ??
        content.state?.content?.filter((item: JsonRecord) => item.type === "text").map((item: JsonRecord) => item.text).join("")
      return {
        id: content.partID ?? content.id,
        sessionID,
        messageID: message.id,
        type: "tool",
        callID: content.callID ?? content.id,
        tool: content.name,
        state: {
          status: content.state?.status,
          input: content.state?.input,
          output,
          error: content.state?.error?.message,
          title: content.title,
          metadata: content.metadata,
          time: { start: content.time?.ran ?? content.time?.created, end: content.time?.completed },
        },
      }
    }),
  }
}

function legacyPermission(permission: JsonRecord) {
  return {
    ...permission,
    permission: permission.action,
    tool: permission.action,
    patterns: permission.resources,
    status: "pending",
  }
}

function legacyAgent(agent: JsonRecord) {
  return {
    ...agent,
    name: agent.id,
    description: agent.description ?? agent.name,
    permission: agent.permissions ?? [],
    options: {},
  }
}

function modelRef(model: JsonRecord | undefined) {
  if (!model?.providerID) return undefined
  const id = model.id ?? model.modelID
  return id ? { id, providerID: model.providerID, variant: model.variant } : undefined
}

function requestDirectory(url: URL, headers: Headers, bodyDirectory?: unknown) {
  if (typeof bodyDirectory === "string") return bodyDirectory
  const query = url.searchParams.get("directory") ?? url.searchParams.get("location[directory]")
  if (query) return query
  const header = headers.get("x-opencode-directory")
  if (!header) return process.cwd()
  try {
    return decodeURIComponent(header)
  } catch {
    return header
  }
}

function apiURL(original: URL, path: string) {
  return new URL(path, original.origin)
}

function parseBody(body: RequestInit["body"]): JsonRecord | undefined {
  if (typeof body !== "string" || !body) return undefined
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function jsonInit(init: RequestInit, headers: Headers, body: unknown): RequestInit {
  headers.set("Content-Type", "application/json")
  return { ...init, headers, body: JSON.stringify(body) }
}

function jsonResponse(value: unknown, source?: Response, status = source?.status ?? 200) {
  const headers = new Headers(source?.headers)
  headers.set("Content-Type", "application/json")
  return new Response(JSON.stringify(value), { status, headers })
}

function legacyGlobalSse(response: Response) {
  if (!response.body) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        const records = buffer.split(/\r?\n\r?\n/)
        buffer = records.pop() ?? ""
        for (const record of records) controller.enqueue(encoder.encode(toLegacySseRecord(record) + "\n\n"))
      },
      flush(controller) {
        buffer += decoder.decode()
        if (buffer) controller.enqueue(encoder.encode(toLegacySseRecord(buffer)))
      },
    }),
  )
  return new Response(body, { status: response.status, headers: response.headers })
}

function toLegacySseRecord(record: string) {
  return record
    .split(/\r?\n/)
    .map((line) => {
      if (!line.startsWith("data: ")) return line
      try {
        const event = JSON.parse(line.slice(6)) as JsonRecord
        return `data: ${JSON.stringify({
          directory: event.location?.directory,
          payload: { id: event.id, type: event.type, properties: event.data ?? {} },
        })}`
      } catch {
        return line
      }
    })
    .join("\n")
}
