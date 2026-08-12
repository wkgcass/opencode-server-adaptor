import type { AgentModel, AgentRuntimeEvent } from "./agent-adapter.ts"

export interface SubagentProfile {
  name: string
  description: string
  command?: string
  model?: string
  provider?: string
  tools?: string[]
  systemPrompt?: string
}

export interface SubagentUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens: number
  turns: number
}

export interface SubagentRunInput {
  parentSessionId: string
  childSessionId: string
  childAssistantMessageId: string
  agent: string
  task: string
  cwd: string
  model?: AgentModel
  signal?: AbortSignal
}

export interface SubagentResult {
  agent: string
  task: string
  status: "completed" | "failed" | "aborted"
  output: string
  usage: SubagentUsage
  error?: { message: string }
}

export type SubagentUpdate =
  | { type: "status"; status: "starting" | "running" | "aborting" }
  | { type: "event"; event: AgentRuntimeEvent }
  | { type: "output_delta"; delta: string }
  | { type: "stderr"; text: string }

export interface SubagentRunCallbacks {
  onUpdate?: (update: SubagentUpdate) => void | Promise<void>
}

/**
 * Executes delegated work for an AgentAdapter.
 *
 * A backend with native child-agent support can implement this interface
 * directly. Backends without it can reference a reusable fallback
 * implementation.
 */
export interface SubagentRunner {
  readonly mode: "native" | "fallback"
  listProfiles(cwd: string): SubagentProfile[]
  run(input: SubagentRunInput, callbacks?: SubagentRunCallbacks): Promise<SubagentResult>
  registerProfile?(profile: SubagentProfile): void
  unregisterProfile?(name: string): void
}
