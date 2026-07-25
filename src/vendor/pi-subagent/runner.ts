// Vendored from @earendil-works/pi-coding-agent
// Source: packages/coding-agent/examples/extensions/subagent/index.ts (core runner extracted)
// Commit: 7df73a00c6cf85c000bf1ce1594c9284067a92f0
// License: MIT
//
// Local modifications:
// - Extracted only the execution logic (runSingleAgent, output extraction, concurrency, modes).
//   TUI rendering, tool registration, and parameter schemas were NOT copied.
// - getPiInvocation() accepts optional piExecutable parameter for configurable CLI path.
// - writePromptToTempFile() simplified: removed withFileMutationQueue (unnecessary for unique temp dirs).
// - Added runParallel() and runChain() standalone functions extracted from the extension's execute() method.
// - Types exported for adapter use.

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parseCommandLine, resolveCommandExecutable } from "../../agents/pi/command-line.ts"
import type { AgentConfig, AgentScope } from "./agents.ts"

// =============================================================================
// Constants (from upstream index.ts)
// =============================================================================

const MAX_PARALLEL_TASKS = 8
const MAX_CONCURRENCY = 4
const PER_TASK_OUTPUT_CAP = 50 * 1024

// =============================================================================
// Types (from upstream index.ts)
// =============================================================================

export interface UsageStats {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens: number
  turns: number
}

export interface SingleResult {
  agent: string
  agentSource: "user" | "project" | "unknown"
  task: string
  exitCode: number
  messages: any[]
  stderr: string
  usage: UsageStats
  model?: string
  stopReason?: string
  errorMessage?: string
  step?: number
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain"
  agentScope: AgentScope
  projectAgentsDir: string | null
  results: SingleResult[]
}

export interface TaskItem {
  agent: string
  task: string
  cwd?: string
}

export interface ChainItem {
  agent: string
  task: string
  cwd?: string
}

// =============================================================================
// Output extraction & failure detection (from upstream index.ts, verbatim)
// =============================================================================

export function getFinalOutput(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text
      }
    }
  }
  return ""
}

export function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"
}

export function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
  }
  return getFinalOutput(result.messages) || "(no output)"
}

export function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8")
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP)
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1)
  }
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`
}

// =============================================================================
// Concurrency control (from upstream index.ts, verbatim)
// =============================================================================

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return []
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results: TOut[] = new Array(items.length)
  let nextIndex = 0
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++
      if (current >= items.length) return
      results[current] = await fn(items[current]!, current)
    }
  })
  await Promise.all(workers)
  return results
}

// =============================================================================
// Temp file for system prompt (simplified from upstream)
// =============================================================================

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"))
  const safeName = agentName.replace(/[^\w.-]+/g, "_")
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`)
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 })
  return { dir: tmpDir, filePath }
}

// =============================================================================
// Pi invocation (modified from upstream to accept configurable executable)
// =============================================================================

export function getPiInvocation(args: string[], piExecutable?: string): { command: string; args: string[] } {
  // If an explicit executable is provided, use it (split on whitespace to support "bun /path/to/pi")
  if (piExecutable) {
    const parts = parseCommandLine(piExecutable)
    const command = resolveCommandExecutable(parts[0]!)
    return { command, args: [...parts.slice(1), ...args] }
  }

  // Fall back to upstream logic: try to reuse the current runtime
  const currentScript = process.argv[1]
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/")
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }

  const execName = path.basename(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) {
    return { command: process.execPath, args }
  }

  return { command: "pi", args }
}

// =============================================================================
// Update callback type
// =============================================================================

export type OnUpdateCallback = (partial: {
  content: Array<{ type: "text"; text: string }>
  details?: SubagentDetails
  isError?: boolean
}) => void

export interface RunnerOptions {
  terminateGracePeriodMs?: number
  stderrLimitBytes?: number
  env?: Record<string, string>
  beforeSpawn?: () => void
  onInteraction?: (direction: "in" | "out", metadata: Record<string, unknown>, payload: unknown) => void
}

// =============================================================================
// Core runner: runSingleAgent (from upstream index.ts, with minimal adaptation)
// =============================================================================

export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  piExecutable?: string,
  options?: RunnerOptions,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName)

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none"
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
    }
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"]
  if (agent.provider) args.push("--provider", agent.provider)
  if (agent.model) args.push("--model", agent.model)
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","))

  let tmpPromptDir: string | null = null
  let tmpPromptPath: string | null = null

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model,
    step,
  }

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult]),
      })
    }
  }

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt)
      tmpPromptDir = tmp.dir
      tmpPromptPath = tmp.filePath
      args.push("--append-system-prompt", tmpPromptPath)
    }

    args.push(`Task: ${task}`)
    let wasAborted = false

    options?.beforeSpawn?.()
    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args, piExecutable)
      options?.onInteraction?.(
        "out",
        { stream: "argv", mode: "json", agent: agentName },
        { command: invocation.command, args: invocation.args, cwd: cwd ?? defaultCwd },
      )
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        env: { ...process.env, ...options?.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let buffer = ""

      const processLine = (line: string) => {
        if (!line.trim()) return
        let event: any
        try {
          event = JSON.parse(line)
        } catch {
          options?.onInteraction?.("in", { stream: "stdout", mode: "json", agent: agentName, invalid: true }, line)
          return
        }
        options?.onInteraction?.("in", { stream: "stdout", mode: "json", agent: agentName, type: event.type }, event)

        if (event.type === "message_end" && event.message) {
          const msg = event.message
          currentResult.messages.push(msg)

          if (msg.role === "assistant") {
            currentResult.usage.turns++
            const usage = msg.usage
            if (usage) {
              currentResult.usage.input += usage.input || 0
              currentResult.usage.output += usage.output || 0
              currentResult.usage.cacheRead += usage.cacheRead || 0
              currentResult.usage.cacheWrite += usage.cacheWrite || 0
              currentResult.usage.cost += usage.cost?.total || 0
              currentResult.usage.contextTokens = usage.totalTokens || 0
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model
            if (msg.stopReason) currentResult.stopReason = msg.stopReason
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage
          }
          emitUpdate()
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message)
          emitUpdate()
        }
      }

      proc.stdout.on("data", (data) => {
        buffer += data.toString()
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        for (const line of lines) processLine(line)
      })

      proc.stderr.on("data", (data) => {
        const chunk = data.toString()
        options?.onInteraction?.("in", { stream: "stderr", mode: "json", agent: agentName }, chunk)
        const limit = options?.stderrLimitBytes
        if (limit && currentResult.stderr.length + chunk.length > limit) {
          const remaining = limit - currentResult.stderr.length
          if (remaining > 0) currentResult.stderr += chunk.slice(0, remaining)
          if (currentResult.stderr.length <= limit) {
            currentResult.stderr += `\n[stderr truncated at ${limit} bytes]`
          }
        } else {
          currentResult.stderr += chunk
        }
      })

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer)
        resolve(code ?? 0)
      })

      proc.on("error", () => {
        resolve(1)
      })

      if (signal) {
        const gracePeriod = options?.terminateGracePeriodMs ?? 5000
        const killProc = () => {
          wasAborted = true
          proc.kill("SIGTERM")
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL")
          }, gracePeriod)
        }
        if (signal.aborted) killProc()
        else signal.addEventListener("abort", killProc, { once: true })
      }
    })

    currentResult.exitCode = exitCode
    if (wasAborted) throw new Error("Subagent was aborted")
    return currentResult
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath)
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir)
      } catch {
        /* ignore */
      }
  }
}

// =============================================================================
// Parallel mode (extracted from upstream execute())
// =============================================================================

export interface ParallelResult {
  results: SingleResult[]
  summary: string
  isError: boolean
  details: SubagentDetails
}

export async function runParallel(
  defaultCwd: string,
  agents: AgentConfig[],
  tasks: TaskItem[],
  agentScope: AgentScope,
  projectAgentsDir: string | null,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  piExecutable?: string,
  options?: RunnerOptions,
): Promise<ParallelResult> {
  if (tasks.length > MAX_PARALLEL_TASKS) {
    return {
      results: [],
      summary: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
      isError: true,
      details: { mode: "parallel", agentScope, projectAgentsDir, results: [] },
    }
  }

  const makeDetails = (results: SingleResult[]): SubagentDetails => ({
    mode: "parallel",
    agentScope,
    projectAgentsDir,
    results,
  })

  const allResults: SingleResult[] = new Array(tasks.length)

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!
    allResults[i] = {
      agent: t.agent,
      agentSource: "unknown",
      task: t.task,
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    }
  }

  const emitParallelUpdate = () => {
    if (onUpdate) {
      const running = allResults.filter((r) => r.exitCode === -1).length
      const done = allResults.filter((r) => r.exitCode !== -1).length
      onUpdate({
        content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
        details: makeDetails([...allResults]),
      })
    }
  }

  const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
    const result = await runSingleAgent(
      defaultCwd,
      agents,
      t.agent,
      t.task,
      t.cwd,
      undefined,
      signal,
      (partial) => {
        if (partial.details?.results[0]) {
          allResults[index] = partial.details.results[0]
          emitParallelUpdate()
        }
      },
      makeDetails,
      piExecutable,
      options,
    )
    allResults[index] = result
    emitParallelUpdate()
    return result
  })

  const successCount = results.filter((r) => !isFailedResult(r)).length
  const summaries = results.map((r) => {
    const output = truncateParallelOutput(getResultOutput(r))
    const status = isFailedResult(r)
      ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
      : "completed"
    return `### [${r.agent}] ${status}\n\n${output}`
  })

  return {
    results,
    summary: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
    isError: false,
    details: makeDetails(results),
  }
}

// =============================================================================
// Chain mode (extracted from upstream execute())
// =============================================================================

export interface ChainResult {
  results: SingleResult[]
  output: string
  isError: boolean
  details: SubagentDetails
}

export async function runChain(
  defaultCwd: string,
  agents: AgentConfig[],
  chain: ChainItem[],
  agentScope: AgentScope,
  projectAgentsDir: string | null,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  piExecutable?: string,
  options?: RunnerOptions,
): Promise<ChainResult> {
  const makeDetails = (results: SingleResult[]): SubagentDetails => ({
    mode: "chain",
    agentScope,
    projectAgentsDir,
    results,
  })

  const results: SingleResult[] = []
  let previousOutput = ""

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i]!
    const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput)

    const chainUpdate: OnUpdateCallback | undefined = onUpdate
      ? (partial) => {
          const currentResult = partial.details?.results[0]
          if (currentResult) {
            const allResults = [...results, currentResult]
            onUpdate({
              content: partial.content,
              details: makeDetails(allResults),
            })
          }
        }
      : undefined

    const result = await runSingleAgent(
      defaultCwd,
      agents,
      step.agent,
      taskWithContext,
      step.cwd,
      i + 1,
      signal,
      chainUpdate,
      makeDetails,
      piExecutable,
      options,
    )
    results.push(result)

    if (isFailedResult(result)) {
      const errorMsg = getResultOutput(result)
      return {
        results,
        output: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
        isError: true,
        details: makeDetails(results),
      }
    }
    previousOutput = getFinalOutput(result.messages)
  }

  const lastResult = results[results.length - 1]
  return {
    results,
    output: lastResult ? getFinalOutput(lastResult.messages) || "(no output)" : "(no output)",
    isError: false,
    details: makeDetails(results),
  }
}
