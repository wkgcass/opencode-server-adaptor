import type { InteractionChannel } from "./index.ts"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : undefined
}

function defined(input: UnknownRecord): UnknownRecord {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

function withoutFields(value: unknown, fields: readonly string[]): UnknownRecord | undefined {
  const input = record(value)
  if (!input) return undefined
  return Object.fromEntries(Object.entries(input).filter(([key]) => !fields.includes(key)))
}

function compactMetadata(metadata: UnknownRecord): UnknownRecord {
  const truncation = record(metadata.truncation)
  return defined({
    ...metadata,
    partialOutput: undefined,
    truncation: truncation
      ? defined({
          ...truncation,
          content: undefined,
          contentLength: typeof truncation.content === "string" ? truncation.content.length : undefined,
        })
      : metadata.truncation,
  })
}

function compactPart(part: UnknownRecord): UnknownRecord {
  const base = {
    id: part.id,
    messageID: part.messageID,
    sessionID: part.sessionID,
    type: part.type,
  }

  if (part.type === "text" || part.type === "reasoning") {
    return defined({
      ...base,
      textLength: typeof part.text === "string" ? part.text.length : undefined,
      time: part.time,
    })
  }

  if (part.type === "tool") {
    const state = record(part.state)
    const metadata = record(state?.metadata)
    const partialOutput = metadata?.partialOutput
    const compactedMetadata = metadata ? compactMetadata(metadata) : undefined
    return defined({
      ...base,
      callID: part.callID,
      tool: part.tool,
      status: state?.status,
      // Input is most useful when the card is first created. Running and
      // terminal snapshots otherwise repeat the same potentially large value.
      input: state?.status === "pending" ? state.input : undefined,
      title: state?.title,
      outputLength: typeof state?.output === "string" ? state.output.length : undefined,
      partialOutputLength: typeof partialOutput === "string" ? partialOutput.length : undefined,
      error: state?.error,
      metadata: compactedMetadata && Object.keys(compactedMetadata).length > 0 ? compactedMetadata : undefined,
      time: state?.time,
    })
  }

  if (part.type === "file") {
    return defined({
      ...base,
      mime: part.mime,
      filename: part.filename,
      urlLength: typeof part.url === "string" ? part.url.length : undefined,
      source: part.source,
    })
  }

  if (part.type === "agent") {
    return defined({
      ...base,
      name: part.name,
      source: part.source,
    })
  }

  if (part.type === "subtask") {
    return defined({
      ...base,
      promptLength: typeof part.prompt === "string" ? part.prompt.length : undefined,
      description: part.description,
      agent: part.agent,
      model: part.model,
      command: part.command,
    })
  }

  return part
}

function isSessionMessagesResponse(metadata: Record<string, unknown>): boolean {
  if (metadata.kind !== "HTTP response") return false
  if (metadata.method !== undefined && metadata.method !== "GET") return false
  const status = metadata.status
  if (typeof status === "number" && (status < 200 || status >= 300)) return false
  if (typeof metadata.url !== "string") return false
  const path = metadata.url.split("?", 1)[0] ?? metadata.url
  return /^\/api\/session\/[^/]+\/message\/?$/.test(path)
}

function isCommandListResponse(metadata: Record<string, unknown>): boolean {
  if (metadata.kind !== "HTTP response") return false
  if (metadata.method !== undefined && metadata.method !== "GET") return false
  const status = metadata.status
  if (typeof status === "number" && (status < 200 || status >= 300)) return false
  if (typeof metadata.url !== "string") return false
  const path = metadata.url.split("?", 1)[0] ?? metadata.url
  return /^\/api\/command\/?$/.test(path)
}

function sanitizeSessionMessages(payload: unknown): unknown {
  const envelope = record(payload)
  if (!envelope || !Array.isArray(envelope.data)) return payload
  return {
    ...envelope,
    data: envelope.data.map((value) => {
      const message = record(value)
      if (!message) return value
      const messageWithoutLargeFields = withoutFields(message, ["text", "summary"])!
      return {
        ...messageWithoutLargeFields,
        ...(Array.isArray(message.content)
          ? {
              content: message.content.map((item) => {
                const content = record(item)
                if (!content) return item
                const sanitized = withoutFields(content, ["text"])!
                const metadata = withoutFields(content.metadata, ["output", "partialOutput"])
                if (metadata) sanitized.metadata = metadata

                const state = withoutFields(content.state, ["result"])
                if (state) {
                  const input = withoutFields(state.input, ["command", "content", "path", "filePath"])
                  if (input) state.input = input

                  if (Array.isArray(state.content)) {
                    state.content = state.content.map((stateItem) => withoutFields(stateItem, ["text"]) ?? stateItem)
                  } else {
                    const stateContent = withoutFields(state.content, ["text"])
                    if (stateContent) state.content = stateContent
                  }

                  const stateMetadata = withoutFields(state.metadata, ["output", "partialOutput"])
                  if (stateMetadata) state.metadata = stateMetadata

                  const error = withoutFields(state.error, ["message"])
                  if (error) state.error = error

                  sanitized.state = state
                }
                return sanitized
              }),
            }
          : {}),
      }
    }),
  }
}

function stripCommandTemplates(payload: unknown): unknown {
  const envelope = record(payload)
  if (!envelope || !Array.isArray(envelope.data)) return payload
  return {
    ...envelope,
    data: envelope.data.map((value) => {
      const command = record(value)
      if (!command || !Object.prototype.hasOwnProperty.call(command, "template")) return value
      const { template: _template, ...commandWithoutTemplate } = command
      return commandWithoutTemplate
    }),
  }
}

function compactOpenCodeEvent(event: UnknownRecord): UnknownRecord {
  const properties = record(event.properties)
  if (typeof event.type !== "string" || !properties) return event

  if (event.type === "server.connected" || event.type === "server.heartbeat") {
    return { type: event.type }
  }

  if (event.type === "message.part.updated") {
    const part = record(properties.part)
    return defined({
      type: event.type,
      sessionID: properties.sessionID,
      part: part ? compactPart(part) : properties.part,
      time: properties.time,
    })
  }

  if (event.type === "message.updated") {
    const info = record(properties.info)
    return defined({
      type: event.type,
      sessionID: properties.sessionID ?? info?.sessionID,
      message: info
        ? defined({
            id: info.id,
            role: info.role,
            parentID: info.parentID,
            finish: info.finish,
            error: info.error,
            time: info.time,
            modelID: info.modelID,
            providerID: info.providerID,
            cost: info.cost,
            tokens: info.tokens,
          })
        : properties.info,
    })
  }

  return defined({ type: event.type, ...properties })
}

function compactOpenCodePayload(payload: unknown): unknown {
  const event = record(payload)
  if (!event) return payload
  const data = record(event.data)
  if (typeof event.type === "string" && data) {
    if (event.type === "session.next.text.ended" || event.type === "session.next.reasoning.ended") {
      return defined({
        id: event.id,
        type: event.type,
        durable: event.durable,
        location: event.location,
        data: defined({
          ...data,
          text: undefined,
          textLength: typeof data.text === "string" ? data.text.length : undefined,
        }),
      })
    }
    if (event.type === "session.next.prompt.admitted" || event.type === "session.next.prompted") {
      const prompt = record(data.prompt)
      return defined({
        id: event.id,
        type: event.type,
        durable: event.durable,
        location: event.location,
        data: defined({
          ...data,
          prompt: prompt
            ? defined({
                textLength: typeof prompt.text === "string" ? prompt.text.length : undefined,
                fileCount: Array.isArray(prompt.files) ? prompt.files.length : undefined,
                agentCount: Array.isArray(prompt.agents) ? prompt.agents.length : undefined,
              })
            : data.prompt,
        }),
      })
    }
    const compacted = compactOpenCodeEvent({
      type: event.type,
      properties: data,
    })
    return defined({
      id: event.id,
      type: event.type,
      durable: event.durable,
      location: event.location,
      data: Object.fromEntries(Object.entries(compacted).filter(([key]) => key !== "type")),
    })
  }
  return payload
}

export function optimizeInteractionPayload(
  channel: InteractionChannel,
  metadata: Record<string, unknown>,
  payload: unknown,
): unknown {
  if (channel === "opencode" && metadata.kind === "SSE message") {
    return compactOpenCodePayload(payload)
  }
  // Keep session history structure useful for diagnostics without repeating
  // message text or potentially large command/tool payload fields. The
  // returned copy affects only verbose logging, never the HTTP response.
  if (channel === "opencode" && isSessionMessagesResponse(metadata)) {
    return sanitizeSessionMessages(payload)
  }
  // Command templates can contain complete Skill instructions and dominate
  // the catalog response. Keep command identity and execution metadata only.
  if (channel === "opencode" && isCommandListResponse(metadata)) {
    return stripCommandTemplates(payload)
  }
  return payloadOptimizers.get(channel)?.(metadata, payload) ?? payload
}

export type InteractionPayloadOptimizer = (metadata: Record<string, unknown>, payload: unknown) => unknown

const payloadOptimizers = new Map<InteractionChannel, InteractionPayloadOptimizer>()

export function registerInteractionPayloadOptimizer(
  channel: InteractionChannel,
  optimizer: InteractionPayloadOptimizer,
): void {
  payloadOptimizers.set(channel, optimizer)
}
