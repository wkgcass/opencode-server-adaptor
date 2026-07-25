import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AppConfig } from "../../src/config/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { PiTitleGenerator } from "../../src/agents/pi/pi-title-generator.ts"

const fakePi = join(import.meta.dir, "..", "fixtures", "fake-pi", "fake-pi.ts")

function testConfig(): AppConfig {
  return {
    piCliPath: `"${process.execPath}" "${fakePi}"`,
    piAgentDir: "",
    agentRpcTimeoutMs: 2_000,
    agentStartTimeoutMs: 2_000,
  } as AppConfig
}

function attemptCount(path: string): number {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length
}

describe("PiTitleGenerator retries", () => {
  const directories: string[] = []
  const generators: PiTitleGenerator[] = []

  afterEach(async () => {
    await Promise.all(generators.splice(0).map((generator) => generator.closeAll()))
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("retries a failed title call in a fresh Pi process and uses the successful result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-title-retry-"))
    directories.push(directory)
    const attempts = join(directory, "attempts")
    const generator = new PiTitleGenerator(testConfig(), new Logger(), {
      maxRetries: 2,
      retryBaseDelayMs: 1,
    })
    generators.push(generator)

    const title = await generator.generate(
      directory,
      `Investigate a transient title failure __title_fail_once__=${attempts}`,
      { provider: "test", model: "test-model" },
    )

    expect(title).toBe("Fake conversation title")
    expect(attemptCount(attempts)).toBe(2)
  })

  test("stops after the bounded retry budget is exhausted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-title-retry-"))
    directories.push(directory)
    const attempts = join(directory, "attempts")
    const generator = new PiTitleGenerator(testConfig(), new Logger(), {
      maxRetries: 2,
      retryBaseDelayMs: 1,
    })
    generators.push(generator)

    await expect(
      generator.generate(
        directory,
        `Keep failing title generation __title_always_fail__=${attempts}`,
        { provider: "test", model: "test-model" },
      ),
    ).rejects.toThrow("HTTP 500: temporary title provider failure")
    expect(attemptCount(attempts)).toBe(3)
  })

  test("does not restart when Pi's own automatic retry recovers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-title-retry-"))
    directories.push(directory)
    const generator = new PiTitleGenerator(testConfig(), new Logger(), {
      maxRetries: 2,
      retryBaseDelayMs: 1,
    })
    generators.push(generator)

    const title = await generator.generate(directory, "Recover internally __retry_once__", {
      provider: "test",
      model: "test-model",
    })

    expect(title).toBe("Fake conversation title")
  })
})
