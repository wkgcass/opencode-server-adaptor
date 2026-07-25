import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import type { AppConfig } from "../../config/index.ts"
import type { Logger } from "../../logging/index.ts"
import type { ProviderConfig, ProviderModelConfig } from "../../api/provider.ts"
import type { ProviderConfigStore } from "../../config/provider-config.ts"
import { planExtensionPath, syncPiRuntimeAssets, taskExtensionPath } from "./pi-runtime-assets.ts"

interface PiModelDefinition {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  reasoning?: boolean
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>
  input?: Array<"text" | "image">
  contextWindow?: number
  maxTokens?: number
  headers?: Record<string, string>
}

interface PiProviderDefinition {
  name?: string
  baseUrl?: string
  apiKey?: string
  api?: string
  headers?: Record<string, string>
  authHeader?: boolean
  models?: PiModelDefinition[]
  [key: string]: unknown
}

interface PiModelsFile {
  providers: Record<string, PiProviderDefinition>
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function mergePiCustom<T extends Record<string, unknown>>(generated: T, custom: unknown): T {
  const pi = objectRecord(objectRecord(custom)?.pi)
  if (!pi) return generated
  const merge = (base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...base }
    for (const [key, value] of Object.entries(override)) {
      const current = objectRecord(result[key])
      const nested = objectRecord(value)
      result[key] = current && nested ? merge(current, nested) : value
    }
    return result
  }
  return merge(generated, pi) as T
}

function mapApi(config: ProviderConfig): string {
  const explicitApi = nonEmptyString(config.api)
  return explicitApi ?? "openai-completions"
}

function mapModel(modelID: string, config: ProviderModelConfig): PiModelDefinition {
  const model: PiModelDefinition = { id: modelID }
  const name = nonEmptyString(config.name)
  if (name) model.name = name
  const api = nonEmptyString(config.api)
  if (api) model.api = api
  const baseUrl = nonEmptyString(config.baseUrl)
  if (baseUrl) model.baseUrl = baseUrl
  if (typeof config.reasoning === "boolean") model.reasoning = config.reasoning
  if (config.thinkingLevelMap) model.thinkingLevelMap = config.thinkingLevelMap
  model.input = config.input?.length ? config.input : ["text"]

  const contextWindow = positiveNumber(config.contextWindow)
  const maxTokens = positiveNumber(config.maxTokens)
  if (contextWindow) model.contextWindow = contextWindow
  if (maxTokens) model.maxTokens = maxTokens
  const headers = stringRecord(config.headers)
  if (headers) model.headers = headers
  return mergePiCustom(model as PiModelDefinition & Record<string, unknown>, config.custom)
}

function mapProvider(config: ProviderConfig): PiProviderDefinition {
  const provider: PiProviderDefinition = {}
  const name = nonEmptyString(config.name)
  const baseUrl = nonEmptyString(config.baseUrl)
  const apiKey = nonEmptyString(config.apiKey)
  const headers = stringRecord(config.headers)

  if (name) provider.name = name
  if (baseUrl) provider.baseUrl = baseUrl
  if (apiKey) provider.apiKey = apiKey
  provider.api = mapApi(config)
  if (headers) provider.headers = headers
  if (typeof config.authHeader === "boolean") provider.authHeader = config.authHeader

  if (config.models) {
    provider.models = Object.entries(config.models).map(([modelID, model]) => mapModel(modelID, model))
  }
  return mergePiCustom(provider, config.custom)
}

function readModelsFile(path: string): PiModelsFile {
  if (!existsSync(path)) return { providers: {} }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PiModelsFile>
  if (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
    throw new Error(`Invalid Pi models file: ${path}`)
  }
  return { providers: { ...parsed.providers } }
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

function syncPrivateFile(source: string, target: string): boolean {
  if (resolve(source) === resolve(target)) return false
  if (!existsSync(source)) {
    if (!existsSync(target)) return false
    unlinkSync(target)
    return true
  }
  const nextContent = readFileSync(source, "utf8")
  const previousContent = existsSync(target) ? readFileSync(target, "utf8") : undefined
  if (nextContent === previousContent) return false
  writePrivateFileAtomic(target, nextContent)
  return true
}

/**
 * Materializes the adaptor's YAML-backed provider registry in the format Pi
 * loads from PI_CODING_AGENT_DIR/models.json.
 */
export class PiModelConfigStore {
  readonly agentDir: string | undefined
  readonly modelsPath: string | undefined
  readonly taskExtensionPath: string | undefined
  readonly planExtensionPath: string | undefined
  private revisionValue = 0
  private readonly providerConfig: ProviderConfigStore
  private readonly logger: Logger
  private readonly sourceAgentDir: string

  constructor(
    providerConfig: ProviderConfigStore,
    config: AppConfig,
    logger: Logger,
    options?: { sourceAgentDir?: string },
  ) {
    this.providerConfig = providerConfig
    this.logger = logger
    this.agentDir = config.piAgentDir || undefined
    this.modelsPath = this.agentDir ? join(this.agentDir, "models.json") : undefined
    this.taskExtensionPath = this.agentDir ? taskExtensionPath(this.agentDir) : undefined
    this.planExtensionPath = this.agentDir ? planExtensionPath(this.agentDir) : undefined
    this.sourceAgentDir = options?.sourceAgentDir ?? join(homedir(), ".pi", "agent")
  }

  get revision(): number {
    return this.revisionValue + this.providerConfig.revision
  }

  markDirty(): void {
    this.revisionValue++
  }

  sync(): boolean {
    if (!this.agentDir || !this.modelsPath) return false

    const sourceModelsPath = join(this.sourceAgentDir, "models.json")
    let models: PiModelsFile
    try {
      models = readModelsFile(sourceModelsPath)
    } catch (error) {
      this.logger.warn("Failed to load the user's Pi models.json; syncing YAML providers only", {
        path: sourceModelsPath,
        error: error instanceof Error ? error.message : String(error),
      })
      models = { providers: {} }
    }

    const configuredProviders = this.providerConfig.snapshot().provider ?? {}
    for (const [providerID, config] of Object.entries(configuredProviders)) {
      try {
        models.providers[providerID] = mapProvider(config)
      } catch (error) {
        this.logger.warn("Ignoring invalid provider config while syncing Pi models", {
          providerID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const nextContent = JSON.stringify(models, null, 2) + "\n"
    const previousContent = existsSync(this.modelsPath) ? readFileSync(this.modelsPath, "utf8") : undefined
    const modelsChanged = previousContent !== nextContent
    if (modelsChanged) writePrivateFileAtomic(this.modelsPath, nextContent)
    const authChanged = syncPrivateFile(join(this.sourceAgentDir, "auth.json"), join(this.agentDir, "auth.json"))
    const assetsChanged = syncPiRuntimeAssets(this.agentDir, this.logger)
    if (modelsChanged || authChanged || assetsChanged) {
      this.logger.info("Synchronized Pi model configuration", {
        path: this.modelsPath,
        configuredProviders: Object.keys(configuredProviders).length,
      })
    }
    return modelsChanged || authChanged || assetsChanged
  }
}
