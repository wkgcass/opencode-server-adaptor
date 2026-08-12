import type { SubagentRunner } from "./subagent-adapter.ts"
import type { SkillCatalogSnapshot } from "../skill/skill-service.ts"

export type AgentModel = { providerID: string; modelID: string }

export interface AgentAdapterConfig {
  [key: string]: unknown
}

export interface PromptInput {
  sessionId: string
  text: string
  messageId: string
  assistantMessageId: string
}

export interface AgentCompactionResult {
  summary: string
  firstKeptEntryId?: string
  tokensBefore?: number
  estimatedTokensAfter?: number
  usage?: {
    cost?: number
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
  details?: Record<string, unknown>
}

export interface AgentForkResult {
  /**
   * Opaque backend session identity after the fork. The server persists no
   * backend-specific meaning here; adapters may use it for diagnostics and
   * restart recovery.
   */
  backendSessionId: string
}

export type AgentRuntimeEvent =
  | { type: "text_delta"; sessionId: string; messageId: string; partId: string; delta: string; text: string }
  | { type: "text_started"; sessionId: string; messageId: string; partId: string }
  | { type: "text_snapshot"; sessionId: string; messageId: string; partId: string; text: string }
  | { type: "text_ended"; sessionId: string; messageId: string; partId: string; text: string }
  | { type: "reasoning_delta"; sessionId: string; messageId: string; partId: string; delta: string; text: string }
  | { type: "reasoning_started"; sessionId: string; messageId: string; partId: string }
  | { type: "reasoning_snapshot"; sessionId: string; messageId: string; partId: string; text: string }
  | { type: "reasoning_ended"; sessionId: string; messageId: string; partId: string; text: string }
  | {
      type: "tool_call_started"
      sessionId: string
      messageId: string
      partId: string
      callId: string
      tool: string
      input: Record<string, unknown>
    }
  | { type: "tool_call_delta"; sessionId: string; messageId: string; partId: string; callId: string; delta: string }
  | {
      type: "tool_call_running"
      sessionId: string
      messageId: string
      partId: string
      callId: string
      tool: string
      input: Record<string, unknown>
    }
  | {
      type: "tool_call_progress"
      sessionId: string
      messageId: string
      partId: string
      callId: string
      output: string
      metadata?: Record<string, unknown>
    }
  | {
      type: "tool_call_completed"
      sessionId: string
      messageId: string
      partId: string
      callId: string
      tool: string
      input: Record<string, unknown>
      output: string
      title: string
      metadata?: Record<string, unknown>
    }
  | {
      type: "tool_call_error"
      sessionId: string
      messageId: string
      partId: string
      callId: string
      tool: string
      input: Record<string, unknown>
      error: string
      metadata?: Record<string, unknown>
    }
  | {
      type: "subtask_event"
      sessionId: string
      messageId: string
      partId: string
      callId: string
      input: Record<string, unknown>
      event: AgentRuntimeEvent
    }
  | { type: "session_idle"; sessionId: string }
  | { type: "session_busy"; sessionId: string }
  | { type: "session_title_changed"; sessionId: string; title: string }
  | {
      type: "session_retry"
      sessionId: string
      attempt: number
      message: string
      next: number
    }
  | {
      type: "session_error"
      sessionId: string
      messageId?: string
      error: { type: string; message: string }
      usage?: {
        cost?: number
        input?: number
        output?: number
        reasoning?: number
        cacheRead?: number
        cacheWrite?: number
        total?: number
      }
      /** Non-fatal backend diagnostics are published without terminating the current message or Runtime. */
      fatal?: boolean
    }
  | {
      /**
       * The Runtime itself can no longer process commands. Unlike a backend
       * extension error, this always invalidates the pooled Runtime.
       */
      type: "runtime_fault"
      sessionId: string
      messageId?: string
      error: { type: string; message: string }
    }
  | { type: "session_started"; sessionId: string }
  | { type: "session_stopped"; sessionId: string }
  | {
      type: "compaction_started"
      sessionId: string
      reason: "manual" | "auto"
      backendReason?: string
    }
  | {
      type: "compaction_completed"
      sessionId: string
      reason: "manual" | "auto"
      backendReason?: string
      result: AgentCompactionResult
      willRetry?: boolean
    }
  | {
      type: "compaction_failed"
      sessionId: string
      reason: "manual" | "auto"
      backendReason?: string
      error: string
      aborted?: boolean
      willRetry?: boolean
    }
  | {
      type: "message_completed"
      sessionId: string
      messageId: string
      finish?: string
      usage?: {
        cost?: number
        input?: number
        output?: number
        reasoning?: number
        cacheRead?: number
        cacheWrite?: number
        total?: number
      }
    }

export interface AgentRuntimeContext {
  sessionId: string
  directory: string
  logger: {
    debug: (msg: string, fields?: Record<string, unknown>) => void
    info: (msg: string, fields?: Record<string, unknown>) => void
    warn: (msg: string, fields?: Record<string, unknown>) => void
    error: (msg: string, fields?: Record<string, unknown>) => void
    interaction?: (
      channel: string,
      direction: "in" | "out",
      metadata: Record<string, unknown>,
      payload: unknown,
    ) => void
    isVerbose?: () => boolean
  }
  config: Record<string, unknown>
  skills: SkillCatalogSnapshot
}

export interface AgentRuntimeRevisionInput {
  model: AgentModel | undefined
  directory: string
  skills: SkillCatalogSnapshot
}

export interface AgentRuntime {
  start(): Promise<void>
  stop(): Promise<void>
  prompt(input: PromptInput): Promise<void>
  compact?(input?: { customInstructions?: string }): Promise<AgentCompactionResult>
  /**
   * Fork the backend conversation immediately before the referenced OpenCode
   * user message. This is conversation-only: workspace files are untouched.
   */
  fork?(input: { messageId: string }): Promise<AgentForkResult>
  /**
   * Create an independent backend session from this conversation. When a
   * message is supplied, the new backend conversation ends immediately before
   * that OpenCode user message; otherwise the active branch is cloned in full.
   */
  createSessionFork?(input: { targetSessionId: string; messageId?: string }): Promise<AgentForkResult>
  /** Restore the backend conversation that was active before the latest fork. */
  restoreFork?(): Promise<AgentForkResult>
  /** Make the current fork permanent after the client sends a new prompt. */
  commitFork?(): Promise<void>
  abort(): Promise<void>
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void
}

export interface AgentAdapter {
  readonly id: string
  readonly displayName: string
  readonly mode?: "primary" | "subagent" | "all"
  readonly subagents?: SubagentRunner
  readonly removable?: boolean
  validateConfig(input: unknown): Promise<AgentAdapterConfig>
  getRuntimeConfig?(model: AgentModel | undefined): AgentAdapterConfig
  getRuntimeRevision?(input: AgentRuntimeRevisionInput): string | number | undefined
  generateTitle?(directory: string, prompt: string, model: AgentModel | undefined): Promise<string | null>
  close?(): Promise<void>
  createRuntime(context: AgentRuntimeContext): Promise<AgentRuntime>
}
