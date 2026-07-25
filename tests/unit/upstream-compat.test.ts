import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { discoverAgents, formatAgentList, type AgentConfig } from "../../src/vendor/pi-subagent/agents.ts"
import { parseFrontmatter } from "../../src/vendor/pi-subagent/frontmatter.ts"
import { getAgentDir, CONFIG_DIR_NAME } from "../../src/vendor/pi-subagent/config.ts"
import {
  getFinalOutput,
  isFailedResult,
  getResultOutput,
  truncateParallelOutput,
  mapWithConcurrencyLimit,
  getPiInvocation,
} from "../../src/vendor/pi-subagent/runner.ts"

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures", "agents")

let tmpProjectDir: string
let tmpAgentsDir: string

beforeAll(() => {
  tmpProjectDir = mkdtempSync(join(tmpdir(), "pi-agents-test-"))
  tmpAgentsDir = join(tmpProjectDir, CONFIG_DIR_NAME, "agents")
  mkdirSync(tmpAgentsDir, { recursive: true })
  for (const f of ["scout.md", "planner.md", "no-tools-agent.md", "not-an-agent.md", "incomplete.md"]) {
    copyFileSync(join(FIXTURES_DIR, f), join(tmpAgentsDir, f))
  }
})

afterAll(() => {
  rmSync(tmpProjectDir, { recursive: true })
})

describe("Upstream: parseFrontmatter", () => {
  test("parses YAML frontmatter and body", () => {
    const content = `---
name: test-agent
description: A test agent
tools: read, write
model: claude
---

You are a test agent.`
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content)
    expect(frontmatter.name).toBe("test-agent")
    expect(frontmatter.description).toBe("A test agent")
    expect(frontmatter.tools).toBe("read, write")
    expect(frontmatter.model).toBe("claude")
    expect(body).toBe("You are a test agent.")
  })

  test("returns empty frontmatter for content without frontmatter", () => {
    const content = "Just some text."
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).toEqual({})
    expect(body).toBe("Just some text.")
  })

  test("handles CRLF line endings", () => {
    const content = "---\r\nname: test\r\n---\r\nBody"
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content)
    expect(frontmatter.name).toBe("test")
    expect(body).toBe("Body")
  })

  test("handles missing closing delimiter", () => {
    const content = "---\nname: test\nNo closing"
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter).toEqual({})
  })
})

describe("Upstream: config", () => {
  test("CONFIG_DIR_NAME is .pi", () => {
    expect(CONFIG_DIR_NAME).toBe(".pi")
  })

  test("getAgentDir respects PI_CODING_AGENT_DIR env var", () => {
    const original = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = "/tmp/custom-agent-dir"
    try {
      expect(getAgentDir()).toBe("/tmp/custom-agent-dir")
    } finally {
      if (original) process.env.PI_CODING_AGENT_DIR = original
      else delete process.env.PI_CODING_AGENT_DIR
    }
  })

  test("getAgentDir defaults to ~/.pi/agent", () => {
    const original = process.env.PI_CODING_AGENT_DIR
    delete process.env.PI_CODING_AGENT_DIR
    try {
      const result = getAgentDir()
      expect(result).toContain(".pi")
      expect(result).toContain("agent")
    } finally {
      if (original) process.env.PI_CODING_AGENT_DIR = original
    }
  })
})

describe("Upstream: discoverAgents", () => {
  test("discovers agents from fixture directory", () => {
    const result = discoverAgents(tmpProjectDir, "project")
    const names = result.agents.map((a) => a.name)
    expect(names).toContain("scout")
    expect(names).toContain("planner")
    expect(names).toContain("no-tools-agent")
  })

  test("skips files without required frontmatter fields", () => {
    const result = discoverAgents(tmpProjectDir, "project")
    const names = result.agents.map((a) => a.name)
    expect(names).not.toContain("incomplete")
  })

  test("skips non-markdown files", () => {
    const result = discoverAgents(tmpProjectDir, "project")
    const names = result.agents.map((a) => a.name)
    expect(names).not.toContain("not-an-agent")
  })

  test("parses tools as comma-separated list", () => {
    const result = discoverAgents(tmpProjectDir, "project")
    const scout = result.agents.find((a) => a.name === "scout")
    expect(scout).toBeDefined()
    expect(scout!.tools).toEqual(["read", "grep", "find", "ls"])
  })

  test("returns undefined tools for agents without tools field", () => {
    const result = discoverAgents(tmpProjectDir, "project")
    const noTools = result.agents.find((a) => a.name === "no-tools-agent")
    expect(noTools).toBeDefined()
    expect(noTools!.tools).toBeUndefined()
  })

  test("extracts system prompt from body", () => {
    const result = discoverAgents(tmpProjectDir, "project")
    const scout = result.agents.find((a) => a.name === "scout")
    expect(scout).toBeDefined()
    expect(scout!.systemPrompt).toContain("fast codebase scout")
  })

  test("sets source to project for project scope", () => {
    const result = discoverAgents(tmpProjectDir, "project")
    expect(result.agents.every((a) => a.source === "project")).toBe(true)
  })

  test("findNearestProjectAgentsDir walks up directory tree", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-test-"))
    const agentsDir = join(tmpDir, CONFIG_DIR_NAME, "agents")
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, "test.md"), "---\nname: test\ndescription: test\n---\nBody")

    const nestedDir = join(tmpDir, "a", "b", "c")
    mkdirSync(nestedDir, { recursive: true })

    const result = discoverAgents(nestedDir, "both")
    expect(result.agents.some((a) => a.name === "test")).toBe(true)
    expect(result.projectAgentsDir).toBe(agentsDir)

    rmSync(tmpDir, { recursive: true })
  })

  test("formatAgentList formats agents correctly", () => {
    const agents: AgentConfig[] = [
      { name: "a", description: "Agent A", systemPrompt: "", source: "user", filePath: "" },
      { name: "b", description: "Agent B", systemPrompt: "", source: "project", filePath: "" },
    ]
    const result = formatAgentList(agents, 10)
    expect(result.text).toContain("a (user): Agent A")
    expect(result.text).toContain("b (project): Agent B")
    expect(result.remaining).toBe(0)
  })

  test("formatAgentList truncates with remaining count", () => {
    const agents: AgentConfig[] = Array.from({ length: 5 }, (_, i) => ({
      name: `agent-${i}`,
      description: `Agent ${i}`,
      systemPrompt: "",
      source: "user" as const,
      filePath: "",
    }))
    const result = formatAgentList(agents, 3)
    expect(result.remaining).toBe(2)
  })
})

describe("Upstream: output extraction", () => {
  test("getFinalOutput returns last assistant text", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "first response" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
      { role: "assistant", content: [{ type: "text", text: "final response" }] },
    ]
    expect(getFinalOutput(messages)).toBe("final response")
  })

  test("getFinalOutput returns empty for no assistant messages", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    expect(getFinalOutput(messages)).toBe("")
  })

  test("getFinalOutput returns empty for assistant with no text", () => {
    const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: {} }] }]
    expect(getFinalOutput(messages)).toBe("")
  })

  test("isFailedResult detects non-zero exit code", () => {
    expect(isFailedResult({ exitCode: 1, stopReason: "end" } as any)).toBe(true)
    expect(isFailedResult({ exitCode: 0, stopReason: "end" } as any)).toBe(false)
  })

  test("isFailedResult detects error stop reason", () => {
    expect(isFailedResult({ exitCode: 0, stopReason: "error" } as any)).toBe(true)
    expect(isFailedResult({ exitCode: 0, stopReason: "aborted" } as any)).toBe(true)
  })

  test("getResultOutput returns errorMessage for failures", () => {
    const result = {
      exitCode: 1,
      stopReason: "error",
      errorMessage: "Something went wrong",
      stderr: "stderr output",
      messages: [],
    } as any
    expect(getResultOutput(result)).toBe("Something went wrong")
  })

  test("getResultOutput falls back to stderr", () => {
    const result = {
      exitCode: 1,
      stopReason: "error",
      stderr: "stderr output",
      messages: [],
    } as any
    expect(getResultOutput(result)).toBe("stderr output")
  })

  test("getResultOutput returns final output for success", () => {
    const result = {
      exitCode: 0,
      stopReason: "end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "success!" }] }],
    } as any
    expect(getResultOutput(result)).toBe("success!")
  })

  test("truncateParallelOutput preserves small output", () => {
    const output = "short output"
    expect(truncateParallelOutput(output)).toBe(output)
  })

  test("truncateParallelOutput truncates large output", () => {
    const output = "x".repeat(60 * 1024)
    const truncated = truncateParallelOutput(output)
    expect(truncated.length).toBeLessThan(output.length)
    expect(truncated).toContain("[Output truncated:")
  })
})

describe("Upstream: concurrency control", () => {
  test("mapWithConcurrencyLimit preserves order", async () => {
    const items = [1, 2, 3, 4, 5]
    const results = await mapWithConcurrencyLimit(items, 2, async (item) => {
      await Bun.sleep(Math.random() * 50)
      return item * 2
    })
    expect(results).toEqual([2, 4, 6, 8, 10])
  })

  test("mapWithConcurrencyLimit respects concurrency limit", async () => {
    let active = 0
    let maxActive = 0
    const items = Array.from({ length: 10 }, (_, i) => i)
    await mapWithConcurrencyLimit(items, 3, async (item) => {
      active++
      maxActive = Math.max(maxActive, active)
      await Bun.sleep(20)
      active--
      return item
    })
    expect(maxActive).toBeLessThanOrEqual(3)
  })

  test("mapWithConcurrencyLimit handles empty array", async () => {
    const results = await mapWithConcurrencyLimit([], 4, async (x) => x)
    expect(results).toEqual([])
  })
})

describe("Upstream: getPiInvocation", () => {
  test("uses piExecutable when provided", () => {
    const result = getPiInvocation(["--mode", "json"], "bun /path/to/pi")
    expect(result.command).toBe("bun")
    expect(result.args).toEqual(["/path/to/pi", "--mode", "json"])
  })

  test("handles piExecutable with single word", () => {
    const result = getPiInvocation(["--mode", "json"], "pi")
    expect(result.command).toBe("pi")
    expect(result.args).toEqual(["--mode", "json"])
  })

  test("falls back to pi command for generic runtime", () => {
    // Can't fully test the fallback without mocking, but verify it doesn't crash
    const result = getPiInvocation(["--mode", "json"])
    expect(result.command).toBeDefined()
    expect(result.args).toContain("--mode")
    expect(result.args).toContain("json")
  })
})
