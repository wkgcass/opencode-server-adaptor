import type {
  AgentAdapter,
  AgentAdapterConfig,
  AgentRuntime,
  AgentRuntimeContext,
  AgentRuntimeEvent,
  PromptInput,
} from "./agent-adapter.ts"

export class StubAgentRuntime implements AgentRuntime {
  private listeners = new Set<(event: AgentRuntimeEvent) => void>()
  private running = false
  private readonly context: AgentRuntimeContext

  constructor(context: AgentRuntimeContext) {
    this.context = context
  }

  async start(): Promise<void> {
    this.running = true
    this.context.logger.info("Stub agent runtime started", { sessionId: this.context.sessionId })
  }

  async stop(): Promise<void> {
    this.running = false
    this.context.logger.info("Stub agent runtime stopped", { sessionId: this.context.sessionId })
  }

  async prompt(input: PromptInput): Promise<void> {
    if (!this.running) {
      throw new Error("Runtime not started")
    }

    this.emit({ type: "session_busy", sessionId: input.sessionId })

    const partId = `prt_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`

    this.emit({
      type: "text_started",
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      partId,
    })

    const response = `Hello! This is a stub response to: "${input.text}". No real agent backend is connected.`
    const words = response.split(" ")
    let streamedText = ""

    for (const word of words) {
      await Bun.sleep(10)
      const delta = word + " "
      streamedText += delta
      this.emit({
        type: "text_delta",
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        partId,
        delta,
        text: streamedText,
      })
    }

    this.emit({
      type: "text_ended",
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      partId,
      text: streamedText,
    })

    this.emit({ type: "message_completed", sessionId: input.sessionId, messageId: input.assistantMessageId })
    this.emit({ type: "session_idle", sessionId: input.sessionId })
  }

  async abort(): Promise<void> {
    this.emit({ type: "session_idle", sessionId: this.context.sessionId })
  }

  async createSessionFork(input: { targetSessionId: string }): Promise<{ backendSessionId: string }> {
    if (!this.running) throw new Error("Runtime not started")
    return { backendSessionId: `stub:${input.targetSessionId}` }
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: AgentRuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // ignore listener errors
      }
    }
  }
}

export class StubAgentAdapter implements AgentAdapter {
  readonly id = "stub"
  readonly displayName = "Stub Agent"
  readonly removable = false

  async validateConfig(input: unknown): Promise<AgentAdapterConfig> {
    return (input ?? {}) as AgentAdapterConfig
  }

  async createRuntime(context: AgentRuntimeContext): Promise<AgentRuntime> {
    return new StubAgentRuntime(context)
  }
}
