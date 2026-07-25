import { createPartId } from "../../id/index.ts"
import type { SubagentProfile, SubagentResult, SubagentRunCallbacks } from "../subagent-adapter.ts"
import type { ManualSubagentBackend, ManualSubagentBackendInput } from "../subagents/manual-subagent-runner.ts"
import { PI_SUBAGENT_PROFILES } from "./pi-runtime-assets.ts"
import { PiToOpenCodeEventMapper } from "./pi-event-mapper.ts"
import { PiSubagentRunner, type CustomAgentEntry, type PiSubagentResult } from "./subagent-runner.ts"

export interface PiManualSubagentBackendOptions {
  piExecutable: string
  agentScope: "user" | "project" | "both"
  terminateGracePeriodMs: number
  stderrLimitBytes: number
  runner?: PiSubagentRunner
  logger?: {
    warn: (message: string, fields?: Record<string, unknown>) => void
  }
}

/** Pi process implementation for the generic manual-subagent fallback. */
export class PiManualSubagentBackend implements ManualSubagentBackend {
  private readonly runner: PiSubagentRunner

  constructor(private readonly options: PiManualSubagentBackendOptions) {
    this.runner = options.runner ?? new PiSubagentRunner()
  }

  listProfiles(cwd: string): SubagentProfile[] {
    const profiles = new Map<string, SubagentProfile>()
    for (const profile of Object.values(PI_SUBAGENT_PROFILES)) {
      profiles.set(profile.name, {
        ...profile,
        tools: "tools" in profile ? [...profile.tools] : undefined,
      })
    }
    for (const profile of this.runner.discoverAgents(cwd, this.options.agentScope).agents) {
      profiles.set(profile.name, {
        name: profile.name,
        description: profile.description,
        model: profile.model,
        provider: profile.provider,
        tools: profile.tools,
        systemPrompt: profile.systemPrompt,
      })
    }
    return Array.from(profiles.values())
  }

  async run(input: ManualSubagentBackendInput, callbacks?: SubagentRunCallbacks): Promise<SubagentResult> {
    this.runner.registerCustomAgent(toPiProfile(input.profile))

    const mapper = new PiToOpenCodeEventMapper({
      sessionId: input.childSessionId,
      assistantMessageId: input.childAssistantMessageId,
      partIdMap: new Map(),
      generatePartId: () => createPartId(),
      onUnmapped: (event, reason) => {
        this.options.logger?.warn("Pi event produced no OpenCode event", {
          sessionId: input.childSessionId,
          piEvent: event.type,
          stage: "subagent_mapping",
          reason,
        })
      },
    })
    let processedMessages = 0
    let lastOutput = ""

    const publishSnapshot = (snapshot: { messages: unknown[] }): void => {
      for (let index = processedMessages; index < snapshot.messages.length; index++) {
        const message = snapshot.messages[index]
        if (!message) continue
        let mapped
        try {
          mapped = mapper.map({ type: "message_end", message } as never)
        } catch (error) {
          this.options.logger?.warn("Pi event produced no OpenCode event", {
            sessionId: input.childSessionId,
            piEvent: "message_end",
            stage: "subagent_mapping_error",
            reason: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
        for (const event of mapped) {
          callbacks?.onUpdate?.({ type: "event", event })
        }
      }
      processedMessages = snapshot.messages.length

      const output = finalText(snapshot.messages)
      if (output !== lastOutput) {
        const delta = output.startsWith(lastOutput) ? output.slice(lastOutput.length) : output
        lastOutput = output
        if (delta) callbacks?.onUpdate?.({ type: "output_delta", delta })
      }
    }

    callbacks?.onUpdate?.({ type: "status", status: "starting" })
    const result: PiSubagentResult = await this.runner.run(
      {
        agent: input.agent,
        task: input.task,
        cwd: input.cwd,
        signal: input.signal,
        piExecutable: input.profile.command ?? this.options.piExecutable,
        model: input.model?.modelID ?? input.profile.model,
        provider: input.model?.providerID ?? input.profile.provider,
        agentScope: this.options.agentScope,
        terminateGracePeriodMs: this.options.terminateGracePeriodMs,
        stderrLimitBytes: this.options.stderrLimitBytes,
      },
      {
        onUpdate: (update) => {
          if (update.type === "message") publishSnapshot(update.result)
          else if (update.type === "status") callbacks?.onUpdate?.(update)
          else callbacks?.onUpdate?.({ type: "stderr", text: update.text })
        },
      },
    )

    publishSnapshot(result)
    return {
      agent: result.agent,
      task: result.task,
      status: result.status,
      output: result.output,
      usage: result.usage,
      error: result.error,
    }
  }
}

function toPiProfile(profile: SubagentProfile): CustomAgentEntry {
  return {
    name: profile.name,
    description: profile.description,
    cliPath: profile.command,
    provider: profile.provider,
    model: profile.model,
    tools: profile.tools,
    systemPrompt: profile.systemPrompt,
  }
}

function finalText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue
    return message.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
  }
  return ""
}
