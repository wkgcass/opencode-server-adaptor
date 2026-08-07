import { existsSync } from "node:fs"

/**
 * Shell execution for the OpenCode "shell mode" (`POST /api/session/:id/shell`).
 *
 * Unlike the agent-driven bash tool, these commands are invoked directly by the
 * user from the Desktop prompt and never go through the model. The adaptor
 * records them as an assistant tool part (tool id `bash`) so they render in the
 * timeline and persist alongside the conversation, matching the native OpenCode
 * `SessionPrompt.shell` behaviour.
 */

export interface ShellRunOptions {
  cwd: string
  env?: Record<string, string>
  /** Called for every decoded stdout/stderr chunk with the accumulated output. */
  onOutput?: (chunk: string, accumulated: string) => void
}

export interface ShellRunResult {
  output: string
  exitCode: number | null
  error?: string
}

export interface ShellInvocation {
  command: string
  /** Initial argv (excluding the command string, which is appended by runShellCommand). */
  args: string[]
}

function shellBaseName(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return path.slice(slash + 1).toLowerCase()
}

/**
 * Resolve the shell to use for direct command execution and the argv prefix.
 *
 * bash/zsh are invoked as login shells and source the user's rc file
 * (`.bashrc`/`.zshrc`) so PATH, aliases and functions match an interactive
 * terminal. The actual command is passed positionally and `eval`'d so quoted
 * pipelines keep working. cmd/PowerShell on Windows use their native `-c` form.
 * The working directory is supplied via the spawn `cwd` option.
 */
export function resolveShell(): ShellInvocation {
  if (process.platform === "win32") {
    return { command: process.env.COMSPEC || "cmd.exe", args: ["/c"] }
  }
  const shell = process.env.SHELL || "/bin/sh"
  const base = shellBaseName(shell)
  if (base === "bash") {
    // $0=opencode, $1=command
    return {
      command: shell,
      args: [
        "-l",
        "-c",
        "shopt -s expand_aliases\n[[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true\neval \"$1\"",
        "opencode",
      ],
    }
  }
  if (base === "zsh") {
    return {
      command: shell,
      args: [
        "-l",
        "-c",
        '[[ -f "${ZDOTDIR:-$HOME}/.zshrc" ]] && source "${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true\neval "$1"',
        "opencode",
      ],
    }
  }
  return { command: shell, args: ["-c"] }
}

function safeCwd(cwd: string): string {
  if (cwd && existsSync(cwd)) return cwd
  return process.cwd()
}

/**
 * Run a shell command, combining stdout and stderr into a single output stream.
 * Resolves with the accumulated output and exit code.
 */
export async function runShellCommand(command: string, options: ShellRunOptions): Promise<ShellRunResult> {
  const invocation = resolveShell()
  const args = [...invocation.args, command]
  const env = { ...process.env, ...(options.env ?? {}), TERM: "dumb" }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn({
      cmd: [invocation.command, ...args],
      cwd: safeCwd(options.cwd),
      stdout: "pipe",
      stderr: "pipe",
      env,
    })
  } catch (error) {
    return {
      output: "",
      exitCode: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const decoder = new TextDecoder()
  const pump = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
    if (!stream) return
    const reader = stream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (!chunk) continue
      output += chunk
      options.onOutput?.(chunk, output)
    }
  }

  let output = ""
  try {
    await Promise.all([
      pump(proc.stdout as ReadableStream<Uint8Array> | null),
      pump(proc.stderr as ReadableStream<Uint8Array> | null),
    ])
    const exitCode = await proc.exited
    return { output, exitCode }
  } catch (error) {
    return {
      output,
      exitCode: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
