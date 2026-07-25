import { discoverAgents, type AgentConfig, type AgentScope } from "../../vendor/pi-subagent/agents.ts"
import {
  runSingleAgent,
  isFailedResult,
  getResultOutput,
  type SingleResult,
  type OnUpdateCallback,
  type SubagentDetails,
  type RunnerOptions,
} from "../../vendor/pi-subagent/runner.ts"

export interface PiSubagentRunInput {
  agent: string
  task: string
  cwd: string
  agentScope?: AgentScope
  model?: string
  provider?: string
  tools?: string[]
  systemPrompt?: string
  signal?: AbortSignal
  piExecutable?: string
  terminateGracePeriodMs?: number
  stderrLimitBytes?: number
}

export interface PiSubagentUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens: number
  turns: number
}

export interface PiSubagentResult {
  agent: string
  task: string
  status: "completed" | "failed" | "aborted"
  exitCode: number
  stopReason?: string
  output: string
  messages: any[]
  stderr: string
  usage: PiSubagentUsage
  model?: string
  error?: { message: string }
}

export type PiSubagentUpdate =
  | { type: "message"; result: SingleResult }
  | { type: "status"; status: "starting" | "running" | "aborting" }
  | { type: "stderr"; text: string }

export interface PiSubagentRunnerCallbacks {
  onUpdate?: (update: PiSubagentUpdate) => void | Promise<void>
}

export interface CustomAgentEntry {
  name: string
  description: string
  cliPath?: string
  provider?: string
  model?: string
  tools?: string[]
  systemPrompt?: string
}

function toResult(sr: SingleResult): PiSubagentResult {
  const failed = isFailedResult(sr)
  const output = getResultOutput(sr)
  return {
    agent: sr.agent,
    task: sr.task,
    status: failed ? (sr.stopReason === "aborted" ? "aborted" : "failed") : "completed",
    exitCode: sr.exitCode,
    stopReason: sr.stopReason,
    output,
    messages: sr.messages,
    stderr: sr.stderr,
    usage: sr.usage,
    model: sr.model,
    error: failed ? { message: output } : undefined,
  }
}

export class PiSubagentRunner {
  private readonly customAgents = new Map<string, CustomAgentEntry>()
  private readonly agentDir: string | undefined
  private readonly beforeSpawn: (() => void) | undefined
  private readonly logger:
    | {
        interaction?: (
          channel: "opencode" | "pi",
          direction: "in" | "out",
          metadata: Record<string, unknown>,
          payload: unknown,
        ) => void
      }
    | undefined

  constructor(options?: {
    agentDir?: string
    beforeSpawn?: () => void
    logger?: {
      interaction?: (
        channel: "opencode" | "pi",
        direction: "in" | "out",
        metadata: Record<string, unknown>,
        payload: unknown,
      ) => void
    }
  }) {
    this.agentDir = options?.agentDir
    this.beforeSpawn = options?.beforeSpawn
    this.logger = options?.logger
  }

  registerCustomAgent(entry: CustomAgentEntry): void {
    this.customAgents.set(entry.name, entry)
  }

  unregisterCustomAgent(name: string): void {
    this.customAgents.delete(name)
  }

  listCustomAgents(): CustomAgentEntry[] {
    return Array.from(this.customAgents.values())
  }

  discoverAgents(cwd: string, scope: AgentScope = "both"): { agents: AgentConfig[]; projectAgentsDir: string | null } {
    return discoverAgents(cwd, scope)
  }

  resolveAgent(input: PiSubagentRunInput, cwd: string): AgentConfig | null {
    const custom = this.customAgents.get(input.agent)
    if (custom) {
      return {
        name: custom.name,
        description: custom.description,
        tools: custom.tools,
        model: input.model ?? custom.model,
        provider: input.provider ?? custom.provider,
        systemPrompt: custom.systemPrompt ?? "",
        source: "user",
        filePath: "",
      }
    }

    const discovery = this.discoverAgents(cwd, "both")
    const agent = discovery.agents.find((a) => a.name === input.agent) ?? null
    if (agent && input.provider) {
      return { ...agent, provider: input.provider }
    }
    if (agent && input.model) {
      return { ...agent, model: input.model }
    }
    return agent
  }

  private buildAgents(agentName: string, cwd: string, model?: string, provider?: string): AgentConfig[] {
    const custom = this.customAgents.get(agentName)
    if (custom) {
      return [
        {
          name: custom.name,
          description: custom.description,
          tools: custom.tools,
          model: model ?? custom.model,
          provider: provider ?? custom.provider,
          systemPrompt: custom.systemPrompt ?? "",
          source: "user",
          filePath: "",
        },
      ]
    }
    const discovery = this.discoverAgents(cwd, "both")
    return discovery.agents
  }

  private makeOptions(input: {
    terminateGracePeriodMs?: number
    stderrLimitBytes?: number
  }): RunnerOptions | undefined {
    if (
      input.terminateGracePeriodMs === undefined &&
      input.stderrLimitBytes === undefined &&
      !this.agentDir &&
      !this.beforeSpawn &&
      !this.logger
    )
      return undefined
    return {
      terminateGracePeriodMs: input.terminateGracePeriodMs,
      stderrLimitBytes: input.stderrLimitBytes,
      env: this.agentDir ? { PI_CODING_AGENT_DIR: this.agentDir } : undefined,
      beforeSpawn: this.beforeSpawn,
      onInteraction: (direction, metadata, payload) => {
        this.logger?.interaction?.("pi", direction, { subprocess: "subagent", ...metadata }, payload)
      },
    }
  }

  async run(input: PiSubagentRunInput, callbacks?: PiSubagentRunnerCallbacks): Promise<PiSubagentResult> {
    const { agent: agentName, task, cwd } = input

    callbacks?.onUpdate?.({ type: "status", status: "starting" })

    const agents = this.buildAgents(agentName, cwd, input.model, input.provider)

    const makeDetails = (results: SingleResult[]): SubagentDetails => ({
      mode: "single",
      agentScope: input.agentScope ?? "both",
      projectAgentsDir: null,
      results,
    })

    const onUpdate: OnUpdateCallback | undefined = callbacks?.onUpdate
      ? (partial) => {
          const result = partial.details?.results[0]
          if (result) {
            callbacks.onUpdate!({ type: "message", result })
          }
        }
      : undefined

    callbacks?.onUpdate?.({ type: "status", status: "running" })

    let result: SingleResult
    try {
      result = await runSingleAgent(
        cwd,
        agents,
        agentName,
        task,
        input.cwd,
        undefined,
        input.signal,
        onUpdate,
        makeDetails,
        this.customAgents.get(agentName)?.cliPath ?? input.piExecutable,
        this.makeOptions(input),
      )
    } catch (err) {
      const isAborted = err instanceof Error && err.message === "Subagent was aborted"
      return {
        agent: agentName,
        task,
        status: isAborted ? "aborted" : "failed",
        exitCode: 1,
        output: "",
        messages: [],
        stderr: err instanceof Error ? err.message : String(err),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        error: { message: err instanceof Error ? err.message : String(err) },
      }
    }

    return toResult(result)
  }
}
