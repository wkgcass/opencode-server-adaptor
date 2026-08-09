import type { AgentIntegration } from "../agent-integration.ts"
import { ManualSubagentRunner } from "../subagents/manual-subagent-runner.ts"
import { optimizePiInteractionPayload } from "./pi-interaction-payload.ts"
import { PiAgentAdapter } from "./pi-adapter.ts"
import { PiManualSubagentBackend } from "./pi-manual-subagent-backend.ts"
import { PiModelConfigStore } from "./pi-model-config.ts"
import { PiSubagentRunner } from "./subagent-runner.ts"
import { PiTitleGenerator } from "./pi-title-generator.ts"
import type { AgentIntegrationContext } from "../agent-integration.ts"
import { PiConversationStore } from "./pi-conversation-store.ts"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Builds the complete Pi contribution behind the generic integration
 * boundary. No OpenCode route or service needs to know Pi's internal pieces.
 */
export function createPiAgentIntegration(context: AgentIntegrationContext): AgentIntegration {
  const { config, db, providerConfig, logger } = context
  const modelConfig = new PiModelConfigStore(providerConfig, config, logger)
  const conversationStore = new PiConversationStore(db)
  modelConfig.sync()

  const processSubagentRunner = new PiSubagentRunner({
    agentDir: modelConfig.agentDir,
    beforeSpawn: () => modelConfig.sync(),
    logger,
  })
  const fallbackSubagents = new ManualSubagentRunner(
    new PiManualSubagentBackend({
      piExecutable: config.piCliPath,
      agentScope: config.subtaskAgentScope,
      terminateGracePeriodMs: config.subtaskTerminateGracePeriodMs,
      stderrLimitBytes: config.subtaskStderrLimitBytes,
      runner: processSubagentRunner,
      logger,
    }),
  )
  fallbackSubagents.registerProfile({
    name: "pi",
    description: "Pi Agent",
    provider: config.piProvider || undefined,
    model: config.piModel || undefined,
  })

  const titleGenerator = new PiTitleGenerator(config, logger)
  const adapter = new PiAgentAdapter(config, {
    modelConfig,
    subagents: fallbackSubagents,
    titleGenerator,
    conversationStore,
  })
  const planAdapter = new PiAgentAdapter(config, {
    id: "plan",
    displayName: "Plan",
    mode: "primary",
    planMode: true,
    removable: false,
    modelConfig,
    subagents: fallbackSubagents,
    titleGenerator,
    conversationStore,
  })

  return {
    adapters: [adapter, planAdapter],
    factories: [
      {
        type: "pi",
        factory: (input) =>
          new PiAgentAdapter(config, {
            id: input.id,
            displayName: input.displayName,
            cliPath: input.cliPath,
            provider: input.provider,
            model: input.model,
            systemPrompt: input.systemPrompt,
            removable: true,
            modelConfig,
            subagents: fallbackSubagents,
            conversationStore,
          }),
      },
    ],
    providers: [
      {
        id: "pi",
        name: "Pi Agent",
        modelID: "default",
        modelName: "Pi default model",
        reasoning: true,
        contextLimit: 200_000,
        outputLimit: 32_000,
        requiresAuth: false,
      },
    ],
    providerConfigListeners: [modelConfig],
    interactionPayloadOptimizers: [{ channel: "pi", optimizer: optimizePiInteractionPayload }],
    skillDirectories: [
      { scope: "user", directory: () => join(homedir(), ".pi", "agent", "skills") },
      { scope: "project", directory: (directory) => join(directory, ".pi", "skills") },
    ],
    defaultAdapterType: "pi",
    defaultModel:
      providerConfig.snapshot().model ??
      (config.piProvider && config.piModel ? `${config.piProvider}/${config.piModel}` : "pi/default"),
  }
}
