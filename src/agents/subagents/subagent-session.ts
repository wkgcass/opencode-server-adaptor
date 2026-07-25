export function subagentSessionTitle(description: string, agent: string): string {
  const displayAgent = agent ? `${agent[0]!.toUpperCase()}${agent.slice(1)}` : "General"
  return `${description || "Delegated task"} (@${displayAgent} subagent)`
}
