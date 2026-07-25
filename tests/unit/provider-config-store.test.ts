import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildProviders } from "../../src/api/provider.ts"
import { ProviderConfigStore } from "../../src/config/provider-config.ts"
import { Logger } from "../../src/logging/index.ts"

describe("ProviderConfigStore", () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("returns only the built-in default and YAML-configured provider models", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-yaml-"))
    directories.push(root)
    const logger = new Logger({ minLevel: "ERROR" })
    writeFileSync(
      join(root, "providers.yaml"),
      [
        "model: configured/model-b",
        "provider:",
        "  configured:",
        "    name: Configured",
        "    models:",
        "      model-a: { name: Model A, contextWindow: 262144, maxTokens: 81920 }",
        "      model-b: { name: Model B }",
        "",
      ].join("\n"),
    )
    const store = new ProviderConfigStore(join(root, "providers.yaml"), logger)

    const providers = buildProviders(store, [{ id: "pi", name: "Pi Agent", modelID: "default", requiresAuth: false }])
    expect(providers.map((provider) => provider.id)).toEqual(["pi", "configured"])
    expect(Object.keys(providers[0]!.models)).toEqual(["default"])
    expect(Object.keys(providers[1]!.models).sort()).toEqual(["model-a", "model-b"])
    expect(providers[1]!.models["model-a"]!.limit).toEqual({ context: 262144, output: 81920 })
    expect(providers[1]!.models["model-b"]!.limit).toEqual({ context: 0, output: 0 })
  })

  test("rewrites legacy OpenCode provider fields to the minimal canonical YAML structure", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-yaml-cleanup-"))
    directories.push(root)
    const logger = new Logger({ minLevel: "ERROR" })
    const path = join(root, "providers.yaml")
    writeFileSync(
      path,
      [
        "model: legacy/model",
        "small_model: legacy/small",
        "disabled_providers: [unused]",
        "provider:",
        "  legacy:",
        "    name: Legacy",
        "    npm: '@ai-sdk/openai-compatible'",
        "    env: [LEGACY_API_KEY]",
        "    options:",
        "      baseURL: https://legacy.example/v1",
        "      apiKey: $LEGACY_API_KEY",
        "      authHeader: true",
        "    models:",
        "      model:",
        "        name: Legacy Model",
        "        attachment: true",
        "        tool_call: true",
        "        limit: { context: 100000, output: 16000 }",
        "",
      ].join("\n"),
    )

    const store = new ProviderConfigStore(path, logger)
    expect(store.snapshot()).toEqual({
      model: "legacy/model",
      provider: {
        legacy: {
          name: "Legacy",
          api: "openai-completions",
          baseUrl: "https://legacy.example/v1",
          apiKey: "$LEGACY_API_KEY",
          authHeader: true,
          models: {
            model: {
              name: "Legacy Model",
              input: ["text", "image"],
              contextWindow: 100000,
              maxTokens: 16000,
            },
          },
        },
      },
    })
    const rewritten = readFileSync(path, "utf8")
    for (const removed of ["small_model", "disabled_providers", "npm:", "env:", "options:", "tool_call", "limit:"]) {
      expect(rewritten).not.toContain(removed)
    }
    expect(rewritten).toContain("baseUrl: https://legacy.example/v1")
  })

  test("stores and removes API keys in providers.yaml", () => {
    const root = mkdtempSync(join(tmpdir(), "provider-yaml-api-key-"))
    directories.push(root)
    const logger = new Logger({ minLevel: "ERROR" })
    const path = join(root, "providers.yaml")
    writeFileSync(path, "provider:\n  configured:\n    models:\n      model: {}\n")
    const store = new ProviderConfigStore(path, logger)

    expect(store.setApiKey("configured", "${CONFIGURED_API_KEY}")).toBe(true)
    expect(store.snapshot().provider?.configured?.apiKey).toBe("${CONFIGURED_API_KEY}")
    expect(readFileSync(path, "utf8")).toContain("apiKey: ${CONFIGURED_API_KEY}")

    expect(store.setApiKey("missing", "unused")).toBe(false)
    expect(store.setApiKey("configured", undefined)).toBe(true)
    expect(store.snapshot().provider?.configured?.apiKey).toBeUndefined()
    expect(readFileSync(path, "utf8")).not.toContain("apiKey:")
  })
})
