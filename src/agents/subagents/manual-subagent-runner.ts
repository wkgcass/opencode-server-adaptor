import type {
  SubagentProfile,
  SubagentResult,
  SubagentRunCallbacks,
  SubagentRunInput,
  SubagentRunner,
} from "../subagent-adapter.ts"

export interface ManualSubagentBackendInput extends SubagentRunInput {
  profile: SubagentProfile
}

/**
 * Backend-specific process execution used by the generic fallback runner.
 * Implementations own protocol mapping and profile discovery.
 */
export interface ManualSubagentBackend {
  listProfiles(cwd: string): SubagentProfile[]
  run(input: ManualSubagentBackendInput, callbacks?: SubagentRunCallbacks): Promise<SubagentResult>
  respondToPermission?(
    childSessionId: string,
    permissionId: string,
    action: "allow" | "deny",
    reason?: string,
  ): Promise<void>
}

/**
 * Reusable fallback for agents without native child-agent support.
 *
 * Profile registration and selection are backend-neutral. A concrete backend
 * only needs to discover profiles and execute one isolated child process.
 */
export class ManualSubagentRunner implements SubagentRunner {
  readonly mode = "fallback" as const
  readonly respondToPermission:
    | ((childSessionId: string, permissionId: string, action: "allow" | "deny", reason?: string) => Promise<void>)
    | undefined
  private readonly profiles = new Map<string, SubagentProfile>()

  constructor(private readonly backend: ManualSubagentBackend) {
    if (backend.respondToPermission) {
      this.respondToPermission = (childSessionId, permissionId, action, reason) =>
        backend.respondToPermission!(childSessionId, permissionId, action, reason)
    }
  }

  listProfiles(cwd: string): SubagentProfile[] {
    const profiles = new Map<string, SubagentProfile>()
    for (const profile of this.backend.listProfiles(cwd)) profiles.set(profile.name, profile)
    for (const profile of this.profiles.values()) profiles.set(profile.name, profile)
    return Array.from(profiles.values())
  }

  registerProfile(profile: SubagentProfile): void {
    this.profiles.set(profile.name, profile)
  }

  unregisterProfile(name: string): void {
    this.profiles.delete(name)
  }

  async run(input: SubagentRunInput, callbacks?: SubagentRunCallbacks): Promise<SubagentResult> {
    const profiles = this.listProfiles(input.cwd)
    const profile = profiles.find((candidate) => candidate.name === input.agent)
    if (!profile) {
      const available = profiles.map((candidate) => candidate.name).join(", ")
      const message = `Unknown agent: "${input.agent}". Available agents: ${available || "none"}.`
      return {
        agent: input.agent,
        task: input.task,
        status: "failed",
        output: message,
        usage: emptyUsage(),
        error: { message },
      }
    }
    return this.backend.run({ ...input, profile }, callbacks)
  }
}

function emptyUsage(): SubagentResult["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }
}
