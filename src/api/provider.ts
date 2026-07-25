import type {
  ProviderConfig,
  ProviderConfigStore,
  ProviderModelConfig,
} from "../config/provider-config.ts"

export type { ProviderConfig, ProviderModelConfig } from "../config/provider-config.ts"

export interface ProviderModel {
  id: string
  providerID: string
  name: string
  api: { id: string; url: string; npm: string }
  capabilities: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
    input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
    output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean }
    interleaved: boolean
  }
  cost: { input: number; output: number; cache: { read: number; write: number } }
  limit: { context: number; output: number }
  status: "alpha" | "beta" | "deprecated" | "active"
  options: Record<string, unknown>
  headers: Record<string, string>
  release_date: string
}

export interface ProviderInfo {
  id: string
  name: string
  source: "env" | "config" | "custom" | "api"
  env: string[]
  key?: string
  options: Record<string, unknown>
  models: Record<string, ProviderModel>
}

export interface BuiltinProviderDefinition {
  id: string
  name: string
  modelID: string
  modelName?: string
  reasoning?: boolean
  contextLimit?: number
  outputLimit?: number
  requiresAuth?: boolean
}

function buildModel(providerID: string, modelID: string, cfg: ProviderModelConfig): ProviderModel {
  return {
    id: modelID,
    providerID,
    name: cfg.name ?? modelID,
    api: { id: modelID, url: "", npm: "" },
    capabilities: {
      temperature: false,
      reasoning: cfg.reasoning ?? false,
      attachment: cfg.input?.includes("image") ?? false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: cfg.contextWindow ?? 0, output: cfg.maxTokens ?? 0 },
    status: "active",
    options: {},
    headers: cfg.headers ?? {},
    release_date: "",
  }
}

function buildProviderInfo(providerID: string, cfg: ProviderConfig): ProviderInfo {
  const models: Record<string, ProviderModel> = {}
  if (cfg.models) {
    for (const [modelID, modelCfg] of Object.entries(cfg.models)) {
      models[modelID] = buildModel(providerID, modelID, modelCfg)
    }
  }
  return {
    id: providerID,
    name: cfg.name ?? providerID,
    source: "config",
    env: [],
    options: {},
    models,
  }
}

export function loadProviderConfigObject(store: ProviderConfigStore): Record<string, ProviderConfig> {
  return store.snapshot().provider ?? {}
}

export function buildProviders(store: ProviderConfigStore, builtins: BuiltinProviderDefinition[] = []): ProviderInfo[] {
  const providers: ProviderInfo[] = []
  const builtinProviderInfo: ProviderInfo[] = []
  const seen = new Set<string>()

  const configured = new Map(Object.entries(store.snapshot().provider ?? {}))
  for (const [providerID, providerCfg] of configured) {
    const info = buildProviderInfo(providerID, providerCfg)
    providers.push(info)
    seen.add(providerID)
  }

  for (const builtin of builtins) {
    if (seen.has(builtin.id)) {
      const existing = providers.find((provider) => provider.id === builtin.id)!
      if (!existing.models[builtin.modelID]) {
        existing.models[builtin.modelID] = buildModel(builtin.id, builtin.modelID, {
          name: builtin.modelName ?? builtin.modelID,
          reasoning: builtin.reasoning ?? false,
          contextWindow: builtin.contextLimit ?? 0,
          maxTokens: builtin.outputLimit ?? 0,
        })
      }
      continue
    }
    builtinProviderInfo.push({
      id: builtin.id,
      name: builtin.name,
      source: "custom",
      env: [],
      options: {},
      models: {
        [builtin.modelID]: buildModel(builtin.id, builtin.modelID, {
          name: builtin.modelName ?? builtin.modelID,
          reasoning: builtin.reasoning ?? false,
          contextWindow: builtin.contextLimit ?? 0,
          maxTokens: builtin.outputLimit ?? 0,
        }),
      },
    })
    seen.add(builtin.id)
  }

  return [...builtinProviderInfo, ...providers]
}

export function buildDefaultProviderMap(providers: ProviderInfo[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const provider of providers) {
    const modelIDs = Object.keys(provider.models).sort()
    if (modelIDs.length > 0) result[provider.id] = modelIDs[0]!
  }
  return result
}
