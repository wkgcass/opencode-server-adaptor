import type { InteractionChannel } from "./index.ts"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : undefined
}

function defined(input: UnknownRecord): UnknownRecord {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
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
  const status = metadata.status
  if (typeof status === "number" && (status < 200 || status >= 300)) return false
  if (typeof metadata.url !== "string") return false
  const path = metadata.url.split("?", 1)[0] ?? metadata.url
  return /^\/api\/session\/[^/]+\/message\/?$/.test(path)
}

function compactSessionMessagesResponse(payload: unknown): unknown {
  const envelope = record(payload)
  if (envelope && Array.isArray(envelope.data)) {
    return {
      ...envelope,
      data: envelope.data.map(compactV2Message),
    }
  }
  return payload
}

function compactV2Message(value: unknown): unknown {
  const message = record(value)
  if (!message || (message.type !== "user" && message.type !== "assistant")) return value
  if (message.type === "user") {
    return defined({
      id: message.id,
      type: message.type,
      time: message.time,
      textLength: typeof message.text === "string" ? message.text.length : undefined,
      fileCount: Array.isArray(message.files) ? message.files.length : undefined,
      agentCount: Array.isArray(message.agents) ? message.agents.length : undefined,
      subtaskCount: Array.isArray(message.subtasks) ? message.subtasks.length : undefined,
      systemLength: typeof message.system === "string" ? message.system.length : undefined,
    })
  }
  return defined({
    id: message.id,
    type: message.type,
    time: message.time,
    agent: message.agent,
    model: message.model,
    finish: message.finish,
    cost: message.cost,
    tokens: message.tokens,
    error: message.error,
    content: Array.isArray(message.content)
      ? message.content.map((item) => {
          const content = record(item)
          if (!content) return item
          if (content.type === "text" || content.type === "reasoning") {
            return defined({
              type: content.type,
              id: content.id,
              textLength: typeof content.text === "string" ? content.text.length : undefined,
              time: content.time,
            })
          }
          if (content.type === "tool") {
            const state = record(content.state)
            const metadata = record(content.metadata)
            const partialOutput = metadata?.partialOutput
            const compactedMetadata = metadata ? compactMetadata(metadata) : undefined
            return defined({
              type: content.type,
              id: content.id,
              partID: content.partID,
              callID: content.callID,
              name: content.name,
              status: state?.status,
              input: state?.status === "pending" ? state.input : undefined,
              title: content.title,
              time: content.time,
              error: state?.error,
              contentCount: Array.isArray(state?.content) ? state.content.length : undefined,
              resultLength: typeof state?.result === "string" ? state.result.length : undefined,
              partialOutputLength: typeof partialOutput === "string" ? partialOutput.length : undefined,
              metadata: compactedMetadata && Object.keys(compactedMetadata).length > 0 ? compactedMetadata : undefined,
            })
          }
          return content
        })
      : undefined,
  })
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
  // Session history can contain the complete accumulated conversation and
  // terminal tool output. Keep the real HTTP response untouched while making
  // its verbose log use the same identity-and-length summaries as SSE.
  if (channel === "opencode" && isSessionMessagesResponse(metadata)) {
    return compactSessionMessagesResponse(payload)
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
