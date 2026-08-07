import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveShell, runShellCommand } from "../../src/session/shell-runner.ts"

describe("ShellRunner", () => {
  const cwd = mkdtempSync(join(tmpdir(), "shell-runner-"))

  test("resolveShell returns a usable shell invocation", () => {
    const invocation = resolveShell()
    expect(typeof invocation.command).toBe("string")
    expect(invocation.command.length).toBeGreaterThan(0)
    expect(Array.isArray(invocation.args)).toBe(true)
  })

  test("captures stdout and a zero exit code", async () => {
    const result = await runShellCommand("echo hello-shell", { cwd })
    expect(result.exitCode).toBe(0)
    expect(result.error).toBeUndefined()
    expect(result.output).toContain("hello-shell")
  })

  test("captures a non-zero exit code", async () => {
    const result = await runShellCommand("exit 42", { cwd })
    expect(result.exitCode).toBe(42)
    expect(result.error).toBeUndefined()
  })

  test("combines stdout and stderr into the output stream", async () => {
    const result = await runShellCommand("echo out-line; echo err-line 1>&2", { cwd })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("out-line")
    expect(result.output).toContain("err-line")
  })

  test("streams incremental output via onOutput", async () => {
    const accumulated: string[] = []
    await runShellCommand("echo a; echo b; echo c", {
      cwd,
      onOutput: (_chunk, acc) => accumulated.push(acc),
    })
    expect(accumulated.length).toBeGreaterThan(0)
    expect(accumulated.at(-1)).toContain("a")
    expect(accumulated.at(-1)).toContain("c")
  })

  test("runs shell pipelines and expansions", async () => {
    const result = await runShellCommand("echo $((6*7)) | tr -d '\\n'", { cwd })
    expect(result.exitCode).toBe(0)
    expect(result.output.trim()).toBe("42")
  })
})
