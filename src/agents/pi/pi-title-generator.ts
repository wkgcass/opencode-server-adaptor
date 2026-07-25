import type { AppConfig } from "../../config/index.ts"
import type { Logger } from "../../logging/index.ts"
import { PiRpcTransport } from "./pi-rpc-transport.ts"
import type { PiRpcMessage } from "./types.ts"

const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_BASE_DELAY_MS = 500

const TITLE_SYSTEM_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

Generate a brief title that would help the user find this conversation later.

Rules:
- Use the same language as the user message.
- Output one natural, grammatically correct line of at most 50 characters.
- Focus on the main topic or task.
- Preserve technical terms, numbers, filenames, and HTTP status codes.
- Never mention tool names, title generation, or summarization.
- Never answer the user's request or explain the title.
- Always produce a meaningful title, even for a short greeting.

Examples:
"debug 500 errors in production" → Debugging production 500 errors
"refactor user service" → Refactoring user service
"why is app.js failing" → app.js failure investigation
"@src/auth.ts can you add refresh token support" → Auth refresh token support`

function textFromAssistantMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined
  const value = message as { role?: string; content?: Array<{ type?: string; text?: string }> }
  if (value.role !== "assistant" || !Array.isArray(value.content)) return undefined
  const text = value.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim()
  return text || undefined
}

function assistantMessageError(message: unknown): Error | undefined {
  if (!message || typeof message !== "object") return undefined
  const value = message as { role?: string; stopReason?: string; errorMessage?: unknown }
  if (value.role !== "assistant" || value.stopReason !== "error") return undefined
  return new Error(
    typeof value.errorMessage === "string" && value.errorMessage
      ? value.errorMessage
      : "Pi title generation returned an assistant error",
  )
}

export function cleanGeneratedTitle(value: string): string | undefined {
  const withoutThinking = value.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
  const line = withoutThinking
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean)
  if (!line) return undefined
  const unquoted = line.replace(/^["'`]+|["'`]+$/g, "").trim()
  if (!unquoted) return undefined
  return [...unquoted].slice(0, 100).join("")
}

export interface PiTitleGeneratorOptions {
  /** Number of fresh-process retries after the initial attempt. */
  maxRetries?: number
  /** Delay before the first retry. Later retries use exponential backoff. */
  retryBaseDelayMs?: number
}

export class PiTitleGenerator {
  private readonly active = new Set<PiRpcTransport>()
  private readonly maxRetries: number
  private readonly retryBaseDelayMs: number
  private closed = false

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    options: PiTitleGeneratorOptions = {},
  ) {
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES))
    this.retryBaseDelayMs = Math.max(0, Math.floor(options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS))
  }

  async generate(
    directory: string,
    userMessage: string,
    model: { provider: string; model: string },
  ): Promise<string | undefined> {
    const maxAttempts = this.maxRetries + 1
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.closed) throw new Error("Pi title generator is closed")
      try {
        const title = await this.generateOnce(directory, userMessage, model)
        if (title) return title
        throw new Error("Pi title generation returned no usable title")
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt >= maxAttempts || this.closed) throw lastError

        const delayMs = this.retryBaseDelayMs * 2 ** (attempt - 1)
        this.logger.warn("Title generation attempt failed; retrying with a fresh Pi process", {
          attempt,
          maxAttempts,
          nextAttempt: attempt + 1,
          delayMs,
          error: lastError.message,
        })
        if (delayMs > 0) await Bun.sleep(delayMs)
      }
    }

    throw lastError ?? new Error("Pi title generation failed")
  }

  private async generateOnce(
    directory: string,
    userMessage: string,
    model: { provider: string; model: string },
  ): Promise<string | undefined> {
    const args = [
      "--mode",
      "rpc",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--system-prompt",
      TITLE_SYSTEM_PROMPT,
    ]
    if (model.provider) args.push("--provider", model.provider)
    if (model.model) args.push("--model", model.model)

    const transport = new PiRpcTransport({
      cliPath: this.config.piCliPath,
      args,
      cwd: directory,
      env: {
        ...(this.config.piAgentDir ? { PI_CODING_AGENT_DIR: this.config.piAgentDir } : {}),
        ...(this.logger.isVerbose() ? { OPENCODE_ADAPTOR_VERBOSE: "1" } : {}),
      },
      rpcTimeoutMs: this.config.agentRpcTimeoutMs,
      startTimeoutMs: this.config.agentStartTimeoutMs,
      logger: this.logger.child({ component: "pi-title" }),
    })
    this.active.add(transport)

    let generated: string | undefined
    let finalAssistantError: Error | undefined
    let settledResolve: (() => void) | undefined
    let settledReject: ((error: Error) => void) | undefined
    const settled = new Promise<void>((resolve, reject) => {
      settledResolve = resolve
      settledReject = reject
    })
    const unsubscribe = transport.subscribe((event: PiRpcMessage) => {
      if (event.type === "message_end") {
        const message = (event as { message?: unknown }).message
        const error = assistantMessageError(message)
        if (error) {
          finalAssistantError = error
          generated = undefined
        } else {
          const text = textFromAssistantMessage(message)
          if (text) {
            generated = text
            finalAssistantError = undefined
          }
        }
      } else if (event.type === "agent_settled") {
        if (finalAssistantError) settledReject?.(finalAssistantError)
        else settledResolve?.()
      } else if (event.type === "extension_error") {
        settledReject?.(new Error(String((event as { error?: unknown }).error ?? "Pi title generation failed")))
      }
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await transport.start()
      await transport.send({
        type: "prompt",
        message: `Generate a title for this conversation:\n\n${userMessage}`,
      })
      await Promise.race([
        settled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Pi title generation timed out after ${this.config.agentRpcTimeoutMs}ms`)),
            this.config.agentRpcTimeoutMs,
          )
        }),
      ])
      return generated ? cleanGeneratedTitle(generated) : undefined
    } finally {
      if (timer) clearTimeout(timer)
      unsubscribe()
      this.active.delete(transport)
      await transport.stop()
    }
  }

  async closeAll(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.active].map((transport) => transport.stop()))
    this.active.clear()
  }
}
