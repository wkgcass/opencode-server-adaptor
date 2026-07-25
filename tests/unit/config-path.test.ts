import { describe, expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { getConfigDir, getDefaultProviderConfigPath, getPiAgentDir, loadConfig } from "../../src/config/index.ts"

describe("configuration paths", () => {
  test("stores providers.yaml in the adaptor config directory", () => {
    expect(getDefaultProviderConfigPath()).toBe(join(getConfigDir(), "providers.yaml"))
  })

  test("stores generated Pi configuration one level below the database directory", () => {
    const databasePath = join("/tmp", "opencode-server-adaptor", "adaptor.db")
    expect(getPiAgentDir(databasePath)).toBe(join("/tmp", "opencode-server-adaptor", "pi"))
    expect(getPiAgentDir(":memory:")).toBe("")

    const config = loadConfig()
    if (config.databasePath !== ":memory:") {
      expect(config.piAgentDir).toBe(join(dirname(config.databasePath), "pi"))
    }
  })
})
