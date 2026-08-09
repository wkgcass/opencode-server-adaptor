import type { CommandV2Info, ModelRef } from "@opencode-ai/sdk/v2"
import type { SkillService } from "./skill-service.ts"

export interface ResolvedCommand {
  name: string
  source: "command" | "skill"
  description?: string
  template: string
  agent?: string
  model?: ModelRef
  subtask?: boolean
  revision: string
}

export class CommandNotFoundError extends Error {
  readonly name = "CommandNotFoundError"

  constructor(
    readonly commandName: string,
    readonly available: readonly string[],
  ) {
    super(`Command "${commandName}" not found. Available commands: ${available.join(", ") || "none"}`)
  }
}

const RESERVED_COMMAND_NAMES = new Set(["compact", "init"])

const BUILTIN_COMMANDS: readonly CommandV2Info[] = []

function skillTemplate(skill: { content: string; baseDirectory: string }): string {
  return [
    skill.content,
    `Skill base directory: ${skill.baseDirectory}`,
    "Resolve relative paths mentioned by this Skill against that directory.",
  ].join("\n\n")
}

function parseArguments(value: string): string[] {
  const result: string[] = []
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s]+)/g
  for (const match of value.matchAll(pattern)) {
    const token = match[1] ?? match[2] ?? match[3] ?? ""
    result.push(token.replace(/\\([\\"'])/g, "$1"))
  }
  return result
}

export function expandCommandTemplate(template: string, argumentsText: string): string {
  const args = parseArguments(argumentsText)
  const placeholders = [...template.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
  const last = placeholders.length ? Math.max(...placeholders) : 0
  let expanded = template.replace(/\$(\d+)/g, (_match, rawIndex: string) => {
    const position = Number(rawIndex)
    const index = position - 1
    if (index < 0 || index >= args.length) return ""
    return position === last ? args.slice(index).join(" ") : (args[index] ?? "")
  })
  const usesArguments = expanded.includes("$ARGUMENTS")
  expanded = expanded.replaceAll("$ARGUMENTS", argumentsText)
  if (placeholders.length === 0 && !usesArguments && argumentsText.trim()) {
    expanded += `\n\n${argumentsText.trim()}`
  }
  return expanded.trim()
}

export class CommandService {
  constructor(private readonly skills: SkillService) {}

  async list(directory: string): Promise<readonly CommandV2Info[]> {
    const commands = new Map(BUILTIN_COMMANDS.map((command) => [command.name, command]))
    for (const skill of (await this.skills.snapshot(directory)).skills) {
      if (RESERVED_COMMAND_NAMES.has(skill.name) || commands.has(skill.name)) continue
      commands.set(skill.name, {
        name: skill.name,
        description: skill.description,
        template: skillTemplate(skill),
        subtask: false,
      })
    }
    return [...commands.values()]
  }

  async require(directory: string, name: string, argumentsText: string): Promise<ResolvedCommand> {
    const builtin = BUILTIN_COMMANDS.find((command) => command.name === name)
    if (builtin) {
      return {
        ...builtin,
        source: "command",
        template: expandCommandTemplate(builtin.template, argumentsText),
        revision: `builtin:${name}`,
      }
    }

    if (RESERVED_COMMAND_NAMES.has(name)) {
      throw new CommandNotFoundError(
        name,
        BUILTIN_COMMANDS.map((command) => command.name),
      )
    }

    const snapshot = await this.skills.snapshot(directory)
    const skill = snapshot.skills.find((candidate) => candidate.name === name)
    if (!skill) {
      throw new CommandNotFoundError(
        name,
        [
          ...BUILTIN_COMMANDS.map((command) => command.name),
          ...snapshot.skills.map((candidate) => candidate.name),
        ].sort(),
      )
    }
    return {
      name: skill.name,
      source: "skill",
      description: skill.description,
      template: expandCommandTemplate(skillTemplate(skill), argumentsText),
      subtask: false,
      revision: snapshot.revision,
    }
  }
}
