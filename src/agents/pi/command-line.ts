import { existsSync } from "node:fs"

/**
 * Parse a configured executable command without involving a shell.
 * Supports whitespace, single/double quotes and backslash escaping.
 */
export function parseCommandLine(input: string): string[] {
  const result: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let escaping = false
  let tokenStarted = false

  const trimmed = input.trim()
  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index]!
    if (escaping) {
      current += character
      tokenStarted = true
      escaping = false
      continue
    }
    if (character === "\\") {
      const next = trimmed[index + 1]
      const escapesNext =
        next !== undefined &&
        (next === "\\" || next === quote || (!quote && (next === "'" || next === '"' || /\s/.test(next))))
      if (escapesNext) {
        tokenStarted = true
        escaping = true
      } else {
        current += "\\"
        tokenStarted = true
      }
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === "'" || character === '"') {
      tokenStarted = true
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        result.push(current)
        current = ""
        tokenStarted = false
      }
      continue
    }
    current += character
    tokenStarted = true
  }

  if (escaping) current += "\\"
  if (quote) throw new Error("Unterminated quote in Pi executable command")
  if (tokenStarted) result.push(current)
  if (result.length === 0) throw new Error("Pi executable command is empty")
  return result
}

/** Avoid Windows' slow executable probing when a configured path omits `.exe`. */
export function resolveCommandExecutable(command: string): string {
  if (process.platform === "win32" && !existsSync(command) && existsSync(`${command}.exe`)) {
    return `${command}.exe`
  }
  return command
}
