import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { parse, stringify } from "yaml"
import type { Logger } from "../logging/index.ts"

/** Notifies an agent backend that provider or authentication data changed. */
export interface ProviderConfigChangeListener {
  markDirty(): void
}

export type ProviderApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "mistral-conversations"
  | "google-generative-ai"
  | "google-vertex"
  | "bedrock-converse-stream"

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

const PROVIDER_APIS = new Set<ProviderApi>([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "mistral-conversations",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
])

export interface AgentBackendCustomConfig {
  pi?: Record<string, unknown>
}

export interface ProviderModelConfig {
  name?: string
  api?: ProviderApi
  baseUrl?: string
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>
  input?: Array<"text" | "image">
  contextWindow?: number
  maxTokens?: number
  headers?: Record<string, string>
  custom?: AgentBackendCustomConfig
}

export interface ProviderConfig {
  name?: string
  api?: ProviderApi
  baseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
  authHeader?: boolean
  models?: Record<string, ProviderModelConfig>
  custom?: AgentBackendCustomConfig
}

export interface ProviderFileConfig {
  model?: string
  provider?: Record<string, ProviderConfig>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function providerApi(value: unknown): ProviderApi | undefined {
  const api = nonEmptyString(value) as ProviderApi | undefined
  return api && PROVIDER_APIS.has(api) ? api : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const result = Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
  return Object.keys(result).length > 0 ? result : undefined
}

function customConfig(value: unknown): AgentBackendCustomConfig | undefined {
  if (!isRecord(value) || !isRecord(value.pi)) return undefined
  return { pi: value.pi }
}

function legacyApi(npm: unknown): ProviderApi | undefined {
  switch (npm) {
    case "@ai-sdk/anthropic":
      return "anthropic-messages"
    case "@ai-sdk/google":
      return "google-generative-ai"
    case "@ai-sdk/openai":
      return "openai-responses"
    case "@ai-sdk/openai-compatible":
      return "openai-completions"
    default:
      return undefined
  }
}

function normalizeModel(value: Record<string, unknown>): ProviderModelConfig {
  const legacyLimit = isRecord(value.limit) ? value.limit : {}
  const input = Array.isArray(value.input)
    ? value.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
    : value.attachment === true
      ? (["text", "image"] as Array<"text" | "image">)
      : undefined
  const rawThinkingLevelMap = isRecord(value.thinkingLevelMap) ? value.thinkingLevelMap : undefined
  const thinkingLevelMap = rawThinkingLevelMap
    ? Object.fromEntries(
        Object.entries(rawThinkingLevelMap).filter(
          (entry): entry is [ThinkingLevel, string | null] =>
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(entry[0]) &&
            (typeof entry[1] === "string" || entry[1] === null),
        ),
      )
    : undefined

  return {
    name: nonEmptyString(value.name),
    api: providerApi(value.api),
    baseUrl: nonEmptyString(value.baseUrl) ?? nonEmptyString(value.baseURL),
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : undefined,
    thinkingLevelMap: thinkingLevelMap && Object.keys(thinkingLevelMap).length > 0 ? thinkingLevelMap : undefined,
    input: input && input.length > 0 ? [...new Set(input)] : undefined,
    contextWindow: positiveNumber(value.contextWindow) ?? positiveNumber(legacyLimit.context),
    maxTokens: positiveNumber(value.maxTokens) ?? positiveNumber(legacyLimit.output),
    headers: stringRecord(value.headers),
    custom: customConfig(value.custom),
  }
}

function normalizeProvider(value: Record<string, unknown>): ProviderConfig {
  const legacyOptions = isRecord(value.options) ? value.options : {}
  const models = isRecord(value.models)
    ? Object.fromEntries(
        Object.entries(value.models)
          .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
          .map(([modelID, model]) => [modelID, normalizeModel(model)]),
      )
    : undefined

  return {
    name: nonEmptyString(value.name),
    api: providerApi(value.api) ?? legacyApi(value.npm),
    baseUrl:
      nonEmptyString(value.baseUrl) ??
      nonEmptyString(value.baseURL) ??
      nonEmptyString(legacyOptions.baseUrl) ??
      nonEmptyString(legacyOptions.baseURL),
    apiKey: nonEmptyString(value.apiKey) ?? nonEmptyString(legacyOptions.apiKey),
    headers: stringRecord(value.headers) ?? stringRecord(legacyOptions.headers),
    authHeader:
      typeof value.authHeader === "boolean"
        ? value.authHeader
        : typeof legacyOptions.authHeader === "boolean"
          ? legacyOptions.authHeader
          : undefined,
    models,
    custom: customConfig(value.custom),
  }
}

function normalize(value: unknown): ProviderFileConfig {
  if (!isRecord(value)) return {}
  const providers: Record<string, ProviderConfig> = {}
  if (isRecord(value.provider)) {
    for (const [providerID, providerValue] of Object.entries(value.provider)) {
      if (!isRecord(providerValue)) continue
      providers[providerID] = normalizeProvider(providerValue)
    }
  }
  return {
    model: nonEmptyString(value.model),
    provider: Object.keys(providers).length > 0 || isRecord(value.provider) ? providers : undefined,
  }
}

function writePrivateFileAtomic(path: string, content: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

/**
 * User-editable provider/model configuration. The empty path is used by
 * DATABASE_PATH=:memory: and keeps configuration process-local.
 */
export class ProviderConfigStore {
  readonly path: string | undefined
  private value: ProviderFileConfig = {}
  private raw: string | undefined
  private loaded = false
  private revisionValue = 0
  private readonly logger: Logger

  constructor(path: string, logger: Logger) {
    this.path = path || undefined
    this.logger = logger
    this.refresh()
  }

  get revision(): number {
    this.refresh()
    return this.revisionValue
  }

  snapshot(): ProviderFileConfig {
    this.refresh()
    return structuredClone(this.value)
  }

  update(input: { provider?: Record<string, ProviderConfig>; model?: string | null }): ProviderFileConfig {
    this.refresh()
    const next = structuredClone(this.value)
    if (input.provider) {
      next.provider = { ...(next.provider ?? {}), ...input.provider }
    }
    if ("model" in input) {
      if (typeof input.model === "string" && input.model.trim()) next.model = input.model.trim()
      else delete next.model
    }
    this.write(next)
    return this.snapshot()
  }

  setApiKey(providerID: string, apiKey: string | undefined): boolean {
    this.refresh()
    const current = this.value.provider?.[providerID]
    if (!current) return false

    const next = structuredClone(this.value)
    const provider = { ...next.provider![providerID]! }
    if (apiKey?.trim()) provider.apiKey = apiKey.trim()
    else delete provider.apiKey
    next.provider![providerID] = provider
    this.write(next)
    return true
  }

  deleteProvider(providerID: string): boolean {
    this.refresh()
    if (!this.value.provider?.[providerID]) return false
    const next = structuredClone(this.value)
    delete next.provider![providerID]
    if (Object.keys(next.provider!).length === 0) delete next.provider
    this.write(next)
    return true
  }

  deleteModel(providerID: string, modelID: string): boolean {
    this.refresh()
    const provider = this.value.provider?.[providerID]
    if (!provider?.models?.[modelID]) return false
    const next = structuredClone(this.value)
    const nextProvider = next.provider![providerID]!
    delete nextProvider.models![modelID]
    if (Object.keys(nextProvider.models!).length === 0) delete nextProvider.models
    this.write(next)
    return true
  }

  private refresh(): void {
    if (!this.path) return
    let nextRaw: string | undefined
    try {
      nextRaw = existsSync(this.path) ? readFileSync(this.path, "utf8") : undefined
      if (this.loaded && nextRaw === this.raw) return
      const parsed = nextRaw === undefined ? {} : parse(nextRaw)
      const next = normalize(parsed)
      if (this.path && nextRaw !== undefined && JSON.stringify(parsed) !== JSON.stringify(next)) {
        nextRaw = stringify(next, { lineWidth: 120 })
        writePrivateFileAtomic(this.path, nextRaw)
      }
      this.raw = nextRaw
      this.value = next
      if (this.loaded) this.revisionValue++
      this.loaded = true
    } catch (error) {
      this.logger.warn("Failed to read provider YAML; keeping the last valid configuration", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private write(value: ProviderFileConfig): void {
    const normalized = normalize(value)
    const nextRaw = stringify(normalized, { lineWidth: 120 })
    if (this.path) writePrivateFileAtomic(this.path, nextRaw)
    this.value = normalized
    this.raw = this.path ? nextRaw : undefined
    this.loaded = true
    this.revisionValue++
  }
}
