import { describe, expect, test } from "bun:test"
import { parseCommandLine, resolveCommandExecutable } from "../../src/agents/pi/command-line.ts"
import { getDefaultPiCliPath } from "../../src/config/index.ts"

describe("Pi executable command parser", () => {
  test("parses an executable and arguments", () => {
    expect(parseCommandLine("bun /workspace/pi/cli.js")).toEqual(["bun", "/workspace/pi/cli.js"])
  })

  test("preserves quoted paths and escaped whitespace", () => {
    expect(parseCommandLine(`"/opt/Pi Agent/bun" '/workspace/pi agent/cli.js' --flag\\ value`)).toEqual([
      "/opt/Pi Agent/bun",
      "/workspace/pi agent/cli.js",
      "--flag value",
    ])
  })

  test("supports an empty quoted argument", () => {
    expect(parseCommandLine(`pi --provider ""`)).toEqual(["pi", "--provider", ""])
  })

  test("preserves Windows path separators and resolves an omitted .exe suffix", () => {
    const executable = String.raw`C:\Users\example\.bun\bin\bun`
    expect(parseCommandLine(`${executable} script.ts`)).toEqual([executable, "script.ts"])
    expect(resolveCommandExecutable(process.execPath.replace(/\.exe$/i, ""))).toBe(process.execPath)
  })

  test("rejects empty commands and unterminated quotes", () => {
    expect(() => parseCommandLine("   ")).toThrow("empty")
    expect(() => parseCommandLine(`pi "unfinished`)).toThrow("Unterminated quote")
  })

  test("the auto-detected Pi command is directly executable without a shell", () => {
    const command = parseCommandLine(getDefaultPiCliPath())
    expect(command.length).toBeGreaterThan(0)
    if (command.length > 1) {
      expect(command[0]).toEndWith("/bun")
      expect(command[1]).toEndWith(".js")
    }
  })
})
