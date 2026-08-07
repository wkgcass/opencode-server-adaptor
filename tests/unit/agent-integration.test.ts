import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AgentAdapter,
  AgentAdapterConfig,
  AgentModel,
  AgentRuntime,
  AgentRuntimeContext,
  AgentRuntimeEvent,
  PermissionResponse,
  PromptInput,
} from "../../src/agents/agent-adapter.ts"
import { installAgentIntegrations, type AgentIntegrationFactory } from "../../src/agents/agent-integration.ts"
import { AgentAdapterRegistry } from "../../src/agents/registry.ts"
import { StubAgentRuntime } from "../../src/agents/stub-adapter.ts"
import { loadConfig } from "../../src/config/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { createServerContext } from "../../src/server.ts"
import { createMessageId } from "../../src/id/index.ts"

describe("agent integrations", () => {
  const cleanup: string[] = []

  afterEach(() => {
    for (const directory of cleanup.splice(0)) {
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch {}
    }
  })

  test("installs adapters and selects metadata from the preferred integration", () => {
    const registry = new AgentAdapterRegistry()
    const first = new ConfigAwareAdapter("first")
    const preferred = new ConfigAwareAdapter("preferred")

    const installed = installAgentIntegrations(
      registry,
      [
        {
          adapters: [first],
          defaultAdapterType: "first-type",
          defaultModel: "first/model",
          providers: [{ id: "first", name: "First", modelID: "model" }],
        },
        {
          adapters: [preferred],
          defaultAdapterType: "preferred-type",
          defaultModel: "preferred/model",
          providers: [{ id: "preferred", name: "Preferred", modelID: "model" }],
        },
      ],
      "preferred",
    )

    expect(registry.list().map((adapter) => adapter.id)).toEqual(["first", "preferred"])
    expect(installed.defaultAdapterType).toBe("preferred-type")
    expect(installed.defaultModel).toBe("preferred/model")
    expect(installed.providers.map((provider) => provider.id)).toEqual(["first", "preferred"])
  })

  test("rejects duplicate adapter and factory registrations instead of silently replacing them", () => {
    const registry = new AgentAdapterRegistry()
    registry.register(new ConfigAwareAdapter("same"))
    expect(() => registry.register(new ConfigAwareAdapter("same"))).toThrow("already registered")

    registry.registerFactory("custom", (input) => new ConfigAwareAdapter(input.id))
    expect(() => registry.registerFactory("custom", (input) => new ConfigAwareAdapter(input.id))).toThrow(
      "already registered",
    )
  })

  test("server can replace Pi with another integration and validates runtime configuration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-integration-"))
    cleanup.push(directory)
    const adapter = new ConfigAwareAdapter("custom")
    const integration: AgentIntegrationFactory = () => ({
      adapters: [adapter],
      providers: [{ id: "custom", name: "Custom", modelID: "model" }],
      defaultAdapterType: "custom",
      defaultModel: "custom/model",
    })
    const config = {
      ...loadConfig(),
      databasePath: join(directory, "adaptor.db"),
      defaultAgent: "custom",
      serverUsername: null,
      serverPassword: null,
    }
    const logger = new Logger({ minLevel: "ERROR" })
    const context = createServerContext(config, logger, { agentIntegrations: [integration] })

    try {
      const agents = (await (await context.app.request("/api/agent")).json()) as {
        location: unknown
        data: Array<{ id: string }>
      }
      expect(agents.data.map((agent) => agent.id)).toEqual(["stub", "custom"])

      const createResponse = await context.app.request("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "custom", model: { id: "model", providerID: "custom" } }),
      })
      const session = ((await createResponse.json()) as { data: { id: string } }).data
      const promptResponse = await context.app.request(`/api/session/${session.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: { text: "integration prompt" },
        }),
      })
      expect(promptResponse.status).toBe(200)

      for (let attempt = 0; attempt < 100 && adapter.validated.length === 0; attempt++) {
        await Bun.sleep(10)
      }
      expect(adapter.validated).toEqual([{ backend: "custom", model: { providerID: "custom", modelID: "model" } }])
    } finally {
      await context.agentService.closeAll()
      context.db.close()
    }
  })

  test("recovers and persists a backend delta when the part start event is missing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-event-recovery-"))
    cleanup.push(directory)
    const adapter = new MissingStartAdapter()
    const integration: AgentIntegrationFactory = () => ({
      adapters: [adapter],
      providers: [{ id: adapter.id, name: "Missing Start", modelID: "model" }],
      defaultAdapterType: adapter.id,
      defaultModel: `${adapter.id}/model`,
    })
    const config = {
      ...loadConfig(),
      databasePath: join(directory, "adaptor.db"),
      providerConfigPath: join(directory, "providers.yaml"),
      defaultAgent: adapter.id,
      serverUsername: null,
      serverPassword: null,
    }
    const logger = new Logger({ minLevel: "ERROR" })
    const context = createServerContext(config, logger, { agentIntegrations: [integration] })

    try {
      const session = context.sessions.create({ directory, title: "Recovery", agent: adapter.id })
      const response = await context.app.request(`/api/session/${session.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: { text: "recover the missing start" },
        }),
      })
      expect(response.status).toBe(200)

      let assistant = context.messages
        .listMessages(session.id)
        .find((message) => message.info.role === "assistant" && message.info.time.completed !== undefined)
      for (let attempt = 0; attempt < 100 && !assistant; attempt++) {
        await Bun.sleep(10)
        assistant = context.messages
          .listMessages(session.id)
          .find((message) => message.info.role === "assistant" && message.info.time.completed !== undefined)
      }

      expect(assistant?.parts).toContainEqual(
        expect.objectContaining({
          type: "text",
          text: "delta survived",
        }),
      )
      expect(assistant?.parts).toContainEqual(
        expect.objectContaining({
          type: "reasoning",
          text: "reasoning survived",
        }),
      )
      expect(assistant?.parts).toContainEqual(
        expect.objectContaining({
          type: "tool",
          callID: "call-without-start",
          state: expect.objectContaining({
            status: "completed",
            output: "tool output survived",
          }),
        }),
      )
      expect(
        context.messages.listMessages(session.id).filter((message) => message.info.role === "assistant"),
      ).toHaveLength(1)
      expect(context.sessions.get(session.id)?.title).toBe("Backend-updated title")
    } finally {
      await context.agentService.closeAll()
      context.db.close()
    }
  })

  test("encapsulates generated assistant parts without completing the session early", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-part-encap-"))
    cleanup.push(directory)
    const adapter = new GatedEncapsulationAdapter()
    const integration: AgentIntegrationFactory = () => ({
      adapters: [adapter],
      providers: [{ id: adapter.id, name: "Encapsulation", modelID: "model" }],
      defaultAdapterType: adapter.id,
      defaultModel: `${adapter.id}/model`,
    })
    const config = {
      ...loadConfig(),
      databasePath: join(directory, "adaptor.db"),
      providerConfigPath: join(directory, "providers.yaml"),
      defaultAgent: adapter.id,
      serverUsername: null,
      serverPassword: null,
    }
    const context = createServerContext(config, new Logger({ minLevel: "ERROR" }), {
      agentIntegrations: [integration],
      msgPartEncap: true,
    })

    try {
      const session = context.sessions.create({ directory, title: "Encapsulation", agent: adapter.id })
      const response = await context.app.request(`/api/session/${session.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: createMessageId(undefined, "wide"),
          prompt: { text: "encapsulate the response" },
        }),
      })
      expect(response.status).toBe(200)

      let assistants = context.messages.listMessages(session.id).filter((message) => message.info.role === "assistant")
      for (
        let attempt = 0;
        attempt < 100 &&
        (assistants.length !== 3 ||
          assistants.some((message) => message.info.role !== "assistant" || message.info.time.completed === undefined));
        attempt++
      ) {
        await Bun.sleep(10)
        assistants = context.messages.listMessages(session.id).filter((message) => message.info.role === "assistant")
      }

      expect(assistants).toHaveLength(3)
      expect(assistants.map((message) => message.parts.length)).toEqual([1, 1, 1])
      expect(assistants.map((message) => message.parts[0]?.type)).toEqual(["text", "reasoning", "tool"])
      expect(assistants.map((message) => message.info.id)).toEqual(
        assistants.map((message) => message.info.id).toSorted(),
      )
      expect(
        assistants.every((message) => message.info.role === "assistant" && message.info.time.completed !== undefined),
      ).toBe(true)
      expect(
        assistants.map((message) => (message.info.role === "assistant" ? message.info.finish : undefined)),
      ).toEqual([undefined, undefined, "stop"])
      expect(
        assistants.map((message) => (message.info.role === "assistant" ? message.info.tokens.input : undefined)),
      ).toEqual([0, 0, 12])
      expect(assistants.map((message) => (message.info.role === "assistant" ? message.info.cost : undefined))).toEqual([
        0, 0, 0.01,
      ])
      expect(context.sessions.getStatus(session.id)).toBe("busy")

      const history = await context.app.request(`/api/session/${session.id}/message?order=asc&limit=20`)
      const payload = (await history.json()) as {
        data: Array<{ type: string; id: string; content?: Array<{ type: string }> }>
      }
      const projected = payload.data.filter((message) => message.type === "assistant")
      expect(projected.map((message) => message.content?.length)).toEqual([1, 1, 1])
      expect(projected.map((message) => message.content?.[0]?.type)).toEqual(["text", "reasoning", "tool"])

      adapter.releaseIdle()
      for (let attempt = 0; attempt < 100 && context.sessions.getStatus(session.id) !== "idle"; attempt++) {
        await Bun.sleep(10)
      }
      expect(context.sessions.getStatus(session.id)).toBe("idle")
    } finally {
      adapter.releaseIdle()
      await context.agentService.closeAll()
      context.db.close()
    }
  })
})

class ConfigAwareAdapter implements AgentAdapter {
  readonly id: string
  readonly displayName: string
  readonly removable = false
  readonly validated: AgentAdapterConfig[] = []

  constructor(id: string) {
    this.id = id
    this.displayName = `${id} agent`
  }

  getRuntimeConfig(model: AgentModel | undefined): AgentAdapterConfig {
    return { backend: this.id, model }
  }

  async validateConfig(input: unknown): Promise<AgentAdapterConfig> {
    const config = input as AgentAdapterConfig
    this.validated.push(config)
    return config
  }

  async createRuntime(context: AgentRuntimeContext): Promise<StubAgentRuntime> {
    return new StubAgentRuntime(context)
  }
}

class MissingStartAdapter implements AgentAdapter {
  readonly id = "missing-start"
  readonly displayName = "Missing Start"

  async validateConfig(input: unknown): Promise<AgentAdapterConfig> {
    return input as AgentAdapterConfig
  }

  async createRuntime(context: AgentRuntimeContext): Promise<AgentRuntime> {
    return new MissingStartRuntime(context.sessionId)
  }
}

class MissingStartRuntime implements AgentRuntime {
  private readonly listeners = new Set<(event: AgentRuntimeEvent) => void>()

  constructor(private readonly sessionId: string) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async prompt(input: PromptInput): Promise<void> {
    this.emit({
      type: "text_delta",
      sessionId: this.sessionId,
      messageId: input.assistantMessageId,
      partId: "backend-part-without-start",
      delta: "delta survived",
      text: "delta survived",
    })
    this.emit({
      type: "reasoning_ended",
      sessionId: this.sessionId,
      messageId: input.assistantMessageId,
      partId: "reasoning-without-start",
      text: "reasoning survived",
    })
    this.emit({
      type: "tool_call_completed",
      sessionId: this.sessionId,
      messageId: input.assistantMessageId,
      partId: "tool-without-start",
      callId: "call-without-start",
      tool: "read",
      input: { filePath: "/tmp/example" },
      output: "tool output survived",
      title: "read",
    })
    this.emit({
      type: "session_title_changed",
      sessionId: this.sessionId,
      title: "Backend-updated title",
    })
    this.emit({
      type: "message_completed",
      sessionId: this.sessionId,
      messageId: input.assistantMessageId,
      finish: "stop",
    })
    this.emit({ type: "session_idle", sessionId: this.sessionId })
  }

  async abort(): Promise<void> {}

  async respondToPermission(_requestId: string, _response: PermissionResponse): Promise<void> {}

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: AgentRuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

class GatedEncapsulationAdapter implements AgentAdapter {
  readonly id = "encapsulation"
  readonly displayName = "Encapsulation"
  private release: (() => void) | undefined
  private readonly idleGate = new Promise<void>((resolve) => {
    this.release = resolve
  })

  async validateConfig(input: unknown): Promise<AgentAdapterConfig> {
    return input as AgentAdapterConfig
  }

  async createRuntime(context: AgentRuntimeContext): Promise<AgentRuntime> {
    return new GatedEncapsulationRuntime(context.sessionId, this.idleGate)
  }

  releaseIdle(): void {
    this.release?.()
  }
}

class GatedEncapsulationRuntime implements AgentRuntime {
  private readonly listeners = new Set<(event: AgentRuntimeEvent) => void>()

  constructor(
    private readonly sessionId: string,
    private readonly idleGate: Promise<void>,
  ) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async prompt(input: PromptInput): Promise<void> {
    this.emit({
      type: "text_ended",
      sessionId: this.sessionId,
      messageId: input.assistantMessageId,
      partId: "encap-text",
      text: "answer",
    })
    this.emit({
      type: "reasoning_ended",
      sessionId: this.sessionId,
      messageId: input.assistantMessageId,
      partId: "encap-reasoning",
      text: "reasoning",
    })
    this.emit({
      type: "tool_call_completed",
      sessionId: this.sessionId,
      messageId: input.assistantMessageId,
      partId: "encap-tool",
      callId: "call_encap",
      tool: "read",
      input: { filePath: "/tmp/example" },
      output: "tool output",
      title: "read",
    })
    this.emit({
      type: "message_completed",
      sessionId: this.sessionId,
      messageId: input.assistantMessageId,
      finish: "stop",
      usage: { input: 12, output: 5, total: 17, cost: 0.01 },
    })
    await this.idleGate
    this.emit({ type: "session_idle", sessionId: this.sessionId })
  }

  async abort(): Promise<void> {
    this.emit({ type: "session_idle", sessionId: this.sessionId })
  }

  async respondToPermission(_requestId: string, _response: PermissionResponse): Promise<void> {}

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: AgentRuntimeEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
