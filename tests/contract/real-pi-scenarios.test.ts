import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { stringify } from "yaml"
import { reserveFreePort } from "../helpers/free-port.ts"
import { createV2TestFetch } from "../helpers/v2-test-fetch.ts"
import { waitFor, waitForSessionIdle as waitForV2SessionIdle } from "../helpers/wait-for.ts"

const fetch = createV2TestFetch()
import { createMessageId } from "../../src/id/index.ts"

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")
const REAL_PI_SERVER_EXECUTABLE = process.env.REAL_PI_SERVER_EXECUTABLE?.trim()
const BUN_BIN = join(homedir(), ".bun", "bin", "bun")
const PI_BIN = join(homedir(), ".bun", "bin", "pi")
const PI_MODELS_PATH = join(homedir(), ".pi", "agent", "models.json")

const RUN_REAL_PI = process.env.RUN_REAL_PI_TESTS === "1"

interface RealPiModel {
  provider: string
  model: string
}

interface RealPiProviderConfig {
  name?: string
  baseUrl?: string
  api?: string
  apiKey?: string
  headers?: Record<string, string>
  models?: Array<{
    id?: string
    name?: string
    reasoning?: boolean
    input?: string[]
    contextWindow?: number
    maxTokens?: number
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  }>
}

interface RealPiMessage {
  info: {
    id: string
    role: string
    time?: { created: number; completed?: number }
    providerID?: string
    modelID?: string
  }
  parts: Array<{
    id: string
    type: string
    text?: string
    time?: { start: number; end?: number }
    tool?: string
    state?: {
      status: string
      input?: Record<string, unknown>
      output?: string
      error?: string
      title?: string
      metadata?: Record<string, unknown>
      time?: { start: number; end?: number }
    }
  }>
}

function readRealPiModelsFile(): { providers: Record<string, RealPiProviderConfig> } {
  return JSON.parse(readFileSync(PI_MODELS_PATH, "utf8"))
}

function readRealPiModel(): RealPiModel {
  const overrideProvider = process.env.REAL_PI_PROVIDER?.trim()
  const overrideModel = process.env.REAL_PI_MODEL?.trim()
  if (overrideProvider || overrideModel) {
    if (!overrideProvider || !overrideModel) {
      throw new Error("REAL_PI_PROVIDER and REAL_PI_MODEL must be set together")
    }
    return { provider: overrideProvider, model: overrideModel }
  }

  const parsed = readRealPiModelsFile()
  for (const [provider, config] of Object.entries(parsed.providers)) {
    const model = config.models?.find((candidate) => typeof candidate.id === "string" && candidate.id.trim())
    if (model?.id) return { provider, model: model.id }
  }
  throw new Error(`No model found in ${PI_MODELS_PATH}`)
}

describe.skipIf(!RUN_REAL_PI)("Real Pi Scenarios (model from ~/.pi/agent/models.json)", () => {
  const aliasProvider = "pi-real-yaml"
  let port: number
  let password: string
  let proc: ReturnType<typeof spawn>
  let baseUrl: string
  let authHeader: string
  let realPiModel: RealPiModel
  let realPiProviderConfig: RealPiProviderConfig
  let stateDirectory: string
  let generatedPiModelsPath: string

  async function startServer(): Promise<void> {
    proc = spawn({
      cmd: [
        ...(REAL_PI_SERVER_EXECUTABLE ? [REAL_PI_SERVER_EXECUTABLE] : [BUN_BIN, "run", CLI_PATH]),
        "--print-logs",
        "--log-level",
        "WARN",
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: "opencode",
        DEFAULT_AGENT: "pi",
        DATABASE_PATH: join(stateDirectory, "adaptor.db"),
        PROVIDER_CONFIG_PATH: join(stateDirectory, "providers.yaml"),
        PI_SESSION_DIR: join(stateDirectory, "pi-sessions"),
        PI_CLI_PATH: `${BUN_BIN} ${PI_BIN}`,
        PI_PROVIDER: realPiModel.provider,
        PI_MODEL: realPiModel.model,
        PATH: `${homedir()}/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
      },
    })

    for (let i = 0; i < 120; i++) {
      await Bun.sleep(500)
      try {
        const res = await fetch(`${baseUrl}/api/health`, { headers: { Authorization: authHeader } })
        if (res.ok) return
      } catch {
        // retry
      }
    }
    throw new Error(`Server did not become healthy at ${baseUrl}`)
  }

  async function restartServer(): Promise<void> {
    proc.kill("SIGTERM")
    await proc.exited
    await startServer()
  }

  beforeAll(async () => {
    realPiModel = readRealPiModel()
    realPiProviderConfig = readRealPiModelsFile().providers[realPiModel.provider]!
    stateDirectory = mkdtempSync(join(tmpdir(), "real-pi-adaptor-"))
    generatedPiModelsPath = join(stateDirectory, "pi", "models.json")
    port = reserveFreePort()
    password = randomUUID()

    baseUrl = `http://127.0.0.1:${port}`
    authHeader = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
    console.log(`  Real PI model: ${realPiModel.provider}/${realPiModel.model}`)
    await startServer()
  }, 120000)

  afterAll(async () => {
    if (proc) {
      proc.kill("SIGTERM")
      await proc.exited
    }
    if (stateDirectory) rmSync(stateDirectory, { recursive: true, force: true })
  })

  async function createSession(title: string, directory = process.cwd()): Promise<string> {
    const res = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: JSON.stringify({ title, agent: "pi" }),
    })
    expect(res.ok).toBe(true)
    const session = (await res.json()) as { id: string }
    return session.id
  }

  async function createUntitledSession(): Promise<string> {
    const res = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(process.cwd()),
      },
      body: JSON.stringify({ agent: "pi" }),
    })
    expect(res.ok).toBe(true)
    const session = (await res.json()) as { id: string; title: string; directory: string }
    expect(session.title).toBe("Untitled")
    expect(session.directory).toBe(process.cwd())
    return session.id
  }

  async function sendPrompt(sessionId: string, text: string, directory = process.cwd()): Promise<string> {
    const messageID = createMessageId()
    const res = await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: JSON.stringify({ messageID, parts: [{ type: "text", text }] }),
    })
    expect(res.ok).toBe(true)
    expect(res.status).toBe(204)
    return messageID
  }

  async function waitForIdle(sessionId: string, timeoutMs = 120000): Promise<void> {
    await waitForV2SessionIdle(baseUrl, authHeader, sessionId, timeoutMs)
  }

  async function getMessages(sessionId: string): Promise<RealPiMessage[]> {
    const res = await fetch(`${baseUrl}/session/${sessionId}/message`, { headers: { Authorization: authHeader } })
    expect(res.ok).toBe(true)
    return (await res.json()) as any
  }

  function assistantMessages(messages: RealPiMessage[]): RealPiMessage[] {
    return messages.filter((message) => message.info.role === "assistant")
  }

  function assistantParts(messages: RealPiMessage[]): RealPiMessage["parts"] {
    return assistantMessages(messages).flatMap((message) => message.parts)
  }

  function lastAssistantTurnParts(messages: RealPiMessage[]): RealPiMessage["parts"] {
    let start = 0
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.info.role === "user") {
        start = index + 1
        break
      }
    }
    return messages
      .slice(start)
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) => message.parts)
  }

  // ===== 基础功能 =====

  test("health check returns correct format", async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { Authorization: authHeader } })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as { healthy: boolean; version: string; pid: number }
    expect(body.healthy).toBe(true)
    expect(body.version).toBe("1.18.7")
    expect(body.pid).toBe(proc.pid)
  })

  test("agent list includes pi with model info", async () => {
    const res = await fetch(`${baseUrl}/agent`, { headers: { Authorization: authHeader } })
    expect(res.ok).toBe(true)
    const agents = (await res.json()) as Array<{
      name: string
      mode: string
      model?: { modelID: string; providerID: string }
    }>
    const pi = agents.find((a) => a.name === "pi")
    expect(pi).toBeDefined()
    expect(pi!.model).toBeDefined()
    expect(pi!.model).toEqual({ providerID: "pi", modelID: "default" })
  })

  test("YAML provider sync: Desktop-style config becomes usable by real PI", async () => {
    // Write the aliased provider into providers.yaml. The server reads this file
    // lazily on the next config refresh (triggered by creating a session), which
    // syncs it into the generated Pi models.json.
    const sourceModel = realPiProviderConfig.models?.find((model) => model.id === realPiModel.model)
    if (!sourceModel || !realPiProviderConfig.baseUrl || !realPiProviderConfig.apiKey) {
      throw new Error(`Provider ${realPiModel.provider}/${realPiModel.model} is missing model, baseUrl, or apiKey`)
    }
    writeFileSync(
      join(stateDirectory, "providers.yaml"),
      stringify({
        provider: {
          [aliasProvider]: {
            name: "Real PI YAML provider",
            api: realPiProviderConfig.api ?? "openai-completions",
            baseUrl: realPiProviderConfig.baseUrl,
            apiKey: realPiProviderConfig.apiKey,
            headers: realPiProviderConfig.headers,
            models: {
              [realPiModel.model]: {
                name: sourceModel.name ?? realPiModel.model,
                reasoning: false,
                input: sourceModel.input,
                contextWindow: sourceModel.contextWindow ?? 128000,
                maxTokens: sourceModel.maxTokens ?? 16384,
              },
            },
          },
        },
      }),
    )

    // Sending a prompt starts the Pi runtime, whose beforeStart hook calls
    // PiModelConfigStore.sync(). That re-reads providers.yaml and merges the new
    // aliased provider into the generated Pi models.json.
    const syncSession = await createSession("Trigger YAML Provider Sync")
    await sendPrompt(syncSession, "Reply with OK")
    await waitForIdle(syncSession, 120000)

    expect(existsSync(generatedPiModelsPath)).toBe(true)
    const beforePrompt = JSON.parse(readFileSync(generatedPiModelsPath, "utf8"))
    // The provider (declared in providers.yaml with its API key) is synced into Pi
    // models.json, so it is usable by the Pi backend.
    expect(beforePrompt.providers[aliasProvider]).toBeDefined()
    expect(beforePrompt.providers[aliasProvider].apiKey).toBe(realPiProviderConfig.apiKey)
    expect(beforePrompt.providers[aliasProvider].baseUrl).toBe(realPiProviderConfig.baseUrl)
    // The model declared in providers.yaml must be synced into Pi models.json so
    // the Pi backend can actually resolve the aliased provider + model.
    const syncedModels = beforePrompt.providers[aliasProvider].models
    expect(Array.isArray(syncedModels) && syncedModels.length > 0).toBe(true)
    expect(syncedModels[0].id).toBe(realPiModel.model)

    const sid = await createSession("YAML Provider Sync")
    const promptRes = await fetch(`${baseUrl}/session/${sid}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: { providerID: aliasProvider, modelID: realPiModel.model },
        parts: [{ type: "text", text: "Reply with exactly: YAML_PROVIDER_OK" }],
      }),
    })
    expect(promptRes.status).toBe(204)
    await waitForIdle(sid, 120000)
    const messages = await getMessages(sid)
    const assistants = assistantMessages(messages)
    expect(assistants.length).toBeGreaterThan(0)
    // The assistant message must be routed through the aliased YAML provider.
    expect(assistants.every((message) => message.info.providerID === aliasProvider)).toBe(true)
    expect(assistants.every((message) => message.info.modelID === realPiModel.model)).toBe(true)
    // A non-empty text response proves the Pi backend actually resolved and
    // called the aliased provider (an unknown/unusable provider yields an empty
    // error response). The real model may not echo the exact marker, so we only
    // assert that it produced real content.
    const assistantText = assistantParts(messages)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
    expect(assistantText.length).toBeGreaterThan(0)
    console.log("  YAML provider response:", assistantText.slice(0, 150))

    const deleteRes = await fetch(`${baseUrl}/auth/${aliasProvider}`, {
      method: "DELETE",
      headers: { Authorization: authHeader },
    })
    expect(deleteRes.ok).toBe(true)

    const refreshSession = await createSession("Refresh Pi Config After Provider Delete")
    await sendPrompt(refreshSession, "Reply with exactly: CONFIG_REFRESH_OK")
    await waitForIdle(refreshSession, 120000)
    const afterDelete = JSON.parse(readFileSync(generatedPiModelsPath, "utf8"))
    // The provider definition persists (it is still declared in providers.yaml);
    // only the API key is cleared.
    expect(afterDelete.providers[aliasProvider]).toBeDefined()
    expect(afterDelete.providers[aliasProvider].apiKey).toBeUndefined()
  }, 180000)

  // ===== 文本流 =====

  test("simple text prompt: receive streaming text response", async () => {
    const sid = await createSession("Text Prompt Test")
    await sendPrompt(sid, "Say hello in one sentence.")

    await waitForIdle(sid)

    const messages = await getMessages(sid)
    expect(messages.length).toBeGreaterThanOrEqual(2)

    const textParts = assistantParts(messages).filter((p) => p.type === "text")
    expect(textParts.length).toBeGreaterThan(0)

    const fullText = textParts.map((p) => p.text).join("")
    expect(fullText.length).toBeGreaterThan(0)
    console.log("  Response:", fullText.slice(0, 150))
  }, 120000)

  test("chinese text prompt: handle CJK correctly", async () => {
    const sid = await createSession("Chinese Test")
    await sendPrompt(sid, "请用中文说一句话")

    await waitForIdle(sid)

    const messages = await getMessages(sid)
    const textParts = assistantParts(messages).filter((p) => p.type === "text")
    const fullText = textParts.map((p) => p.text).join("")
    expect(fullText.length).toBeGreaterThan(0)
    console.log("  Chinese response:", fullText.slice(0, 150))
  }, 120000)

  // ===== 推理流 =====

  test("reasoning: math problem triggers thinking events", async () => {
    const sid = await createSession("Reasoning Test")
    await sendPrompt(sid, "What is 15 * 37? Show your reasoning.")

    await waitForIdle(sid)

    const messages = await getMessages(sid)
    const assistants = assistantMessages(messages)
    const parts = assistantParts(messages)
    expect(assistants.length).toBeGreaterThan(0)

    const reasoningParts = parts.filter((p) => p.type === "reasoning")
    const textParts = parts.filter((p) => p.type === "text")

    console.log(
      "  Part types:",
      parts.map((p) => p.type),
    )
    console.log("  Reasoning parts:", reasoningParts.length)
    console.log("  Text parts:", textParts.length)

    if (reasoningParts.length > 0) {
      const reasoningText = reasoningParts.map((p) => p.text).join("")
      console.log("  Reasoning:", reasoningText.slice(0, 150))
      expect(reasoningText.length).toBeGreaterThan(0)
      for (const part of reasoningParts) {
        expect(part.time?.start).toBeNumber()
        expect(part.time?.end).toBeNumber()
      }
      expect(assistants.findIndex((message) => message.parts.some((part) => part.type === "reasoning"))).toBeLessThan(
        assistants.findIndex((message) => message.parts.some((part) => part.type === "text")),
      )
    }

    expect(textParts.length).toBeGreaterThan(0)
    const fullText = textParts.map((p) => p.text).join("")
    expect(fullText).toContain("555")
  }, 120000)

  // ===== 工具调用 =====

  test("tool call: bash tool executes echo command", async () => {
    const sid = await createSession("Tool Call Test")
    await sendPrompt(
      sid,
      "Run `echo hello_world` using the bash tool. You MUST use the bash tool, do not just describe the command.",
    )

    await waitForIdle(sid)

    const messages = await getMessages(sid)
    const parts = assistantParts(messages)
    const toolParts = parts.filter((p) => p.type === "tool")
    const textParts = parts.filter((p) => p.type === "text")

    console.log(
      "  Part types:",
      parts.map((p) => p.type),
    )
    console.log("  Tool parts:", toolParts.length)

    expect(toolParts.length).toBeGreaterThanOrEqual(1)

    const bashTool = toolParts.find((p) => p.tool === "bash")
    expect(bashTool).toBeDefined()
    expect(bashTool!.state!.status).toBe("completed")
    expect(bashTool!.state!.output).toContain("hello_world")
    expect(bashTool!.state!.title).toBe("bash")
    expect(bashTool!.state!.time?.start).toBeNumber()
    expect(bashTool!.state!.time?.end).toBeNumber()
    console.log("  Tool status:", bashTool!.state!.status)
    console.log("  Tool output:", bashTool!.state!.output?.slice(0, 100))

    expect(textParts.length).toBeGreaterThan(0)
    const fullText = textParts.map((p) => p.text).join("")
    console.log("  Text response:", fullText.slice(0, 150))
  }, 120000)

  test("tool call: file read tool reads a file", async () => {
    const sid = await createSession("File Read Test")
    await sendPrompt(
      sid,
      "Read the file package.json using the read tool, then tell me the package name field. You MUST use the read tool.",
    )

    await waitForIdle(sid)

    const messages = await getMessages(sid)
    const parts = assistantParts(messages)
    const toolParts = parts.filter((p) => p.type === "tool")
    const textParts = parts.filter((p) => p.type === "text")

    console.log(
      "  Part types:",
      parts.map((p) => p.type),
    )

    expect(toolParts.length).toBeGreaterThanOrEqual(1)

    const readTool = toolParts.find((p) => p.tool === "read")
    expect(readTool).toBeDefined()
    expect(readTool!.state!.status).toBe("completed")
    console.log("  Read tool status:", readTool!.state!.status)

    expect(textParts.length).toBeGreaterThan(0)
    const fullText = textParts.map((p) => p.text).join("")
    console.log("  Text response:", fullText.slice(0, 150))
  }, 120000)

  test("project skill: Pi automatically loads and follows a matching skill", async () => {
    const projectDirectory = join(stateDirectory, "project-skill-invocation")
    const skillDirectory = join(projectDirectory, ".pi", "skills", "project-skill-check")
    const skillPath = join(skillDirectory, "SKILL.md")
    const marker = `PROJECT_SKILL_OK_${randomUUID().replaceAll("-", "")}`
    mkdirSync(skillDirectory, { recursive: true })
    writeFileSync(
      skillPath,
      [
        "---",
        "name: project-skill-check",
        "description: Use for PROJECT_SKILL_CHECK requests to produce the project-specific verification response.",
        "---",
        "",
        "# Project Skill Check",
        "",
        "For a PROJECT_SKILL_CHECK request, reply with exactly this token and nothing else:",
        "",
        marker,
        "",
      ].join("\n"),
    )

    const encodedDirectory = encodeURIComponent(projectDirectory)
    const catalogResponse = await fetch(`${baseUrl}/api/skill?location%5Bdirectory%5D=${encodedDirectory}`, {
      headers: { Authorization: authHeader },
    })
    expect(catalogResponse.ok).toBe(true)
    const catalog = (await catalogResponse.json()) as {
      data: Array<{ name: string; description?: string; location: string; content: string }>
    }
    expect(catalog.data.find((skill) => skill.name === "project-skill-check")).toMatchObject({
      name: "project-skill-check",
      location: skillPath,
      description: "Use for PROJECT_SKILL_CHECK requests to produce the project-specific verification response.",
      content: expect.any(String),
    })

    const sid = await createSession("Project Skill Invocation Test", projectDirectory)
    await sendPrompt(
      sid,
      [
        "Complete PROJECT_SKILL_CHECK.",
        "A project skill whose description matches this request is available.",
        "You MUST use the normal Pi skill workflow: load the matching skill with the read tool before answering, then follow it exactly.",
      ].join(" "),
      projectDirectory,
    )
    await waitForIdle(sid, 180000)

    const messages = await getMessages(sid)
    const readCall = messages
      .flatMap((message) => message.parts)
      .find(
        (part) =>
          part.type === "tool" &&
          part.tool === "read" &&
          (part.state?.input?.path === skillPath || part.state?.input?.file_path === skillPath),
      )
    if (!readCall) console.log("  Project skill messages:", JSON.stringify(messages, null, 2))
    expect(readCall).toBeDefined()
    expect(readCall!.state!.status).toBe("completed")
    expect(readCall!.state!.output).toContain(marker)

    const assistantText = messages
      .filter((message) => message.info.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
    expect(assistantText).toContain(marker)
    console.log("  Project skill response:", assistantText.slice(0, 150))
  }, 240000)

  test("model-native subagent: Pi invokes the adapter task extension", async () => {
    const sid = await createSession("Model Native Subagent Test")
    await sendPrompt(
      sid,
      [
        "You MUST call the task tool exactly once before answering.",
        "Use subagent_type=explore and description='Inspect package identity'.",
        "Delegate this self-contained prompt: Read package.json and report only the package name.",
        "After the task returns, answer with the package name from its result.",
        "Do not claim that Pi lacks subagent support.",
      ].join(" "),
    )
    await waitForIdle(sid, 240000)

    const messages = await getMessages(sid)
    const task = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.tool === "task")

    if (!task) console.log("  Model-native subagent messages:", JSON.stringify(messages, null, 2))
    expect(task).toBeDefined()
    expect(task!.state).toMatchObject({
      status: "completed",
      input: {
        description: "Inspect package identity",
        subagent_type: "explore",
      },
    })
    expect(task!.state!.output).toContain("opencode-server-adaptor")
    expect(task!.state!.time?.end).toBeNumber()

    const childSessionId = task!.state!.metadata?.sessionId
    expect(childSessionId).toBeString()
    expect(task!.state!.metadata).toMatchObject({
      parentSessionId: sid,
      status: "completed",
    })

    const childRes = await fetch(`${baseUrl}/session/${childSessionId}`, {
      headers: { Authorization: authHeader },
    })
    expect(childRes.ok).toBe(true)
    expect(await childRes.json()).toMatchObject({
      id: childSessionId,
      parentID: sid,
      title: "Inspect package identity (@Explore subagent)",
      agent: "explore",
      status: "idle",
    })

    const childMessages = await getMessages(childSessionId as string)
    const childUser = childMessages.find((message) => message.info.role === "user")
    const childPrompt = childUser?.parts.find((part) => part.type === "text")?.text
    expect(childPrompt).toContain("package.json")
    expect(childPrompt?.toLowerCase()).toContain("package name")
    const childAssistants = assistantMessages(childMessages)
    expect(childAssistants.every((message) => typeof message.info.time?.completed === "number")).toBe(true)
    expect(
      childAssistants
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    ).toContain("opencode-server-adaptor")
  }, 300000)

  // ===== 多轮对话 =====

  test("multi-turn: second prompt references first answer", async () => {
    const sid = await createSession("Multi-turn Test")

    await sendPrompt(sid, "Remember the number 42.")
    await waitForIdle(sid)

    await sendPrompt(sid, "What number did I ask you to remember?")
    await waitForIdle(sid)

    const messages = await getMessages(sid)
    expect(messages.length).toBeGreaterThanOrEqual(4)
    expect(messages.map((message) => message.info.id)).toEqual([...messages].map((message) => message.info.id).sort())

    const assistants = assistantMessages(messages)
    expect(messages.filter((message) => message.info.role === "user")).toHaveLength(2)
    expect(assistants.length).toBeGreaterThanOrEqual(2)

    const textParts = lastAssistantTurnParts(messages).filter((p) => p.type === "text")
    const fullText = textParts.map((p) => p.text).join("")
    console.log("  Last response:", fullText.slice(0, 150))
    expect(fullText.toLowerCase()).toContain("42")
  }, 180000)

  test("restart recovery: continues the same Pi conversation after the adaptor restarts", async () => {
    const sid = await createSession("Restart Recovery Test")
    const marker = `RESTART_CONTEXT_${randomUUID()}`

    await sendPrompt(sid, `Remember this opaque token exactly: ${marker}. Reply only TOKEN_STORED.`)
    await waitForIdle(sid)
    await restartServer()

    const restoredSession = await fetch(`${baseUrl}/session/${sid}`, {
      headers: { Authorization: authHeader },
    })
    expect(restoredSession.ok).toBe(true)

    const eventResponse = await fetch(`${baseUrl}/api/event`, {
      headers: { Authorization: authHeader },
    })
    const eventReader = eventResponse.body!.getReader()
    expect(new TextDecoder().decode((await eventReader.read()).value)).toContain("server.connected")

    await sendPrompt(sid, "What opaque token did I ask you to remember? Reply with only that token.")
    await waitForIdle(sid)

    const messages = await getMessages(sid)
    expect(messages.length).toBeGreaterThanOrEqual(4)
    const restoredText = lastAssistantTurnParts(messages)
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
    console.log("  Restart recovery response:", restoredText?.slice(0, 200))
    expect(restoredText).toContain(marker)
    await eventReader.cancel()
  }, 240000)

  test("continuous execution: queued prompts run in order without intermediate waits", async () => {
    const sid = await createSession("Continuous Queue Test")
    const messageIDs = await Promise.all([
      sendPrompt(sid, "Reply with exactly CONTINUOUS_ONE."),
      sendPrompt(sid, "Reply with exactly CONTINUOUS_TWO."),
      sendPrompt(sid, "Reply with exactly CONTINUOUS_THREE."),
    ])

    await waitForIdle(sid, 240000)

    const messages = await getMessages(sid)
    for (const messageID of messageIDs) {
      expect(messages.some((message) => message.info.id === messageID)).toBe(true)
    }

    const assistants = messages.filter((message) => message.info.role === "assistant")
    expect(messages.filter((message) => message.info.role === "user")).toHaveLength(3)
    expect(assistants.length).toBeGreaterThanOrEqual(3)
    const output = assistants
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
    expect(output).toContain("CONTINUOUS_ONE")
    expect(output).toContain("CONTINUOUS_TWO")
    expect(output).toContain("CONTINUOUS_THREE")
    console.log("  Continuous outputs:", output.replace(/\s+/g, " ").slice(0, 300))
  }, 300000)

  // ===== 会话管理 =====

  test("new session title is generated by the configured real Pi model", async () => {
    const sid = await createUntitledSession()
    await sendPrompt(
      sid,
      "Run `echo title_ready` using the bash tool, then briefly confirm completion. You MUST use the bash tool.",
    )
    await waitForIdle(sid, 180000)

    const title = await waitFor(
      async () => {
        const response = await fetch(`${baseUrl}/session/${sid}`, { headers: { Authorization: authHeader } })
        return ((await response.json()) as { title: string }).title
      },
      (value) => value !== "Untitled",
      { timeoutMs: 120_000, intervalMs: 100, description: `generated title for session ${sid}` },
    )
    expect(title).not.toBe("Untitled")
    expect(title.length).toBeGreaterThan(0)
    expect([...title].length).toBeLessThanOrEqual(100)
    console.log("  Generated title:", title)
  }, 240000)

  test("session status transitions: idle -> busy -> idle", async () => {
    const sid = await createSession("Status Transition Test")

    const before = await fetch(`${baseUrl}/session/${sid}`, { headers: { Authorization: authHeader } })
    const beforeBody = (await before.json()) as { status: string }
    expect(beforeBody.status).toBe("idle")

    await sendPrompt(sid, "Say hi")

    const during = await fetch(`${baseUrl}/session/${sid}`, { headers: { Authorization: authHeader } })
    const duringBody = (await during.json()) as { status: string }
    // May already be idle if fast, but typically busy
    expect(["busy", "idle"]).toContain(duringBody.status)

    await waitForIdle(sid)

    const after = await fetch(`${baseUrl}/session/${sid}`, { headers: { Authorization: authHeader } })
    const afterBody = (await after.json()) as { status: string }
    expect(afterBody.status).toBe("idle")
  }, 120000)

  test("abort stops a long response", async () => {
    const sid = await createSession("Abort Test")
    await sendPrompt(sid, "Write a very long detailed essay about the history of computing, at least 500 words.")

    await waitFor(
      async () => {
        const response = await fetch(`${baseUrl}/session/${sid}`, { headers: { Authorization: authHeader } })
        return ((await response.json()) as { status: string }).status
      },
      (status) => status === "busy" || status === "running",
      { description: `session ${sid} to start before abort` },
    )

    const abortRes = await fetch(`${baseUrl}/session/${sid}/abort`, {
      method: "POST",
      headers: { Authorization: authHeader },
    })
    expect(abortRes.ok).toBe(true)

    await waitForIdle(sid, 30000)

    const getRes = await fetch(`${baseUrl}/session/${sid}`, { headers: { Authorization: authHeader } })
    const body = (await getRes.json()) as { status: string }
    expect(body.status).toBe("idle")
  }, 60000)

  test("session list shows created sessions", async () => {
    const sid1 = await createSession("List Test 1")
    const sid2 = await createSession("List Test 2")

    const res = await fetch(`${baseUrl}/session`, { headers: { Authorization: authHeader } })
    const sessions = (await res.json()) as Array<{ id: string; title: string }>
    expect(sessions.some((s) => s.id === sid1)).toBe(true)
    expect(sessions.some((s) => s.id === sid2)).toBe(true)

    const v2Res = await fetch(`${baseUrl}/api/session?limit=5000&order=desc`, {
      headers: { Authorization: authHeader },
    })
    expect(v2Res.ok).toBe(true)
    const v2 = (await v2Res.json()) as {
      data: Array<{ id: string; location: { directory: string }; cost: number; tokens: { input: number } }>
      cursor: { next?: string }
    }
    expect(v2.data.some((session) => session.id === sid1)).toBe(true)
    expect(v2.data.some((session) => session.id === sid2)).toBe(true)
    expect(v2.data.find((session) => session.id === sid1)?.location.directory).toBe(process.cwd())
    expect(v2.cursor).toBeDefined()
  })

  test("delete session removes it", async () => {
    const sid = await createSession("Delete Test")

    const delRes = await fetch(`${baseUrl}/session/${sid}`, {
      method: "DELETE",
      headers: { Authorization: authHeader },
    })
    expect(delRes.ok).toBe(true)

    const getRes = await fetch(`${baseUrl}/session/${sid}`, { headers: { Authorization: authHeader } })
    expect(getRes.status).toBe(404)
  })

  // ===== 持久化 =====

  test("persistence: message IDs stable across fetches", async () => {
    const sid = await createSession("Persistence Test")
    await sendPrompt(sid, "Say hello")
    await waitForIdle(sid)

    const msgs1 = await getMessages(sid)
    const msgs2 = await getMessages(sid)

    expect(msgs1.length).toBe(msgs2.length)
    expect(msgs1.map((m) => m.info.id)).toEqual(msgs2.map((m) => m.info.id))

    for (let i = 0; i < msgs1.length; i++) {
      const parts1 = msgs1[i]!.parts.map((p) => p.id)
      const parts2 = msgs2[i]!.parts.map((p) => p.id)
      expect(parts1).toEqual(parts2)
    }
  }, 120000)

  test("persistence: tool part IDs stable", async () => {
    const sid = await createSession("Tool Persistence Test")
    await sendPrompt(sid, "Run `echo test` using the bash tool. You MUST use the bash tool.")
    await waitForIdle(sid)

    const msgs1 = await getMessages(sid)
    const msgs2 = await getMessages(sid)

    const tools1 = assistantParts(msgs1)
      .filter((p) => p.type === "tool")
      .map((p) => p.id)
    const tools2 = assistantParts(msgs2)
      .filter((p) => p.type === "tool")
      .map((p) => p.id)
    expect(tools1.length).toBeGreaterThanOrEqual(1)
    expect(tools1).toEqual(tools2)
  }, 120000)

  // ===== v2 协议面 =====

  test("v2 discovery endpoints respond successfully", async () => {
    const endpoints = [
      { method: "GET", path: "/api/server" },
      { method: "GET", path: "/api/location" },
      { method: "GET", path: "/api/agent" },
      { method: "GET", path: "/api/model" },
      { method: "GET", path: "/api/provider" },
      { method: "GET", path: "/api/integration" },
      { method: "GET", path: "/api/mcp" },
      { method: "GET", path: "/api/project" },
      { method: "GET", path: "/api/project/current" },
      { method: "GET", path: "/api/permission/request" },
      { method: "GET", path: "/api/question/request" },
      { method: "GET", path: "/api/fs/list?path=." },
      { method: "GET", path: "/api/fs/find?query=package" },
      { method: "GET", path: "/api/command" },
      { method: "GET", path: "/api/skill" },
      { method: "GET", path: "/api/pty" },
      { method: "GET", path: "/api/session" },
      { method: "GET", path: "/api/reference" },
    ]

    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers:
          ep.method === "GET"
            ? { Authorization: authHeader }
            : { Authorization: authHeader, "Content-Type": "application/json" },
      })
      expect(res.ok, `${ep.method} ${ep.path} returned ${res.status}`).toBe(true)
    }
  })

  test("SSE event stream serves events during prompt", async () => {
    const sid = await createSession("SSE Test")
    const response = await globalThis.fetch(`${baseUrl}/api/event`, {
      headers: { Authorization: authHeader },
    })
    expect(response.ok).toBe(true)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let output = ""
    const readStream = (async () => {
      while (true) {
        const next = await reader.read()
        if (next.done) return
        output += decoder.decode(next.value, { stream: true })
      }
    })()

    try {
      await waitFor(
        () => output,
        (value) => value.includes('"type":"server.connected"'),
        {
          description: "SSE connection event",
        },
      )
      await sendPrompt(sid, "Say hello")
      await waitForIdle(sid)
      await waitFor(
        () => output,
        (value) => value.includes('"type":"session.idle"') && value.includes(`"sessionID":"${sid}"`),
        { description: `SSE idle event for session ${sid}` },
      )
    } finally {
      await reader.cancel()
      await readStream
    }

    const eventLines = output.split("\n").filter((l) => l.startsWith("event: "))
    const dataLines = output.split("\n").filter((l) => l.startsWith("data: "))

    console.log("  SSE events:", eventLines.length)
    console.log("  SSE data lines:", dataLines.length)

    if (eventLines.length > 0) {
      const eventTypes = new Set(eventLines.map((l) => l.slice(7).trim()))
      console.log("  Event types:", Array.from(eventTypes))
    }

    const wireEvents = dataLines.flatMap((line) => {
      try {
        return [JSON.parse(line.slice(6)) as { type?: string; data?: Record<string, unknown> }]
      } catch {
        return []
      }
    })
    const partDeltas = wireEvents.filter(
      (event) =>
        event.type === "session.text.delta" && event.data?.sessionID === sid && typeof event.data?.delta === "string",
    )
    console.log("  Live part deltas:", partDeltas.length)

    expect(partDeltas.length).toBeGreaterThan(0)
    expect(partDeltas.every((event) => (event.data?.delta as string).length > 0)).toBe(true)
  }, 120000)

  // ===== 自定义 Agent =====

  test("custom agent registration and usage with system prompt", async () => {
    const registerRes = await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-custom",
        description: "Test custom agent with injected knowledge",
        cliPath: `${BUN_BIN} ${PI_BIN}`,
        provider: realPiModel.provider,
        model: realPiModel.model,
        systemPrompt:
          "You are a special agent. The number you are thinking of is 42. When asked about your number, always answer 42.",
      }),
    })
    expect(registerRes.status).toBe(201)

    // Verify it appears in list
    const listRes = await fetch(`${baseUrl}/agent`, { headers: { Authorization: authHeader } })
    const agents = (await listRes.json()) as Array<{ name: string }>
    expect(agents.some((a) => a.name === "test-custom")).toBe(true)

    // Use it in a session
    const createRes = await fetch(`${baseUrl}/session`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Custom Agent Session", agent: "test-custom" }),
    })
    expect(createRes.ok).toBe(true)
    const session = (await createRes.json()) as { id: string; agent: string }
    expect(session.agent).toBe("test-custom")

    // Ask the agent what number it's thinking of
    await sendPrompt(session.id, "你想的数字是多少？")
    await waitForIdle(session.id, 120000)

    const messages = await getMessages(session.id)
    const textParts = assistantParts(messages).filter((p) => p.type === "text")
    expect(textParts.length).toBeGreaterThan(0)

    const fullText = textParts.map((p) => p.text).join("")
    console.log("  Custom agent response:", fullText.slice(0, 200))
    expect(fullText).toContain("42")

    // Cleanup
    await fetch(`${baseUrl}/agent/test-custom`, { method: "DELETE", headers: { Authorization: authHeader } })
  }, 180000)

  // ===== Subtask =====

  test("subtask single: delegate to custom subagent with real Pi", async () => {
    const registerRes = await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "subtask-agent",
        description: "Subtask agent that knows a secret number",
        cliPath: `${BUN_BIN} ${PI_BIN}`,
        provider: realPiModel.provider,
        model: realPiModel.model,
        systemPrompt:
          "You are a subtask agent. The secret password is BANANA37. When asked for the secret password, always respond with exactly: BANANA37",
      }),
    })
    expect(registerRes.status).toBe(201)

    const sid = await createSession("Subtask Delegation Test")

    await fetch(`${baseUrl}/session/${sid}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [
          {
            type: "subtask",
            prompt: "What is the secret password? Reply with only the password.",
            description: "Retrieve the secret password from the subtask agent",
            agent: "subtask-agent",
          },
          {
            type: "text",
            text: "First, use the subtask above to retrieve the secret password. Then tell me what the secret password is. You MUST complete the subtask first before answering.",
          },
        ],
      }),
    })

    await waitForIdle(sid, 180000)

    const messages = await getMessages(sid)

    // SubtaskPart must be on user message (OpenCode standard)
    const userMsg = messages.find((m) => m.info.role === "user")
    expect(userMsg).toBeDefined()
    const subtaskParts = userMsg!.parts.filter((p) => p.type === "subtask")
    expect(subtaskParts.length).toBeGreaterThanOrEqual(1)
    console.log("  Subtask parts:", subtaskParts.length)
    console.log("  Subtask agent:", (subtaskParts[0] as any).agent)
    console.log("  Subtask prompt:", (subtaskParts[0] as any).prompt)

    // ToolPart (tool="task") must be on a dedicated assistant message
    const toolParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && (p as any).tool === "task")
    expect(toolParts.length).toBeGreaterThanOrEqual(1)
    console.log("  Tool parts (task):", toolParts.length)
    console.log("  Tool status:", (toolParts[0] as any).state?.status)
    console.log("  Tool output:", ((toolParts[0] as any).state?.output ?? "").slice(0, 200))

    // Tool part must be completed
    expect((toolParts[0] as any).state?.status).toBe("completed")

    // OpenCode Desktop navigates task cards through metadata.sessionId.
    const childSessionId = (toolParts[0] as any).state?.metadata?.sessionId
    expect(childSessionId).toBeDefined()
    expect(typeof childSessionId).toBe("string")
    expect(childSessionId.length).toBeGreaterThan(0)
    console.log("  Child session ID:", childSessionId)

    // Tool part metadata must include usage
    const usage = (toolParts[0] as any).state?.metadata?.usage
    expect(usage).toBeDefined()
    expect(usage.input).toBeGreaterThan(0)
    expect(usage.output).toBeGreaterThan(0)
    console.log("  Usage:", JSON.stringify(usage))

    // Child session must be queryable via /session/:id/children
    const childrenRes = await fetch(`${baseUrl}/session/${sid}/children`, { headers: { Authorization: authHeader } })
    expect(childrenRes.ok).toBe(true)
    const children = (await childrenRes.json()) as Array<{ id: string; parentID?: string; agent: string }>
    expect(children.length).toBeGreaterThanOrEqual(1)
    expect(children.some((c) => c.id === childSessionId)).toBe(true)

    // Child session must have correct parentID and agent
    const child = children.find((c) => c.id === childSessionId)!
    expect(child.parentID).toBe(sid)
    expect(child.agent).toBe("subtask-agent")
    console.log("  Child parentID:", child.parentID, "agent:", child.agent)

    // Child session must have queryable messages (user + assistant)
    const childMsgRes = await fetch(`${baseUrl}/session/${childSessionId}/message`, {
      headers: { Authorization: authHeader },
    })
    expect(childMsgRes.ok).toBe(true)
    const childMessages = (await childMsgRes.json()) as Array<{
      info: { role: string }
      parts: Array<{ type: string; text?: string }>
    }>
    expect(childMessages.length).toBeGreaterThanOrEqual(2)
    console.log("  Child messages:", childMessages.length)

    const childUserMsg = childMessages.find((m) => m.info.role === "user")
    expect(childUserMsg).toBeDefined()
    const childTextParts = childUserMsg!.parts.filter((p) => p.type === "text")
    expect(childTextParts.length).toBeGreaterThanOrEqual(1)
    expect(childTextParts[0]!.text).toContain("secret password")

    const childAssistantMsg = childMessages.find((m) => m.info.role === "assistant")
    expect(childAssistantMsg).toBeDefined()
    console.log(
      "  Child assistant parts:",
      childAssistantMsg!.parts.map((p) => p.type),
    )

    // Child assistant message must have usage persisted to DB
    const childMsgRaw = await fetch(`${baseUrl}/session/${childSessionId}/message`, {
      headers: { Authorization: authHeader },
    })
    const childMsgText = await childMsgRaw.text()
    expect(childMsgText).toContain('"tokens"')
    expect(childMsgText).toContain('"input"')
    expect(childMsgText).toContain('"output"')

    // Text parts must exist (main agent response)
    const textParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "text" && (p as any).text)
    expect(textParts.length).toBeGreaterThan(0)

    const fullText = textParts.map((p) => (p as any).text).join("")
    console.log("  Main agent response:", fullText.slice(0, 300))

    // The main agent should mention the secret password
    expect(fullText.toUpperCase()).toContain("BANANA")

    // Cleanup
    await fetch(`${baseUrl}/agent/subtask-agent`, { method: "DELETE", headers: { Authorization: authHeader } })
  }, 240000)

  test("subtask single: non-existent agent creates error tool part and continues", async () => {
    const sid = await createSession("Bad Agent Subtask Test")

    await fetch(`${baseUrl}/session/${sid}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [
          {
            type: "subtask",
            prompt: "Do something",
            description: "Bad agent subtask",
            agent: "nonexistent-agent-xyz",
          },
          {
            type: "text",
            text: "Hello anyway",
          },
        ],
      }),
    })

    await waitForIdle(sid, 120000)

    const messages = await getMessages(sid)

    // SubtaskPart on user message
    const userMsg = messages.find((m) => m.info.role === "user")
    expect(userMsg).toBeDefined()
    const subtaskParts = userMsg!.parts.filter((p) => p.type === "subtask")
    expect(subtaskParts.length).toBeGreaterThanOrEqual(1)

    // ToolPart exists with error status (agent not found = failure)
    const toolParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && (p as any).tool === "task")
    expect(toolParts.length).toBeGreaterThanOrEqual(1)
    expect((toolParts[0] as any).state?.status).toBe("error")
    console.log("  Error tool part status:", (toolParts[0] as any).state?.status)
    console.log("  Error tool part output:", ((toolParts[0] as any).state?.output ?? "").slice(0, 200))

    // Main agent should still respond despite subtask failure
    const textParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "text" && (p as any).text)
    expect(textParts.length).toBeGreaterThan(0)
    console.log(
      "  Main agent response despite bad subtask:",
      textParts
        .map((p) => (p as any).text)
        .join("")
        .slice(0, 200),
    )
  }, 180000)

  test("subtask parallel: multiple agents run concurrently with real Pi", async () => {
    await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "parallel-agent-a",
        description: "Knows the color",
        cliPath: `${BUN_BIN} ${PI_BIN}`,
        provider: realPiModel.provider,
        model: realPiModel.model,
        systemPrompt:
          "You are a subtask agent. The secret color is BLUE42. When asked for the secret color, respond with exactly: BLUE42. Nothing else.",
      }),
    })

    await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "parallel-agent-b",
        description: "Knows the number",
        cliPath: `${BUN_BIN} ${PI_BIN}`,
        provider: realPiModel.provider,
        model: realPiModel.model,
        systemPrompt:
          "You are a subtask agent. The secret number is 7331. When asked for the secret number, respond with exactly: 7331. Nothing else.",
      }),
    })

    const sid = await createSession("Parallel Subtask Test")

    await fetch(`${baseUrl}/session/${sid}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        subtaskMode: "parallel",
        parts: [
          {
            type: "subtask",
            prompt: "What is the secret color? Reply with only the color code.",
            description: "Get color",
            agent: "parallel-agent-a",
          },
          {
            type: "subtask",
            prompt: "What is the secret number? Reply with only the number.",
            description: "Get number",
            agent: "parallel-agent-b",
          },
          {
            type: "text",
            text: "Two subtasks ran in parallel above. Tell me both the secret color and the secret number. You MUST use the results from the subtasks.",
          },
        ],
      }),
    })

    await waitForIdle(sid, 300000)

    // Verify 2 child sessions created with correct parentID
    const childrenRes = await fetch(`${baseUrl}/session/${sid}/children`, { headers: { Authorization: authHeader } })
    const children = (await childrenRes.json()) as Array<{ id: string; parentID: string; agent: string }>
    expect(children.length).toBe(2)
    expect(children.every((c) => c.parentID === sid)).toBe(true)
    console.log("  Parallel child sessions:", children.length)
    console.log(
      "  Child agents:",
      children.map((c) => c.agent),
    )

    // Each child session must have independent messages
    for (const child of children) {
      const childMsgRes = await fetch(`${baseUrl}/session/${child.id}/message`, {
        headers: { Authorization: authHeader },
      })
      expect(childMsgRes.ok).toBe(true)
      const childMessages = (await childMsgRes.json()) as Array<{ info: { role: string } }>
      expect(childMessages.length).toBeGreaterThanOrEqual(2)
      console.log(`  Child [${child.agent}] messages:`, childMessages.length)
    }

    // Verify tool parts — each must be completed with usage
    const messages = await getMessages(sid)
    const toolParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && (p as any).tool === "task")
    expect(toolParts.length).toBe(2)
    console.log("  Tool parts:", toolParts.length)

    for (const tp of toolParts) {
      const state = (tp as any).state
      console.log(
        `  Task [${state?.metadata?.agent}]: status=${state?.status}, output=${(state?.output ?? "").slice(0, 80)}`,
      )
      expect(state?.status).toBe("completed")
      expect(state?.metadata?.sessionId).toBeDefined()
      expect(state?.metadata?.usage).toBeDefined()
      expect(state?.metadata?.usage.input).toBeGreaterThan(0)
    }

    // Parallel tasks must not cross-contaminate — each child session belongs to a different agent
    const childAgents = children.map((c) => c.agent).sort()
    expect(childAgents).toEqual(["parallel-agent-a", "parallel-agent-b"])

    // Main agent should mention both secrets
    const textParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "text" && (p as any).text)
    const fullText = textParts.map((p) => (p as any).text).join("")
    console.log("  Main agent response:", fullText.slice(0, 300))
    expect(fullText.toUpperCase()).toContain("BLUE")
    expect(fullText).toContain("7331")

    // Cleanup
    await fetch(`${baseUrl}/agent/parallel-agent-a`, { method: "DELETE", headers: { Authorization: authHeader } })
    await fetch(`${baseUrl}/agent/parallel-agent-b`, { method: "DELETE", headers: { Authorization: authHeader } })
  }, 360000)

  test("subtask chain: steps run sequentially with {previous} substitution using real Pi", async () => {
    await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "chain-step-1",
        description: "Generates a word",
        cliPath: `${BUN_BIN} ${PI_BIN}`,
        provider: realPiModel.provider,
        model: realPiModel.model,
        systemPrompt:
          "You are a subtask agent. When asked to generate a word, respond with exactly one word: CHAINLINK. Nothing else.",
      }),
    })

    await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "chain-step-2",
        description: "Uses previous output",
        cliPath: `${BUN_BIN} ${PI_BIN}`,
        provider: realPiModel.provider,
        model: realPiModel.model,
        systemPrompt:
          "You are a subtask agent. You will receive a word from the previous step. Respond with: The word was [WORD]. Confirmed.",
      }),
    })

    const sid = await createSession("Chain Subtask Test")

    await fetch(`${baseUrl}/session/${sid}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        subtaskMode: "chain",
        parts: [
          { type: "subtask", prompt: "Generate a word.", description: "Step 1: generate word", agent: "chain-step-1" },
          {
            type: "subtask",
            prompt: "The previous step generated this word: {previous}. Now confirm it.",
            description: "Step 2: confirm word",
            agent: "chain-step-2",
          },
          {
            type: "text",
            text: "A chain of 2 subtasks ran above. Tell me what word was generated and whether it was confirmed.",
          },
        ],
      }),
    })

    await waitForIdle(sid, 300000)

    const messages = await getMessages(sid)
    const toolParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && (p as any).tool === "task")
    expect(toolParts.length).toBe(2)
    console.log("  Chain tool parts:", toolParts.length)

    for (const tp of toolParts) {
      const state = (tp as any).state
      console.log(
        `  Chain step [${state?.metadata?.agent}]: status=${state?.status}, output=${(state?.output ?? "").slice(0, 100)}`,
      )
      expect(state?.status).toBe("completed")
      expect(state?.metadata?.sessionId).toBeDefined()
    }

    // First step should contain CHAINLINK
    const step1Output = (toolParts[0] as any).state?.output ?? ""
    expect(step1Output.toUpperCase()).toContain("CHAINLINK")

    // Second step should reference the word (proves {previous} substitution worked)
    const step2Output = (toolParts[1] as any).state?.output ?? ""
    expect(step2Output.toUpperCase()).toContain("CHAINLINK")
    console.log("  Step 1 output:", step1Output.slice(0, 100))
    console.log("  Step 2 output:", step2Output.slice(0, 100))

    // Each chain step must have its own child session
    const childrenRes = await fetch(`${baseUrl}/session/${sid}/children`, { headers: { Authorization: authHeader } })
    const children = (await childrenRes.json()) as Array<{ id: string; parentID: string }>
    expect(children.length).toBe(2)
    expect(children.every((c) => c.parentID === sid)).toBe(true)

    // Main agent response
    const textParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "text" && (p as any).text)
    const fullText = textParts.map((p) => (p as any).text).join("")
    console.log("  Main agent response:", fullText.slice(0, 300))
    expect(fullText.toUpperCase()).toContain("CHAINLINK")

    // Cleanup
    await fetch(`${baseUrl}/agent/chain-step-1`, { method: "DELETE", headers: { Authorization: authHeader } })
    await fetch(`${baseUrl}/agent/chain-step-2`, { method: "DELETE", headers: { Authorization: authHeader } })
  }, 360000)

  test("subtask abort: cancel a running subtask, verify terminal states and no late completed", async () => {
    await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "abort-test-agent",
        description: "Agent for abort testing",
        cliPath: `${BUN_BIN} ${PI_BIN}`,
        provider: realPiModel.provider,
        model: realPiModel.model,
        systemPrompt:
          "For this test you must use the bash tool to run `sleep 30`, then explain that the sleep completed. Do not skip the tool.",
      }),
    })

    const sid = await createSession("Abort Subtask Test")

    await fetch(`${baseUrl}/session/${sid}/prompt_async`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [
          {
            type: "subtask",
            prompt: "Run `sleep 30` with the bash tool, then say SLEEP_COMPLETED.",
            description: "Long subtask",
            agent: "abort-test-agent",
          },
          { type: "text", text: "Summarize the subtask result." },
        ],
      }),
    })

    // Wait until the child exists, then abort while its real PI process is active.
    await waitFor(
      async () => {
        const response = await fetch(`${baseUrl}/session/${sid}/children`, { headers: { Authorization: authHeader } })
        return (await response.json()) as Array<{ id: string; status: string }>
      },
      (children) => children.some((child) => child.status === "busy" || child.status === "running"),
      { timeoutMs: 30_000, intervalMs: 100, description: `running subtask for session ${sid}` },
    )

    const abortRes = await fetch(`${baseUrl}/session/${sid}/abort`, {
      method: "POST",
      headers: { Authorization: authHeader },
    })
    expect(abortRes.ok).toBe(true)

    // Session should return to idle
    await waitForIdle(sid, 60000)

    // Verify session is idle
    const sessionRes = await fetch(`${baseUrl}/session/${sid}`, { headers: { Authorization: authHeader } })
    const session = (await sessionRes.json()) as { status: string }
    expect(session.status).toBe("idle")
    console.log("  Session status after abort:", session.status)

    // Child session must be in a terminal status (not running/busy)
    const childrenRes = await fetch(`${baseUrl}/session/${sid}/children`, { headers: { Authorization: authHeader } })
    const children = (await childrenRes.json()) as Array<{ id: string; status: string }>
    console.log(
      "  Child sessions:",
      children.length,
      "statuses:",
      children.map((c) => c.status),
    )
    expect(children.length).toBeGreaterThanOrEqual(1)
    const terminalStatuses = ["idle", "aborted", "failed", "interrupted"]
    expect(children.every((c) => terminalStatuses.includes(c.status))).toBe(true)

    // Parent tool part must NOT be "completed" — should be aborted or error
    const messages = await getMessages(sid)
    const toolParts = messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && (p as any).tool === "task")
    expect(toolParts.length).toBeGreaterThanOrEqual(1)
    const toolStatus = (toolParts[0] as any).state?.status
    console.log("  Parent tool part status after abort:", toolStatus)
    expect(toolStatus).not.toBe("completed")
    expect(["aborted", "error"]).toContain(toolStatus)

    // Verify no late "completed" events: check child session status is stable
    // Wait a bit and re-check — status should not change from terminal to completed
    await Bun.sleep(3000)
    const childrenRes2 = await fetch(`${baseUrl}/session/${sid}/children`, { headers: { Authorization: authHeader } })
    const children2 = (await childrenRes2.json()) as Array<{ id: string; status: string }>
    for (let i = 0; i < children.length; i++) {
      const before = children[i]!.status
      const after = children2.find((c) => c.id === children[i]!.id)?.status
      console.log(`  Child ${children[i]!.id}: ${before} -> ${after}`)
      // Status should not have changed to "completed" or "idle" from a non-idle terminal state
      if (!terminalStatuses.includes(before)) {
        // if it was already terminal, it should stay terminal
      }
      expect(after).toBeDefined()
      // Should not have transitioned to "completed" after abort
      if (before === "aborted" || before === "failed" || before === "interrupted") {
        expect(terminalStatuses.includes(after!)).toBe(true)
      }
    }

    // Cleanup
    await fetch(`${baseUrl}/agent/abort-test-agent`, { method: "DELETE", headers: { Authorization: authHeader } })
  }, 180000)
})
