import type { AppConfig } from "../config/index.ts"
import type { DatabaseService } from "../db/index.ts"
import type { Logger } from "../logging/index.ts"
import type { InteractionPayloadOptimizer } from "../logging/interaction-payload.ts"
import type { ProviderConfigChangeListener } from "../config/provider-config.ts"
import type { ProviderConfigStore } from "../config/provider-config.ts"
import type { BuiltinProviderDefinition } from "../provider/index.ts"
import type { AgentAdapter } from "./agent-adapter.ts"
import type { AgentAdapterFactory, AgentAdapterRegistry } from "./registry.ts"
import type { SkillDirectoryRegistration } from "../skill/skill-service.ts"

export interface AgentAdapterFactoryRegistration {
  type: string
  factory: AgentAdapterFactory
}

export interface AgentInteractionPayloadRegistration {
  channel: string
  optimizer: InteractionPayloadOptimizer
}

/**
 * Everything one backend contributes to the OpenCode-facing server.
 *
 * The server installs integrations without knowing how a backend constructs
 * runtimes, discovers fallback subagents, synchronizes provider data, or
 * optimizes its protocol logs.
 */
export interface AgentIntegration {
  adapters: readonly AgentAdapter[]
  factories?: readonly AgentAdapterFactoryRegistration[]
  providers?: readonly BuiltinProviderDefinition[]
  providerConfigListeners?: readonly ProviderConfigChangeListener[]
  interactionPayloadOptimizers?: readonly AgentInteractionPayloadRegistration[]
  skillDirectories?: readonly SkillDirectoryRegistration[]
  defaultAdapterType?: string
  defaultModel?: string
}

export interface AgentIntegrationContext {
  config: AppConfig
  db: DatabaseService
  providerConfig: ProviderConfigStore
  logger: Logger
}

export type AgentIntegrationFactory = (context: AgentIntegrationContext) => AgentIntegration

export interface InstalledAgentIntegrations {
  providers: BuiltinProviderDefinition[]
  providerConfigListeners: ProviderConfigChangeListener[]
  interactionPayloadOptimizers: AgentInteractionPayloadRegistration[]
  skillDirectories: SkillDirectoryRegistration[]
  defaultAdapterType: string | undefined
  defaultModel: string | undefined
}

export function installAgentIntegrations(
  registry: AgentAdapterRegistry,
  integrations: readonly AgentIntegration[],
  preferredAgentId?: string,
): InstalledAgentIntegrations {
  for (const integration of integrations) {
    for (const adapter of integration.adapters) registry.register(adapter)
    for (const registration of integration.factories ?? []) {
      registry.registerFactory(registration.type, registration.factory)
    }
  }

  const preferred =
    integrations.find((integration) => integration.adapters.some((adapter) => adapter.id === preferredAgentId)) ??
    integrations[0]

  return {
    providers: integrations.flatMap((integration) => [...(integration.providers ?? [])]),
    providerConfigListeners: integrations.flatMap((integration) => [...(integration.providerConfigListeners ?? [])]),
    interactionPayloadOptimizers: integrations.flatMap((integration) => [
      ...(integration.interactionPayloadOptimizers ?? []),
    ]),
    skillDirectories: integrations.flatMap((integration) => [...(integration.skillDirectories ?? [])]),
    defaultAdapterType:
      preferred?.defaultAdapterType ??
      integrations.find((integration) => integration.defaultAdapterType)?.defaultAdapterType,
    defaultModel: preferred?.defaultModel ?? integrations.find((integration) => integration.defaultModel)?.defaultModel,
  }
}
