import type {
  AgentAdapter,
  AgentAdapterConfig,
  AgentModel,
  AgentRuntime,
  AgentRuntimeContext,
} from "../agent-adapter.ts"
import { PiRpcRuntime } from "./pi-rpc-runtime.ts"
import type { AppConfig } from "../../config/index.ts"
import type { PiModelConfigStore } from "./pi-model-config.ts"
import type { SubagentRunner } from "../subagent-adapter.ts"
import type { PiTitleGenerator } from "./pi-title-generator.ts"
import type { PiConversationStore } from "./pi-conversation-store.ts"

export class PiAgentAdapter implements AgentAdapter {
  readonly id: string
  readonly displayName: string
  readonly mode: "primary" | "subagent" | "all"
  readonly removable: boolean
  readonly subagents: SubagentRunner | undefined

  private readonly config: AppConfig
  private readonly cliPath: string | undefined
  private readonly provider: string | undefined
  private readonly model: string | undefined
  private readonly systemPrompt: string | undefined
  private readonly planMode: boolean
  private readonly modelConfig: PiModelConfigStore | undefined
  private readonly titleGenerator: PiTitleGenerator | undefined
  private readonly conversationStore: PiConversationStore | undefined

  constructor(
    config: AppConfig,
    options?: {
      id?: string
      displayName?: string
      cliPath?: string
      provider?: string
      model?: string
      systemPrompt?: string
      planMode?: boolean
      mode?: "primary" | "subagent" | "all"
      modelConfig?: PiModelConfigStore
      subagents?: SubagentRunner
      titleGenerator?: PiTitleGenerator
      conversationStore?: PiConversationStore
      removable?: boolean
    },
  ) {
    this.config = config
    this.id = options?.id ?? "pi"
    this.displayName = options?.displayName ?? "Pi Agent"
    this.mode = options?.mode ?? (options?.id ? "subagent" : "primary")
    this.removable = options?.removable ?? options?.id !== undefined
    this.cliPath = options?.cliPath
    this.provider = options?.provider
    this.model = options?.model
    this.systemPrompt = options?.systemPrompt
    this.planMode = options?.planMode ?? false
    this.modelConfig = options?.modelConfig
    this.subagents = options?.subagents
    this.titleGenerator = options?.titleGenerator
    this.conversationStore = options?.conversationStore
  }

  async validateConfig(input: unknown): Promise<AgentAdapterConfig> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Pi runtime config must be an object")
    }
    const config = input as AgentAdapterConfig
    if (typeof config.piCliPath !== "string" || !config.piCliPath.trim()) {
      throw new Error("Pi runtime config requires a non-empty piCliPath")
    }
    for (const key of ["piProvider", "piModel"] as const) {
      if (config[key] !== undefined && typeof config[key] !== "string") {
        throw new Error(`Pi runtime config '${key}' must be a string`)
      }
    }
    return config
  }

  getRuntimeConfig(model: AgentModel | undefined): AgentAdapterConfig {
    const useConfiguredDefault = !model || model.providerID === this.id || model.providerID === "pi"
    return {
      piCliPath: this.cliPath ?? this.config.piCliPath,
      piProvider: this.provider ?? (useConfiguredDefault ? this.config.piProvider : model.providerID),
      piModel:
        this.model ??
        (useConfiguredDefault
          ? model?.modelID && model.modelID !== "default"
            ? model.modelID
            : this.config.piModel
          : model.modelID),
    }
  }

  getRuntimeRevision(_model: AgentModel | undefined): number | undefined {
    return this.modelConfig?.revision
  }

  async generateTitle(directory: string, prompt: string, model: AgentModel | undefined): Promise<string | null> {
    if (!this.titleGenerator) return null
    const runtime = this.getRuntimeConfig(model)
    return (
      (await this.titleGenerator.generate(directory, prompt, {
        provider: String(runtime.piProvider ?? ""),
        model: String(runtime.piModel ?? ""),
      })) ?? null
    )
  }

  async close(): Promise<void> {
    await this.titleGenerator?.closeAll()
  }

  async createRuntime(context: AgentRuntimeContext): Promise<AgentRuntime> {
    const piCliPath = this.cliPath ?? (context.config as { piCliPath?: string })?.piCliPath ?? this.config.piCliPath
    const planExtension = this.planMode ? this.modelConfig?.planExtensionPath : undefined
    const systemPrompt = [
      this.systemPrompt,
      this.planMode
        ? "You are in PLAN mode. Inspect the codebase and return a concrete numbered implementation plan. Do not edit files or run commands that mutate the workspace."
        : undefined,
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n\n")

    return new PiRpcRuntime(context, {
      cliPath: piCliPath,
      sessionDir: this.config.piSessionDir,
      agentDir: this.config.piAgentDir || undefined,
      beforeStart: this.modelConfig ? () => this.modelConfig!.sync() : undefined,
      rpcTimeoutMs: this.config.agentRpcTimeoutMs,
      startTimeoutMs: this.config.agentStartTimeoutMs,
      provider: this.provider ?? (context.config as { piProvider?: string })?.piProvider,
      model: this.model ?? (context.config as { piModel?: string })?.piModel,
      systemPrompt,
      extensionPaths: [
        ...(this.modelConfig?.taskExtensionPath ? [this.modelConfig.taskExtensionPath] : []),
        ...(planExtension ? [planExtension] : []),
      ],
      planMode: Boolean(planExtension),
      planModeFallback: this.planMode && !planExtension,
      conversationStore: this.conversationStore,
    })
  }
}
