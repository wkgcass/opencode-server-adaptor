import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../src/config/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { PiModelConfigStore } from "../../src/agents/pi/pi-model-config.ts"
import { ProviderConfigStore } from "../../src/config/provider-config.ts"

describe("PiModelConfigStore", () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("merges YAML providers, API keys, and raw Pi custom fields into a private Pi models.json", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-model-config-"))
    directories.push(root)
    const sourceAgentDir = join(root, "source-agent")
    const targetAgentDir = join(root, "state")
    mkdirSync(sourceAgentDir)
    mkdirSync(targetAgentDir)
    writeFileSync(
      join(sourceAgentDir, "models.json"),
      JSON.stringify({
        providers: {
          existing: {
            baseUrl: "https://existing.example/v1",
            api: "openai-completions",
            apiKey: "existing-key",
            models: [{ id: "existing-model" }],
          },
        },
      }),
    )
    writeFileSync(join(sourceAgentDir, "auth.json"), '{"existing":{"type":"api_key"}}\n')

    const databasePath = join(targetAgentDir, "adaptor.db")
    const providerConfigPath = join(targetAgentDir, "providers.yaml")
    const logger = new Logger()
    const providerConfig = new ProviderConfigStore(providerConfigPath, logger)
    providerConfig.update({
      provider: {
        "pi-cmss": {
          name: "Pi CMSS",
          api: "openai-completions",
          baseUrl: "https://gateway.example/v1",
          apiKey: "${PI_CMSS_API_KEY}",
          headers: { "x-tenant": "test" },
          custom: { pi: { authHeader: true, extraProviderOption: { enabled: true } } },
          models: {
            "zhanlu/qwen": {
              name: "Qwen",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 160000,
              maxTokens: 32000,
              custom: { pi: { compat: { supportsDeveloperRole: false } } },
            },
          },
        },
      },
    })

    const config = {
      ...loadConfig(),
      databasePath,
      piAgentDir: targetAgentDir,
    }
    const store = new PiModelConfigStore(providerConfig, config, logger, { sourceAgentDir })

    expect(store.sync()).toBe(true)
    expect(store.revision).toBeGreaterThan(0)
    const initialRevision = store.revision
    const generated = JSON.parse(readFileSync(join(targetAgentDir, "models.json"), "utf8"))
    expect(generated.providers.existing.models[0].id).toBe("existing-model")
    expect(generated.providers["pi-cmss"]).toEqual({
      name: "Pi CMSS",
      baseUrl: "https://gateway.example/v1",
      apiKey: "${PI_CMSS_API_KEY}",
      api: "openai-completions",
      headers: { "x-tenant": "test" },
      authHeader: true,
      extraProviderOption: { enabled: true },
      models: [
        {
          id: "zhanlu/qwen",
          name: "Qwen",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 160000,
          maxTokens: 32000,
          compat: { supportsDeveloperRole: false },
        },
      ],
    })
    expect(readFileSync(join(targetAgentDir, "auth.json"), "utf8")).toContain("existing")
    const taskExtension = store.taskExtensionPath
    expect(taskExtension).toBeDefined()
    expect(readFileSync(taskExtension!, "utf8")).toContain('name: "task"')
    expect(readFileSync(taskExtension!, "utf8")).toContain('"--no-extensions"')
    const planExtension = store.planExtensionPath
    expect(planExtension).toBeDefined()
    expect(readFileSync(planExtension!, "utf8")).toContain('new Set(["edit", "write"])')
    expect(readFileSync(planExtension!, "utf8")).toContain("Plan mode is read-only")
    expect(statSync(join(targetAgentDir, "models.json")).mode & 0o777).toBe(0o600)
    expect(statSync(join(targetAgentDir, "auth.json")).mode & 0o777).toBe(0o600)
    expect(statSync(taskExtension!).mode & 0o777).toBe(0o600)
    expect(statSync(planExtension!).mode & 0o777).toBe(0o600)
    const firstInode = statSync(join(targetAgentDir, "models.json")).ino
    expect(store.sync()).toBe(false)
    expect(store.revision).toBe(initialRevision)
    expect(statSync(join(targetAgentDir, "models.json")).ino).toBe(firstInode)

    writeFileSync(join(sourceAgentDir, "auth.json"), '{"existing":{"type":"oauth"}}\n')
    expect(store.sync()).toBe(true)
    expect(store.revision).toBe(initialRevision)
    expect(readFileSync(join(targetAgentDir, "auth.json"), "utf8")).toContain("oauth")

    writeFileSync(providerConfigPath, "provider: {}\n")
    expect(store.revision).toBeGreaterThan(0)
    expect(store.sync()).toBe(true)
    const afterDelete = JSON.parse(readFileSync(join(targetAgentDir, "models.json"), "utf8"))
    expect(afterDelete.providers["pi-cmss"]).toBeUndefined()
    expect(afterDelete.providers.existing).toBeDefined()
  })

  test("passes supported provider API types to Pi", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-model-api-map-"))
    directories.push(root)
    const sourceAgentDir = join(root, "source-agent")
    mkdirSync(sourceAgentDir)
    writeFileSync(join(sourceAgentDir, "models.json"), '{"providers":{}}\n')
    const databasePath = join(root, "adaptor.db")
    const logger = new Logger()
    const providerConfig = new ProviderConfigStore(join(root, "providers.yaml"), logger)
    const providers: Record<string, any> = {}
    for (const [providerID, api] of [
      ["responses", "openai-responses"],
      ["anthropic-proxy", "anthropic-messages"],
      ["google-proxy", "google-generative-ai"],
      ["mistral-proxy", "mistral-conversations"],
    ] as const) {
      providers[providerID] = {
        api,
        baseUrl: "https://gateway.example/v1",
        apiKey: "key",
        models: { model: { name: "Model" } },
      }
    }
    providerConfig.update({ provider: providers })

    const store = new PiModelConfigStore(
      providerConfig,
      {
        ...loadConfig(),
        databasePath,
        piAgentDir: root,
      },
      logger,
      { sourceAgentDir },
    )
    store.sync()
    const generated = JSON.parse(readFileSync(join(root, "models.json"), "utf8"))
    expect(generated.providers.responses.api).toBe("openai-responses")
    expect(generated.providers["anthropic-proxy"].api).toBe("anthropic-messages")
    expect(generated.providers["google-proxy"].api).toBe("google-generative-ai")
    expect(generated.providers["mistral-proxy"].api).toBe("mistral-conversations")
  })
})
