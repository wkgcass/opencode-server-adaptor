import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { loadConfig } from "../../src/config/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { createServerContext } from "../../src/server.ts"

describe("startup recovery", () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("does not leave an orphaned parent session permanently busy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "startup-recovery-"))
    directories.push(directory)
    const databasePath = join(directory, "adaptor.db")
    const config = {
      ...loadConfig(),
      databasePath,
      piAgentDir: dirname(databasePath),
      piSessionDir: join(directory, "pi-sessions"),
    }
    const logger = new Logger({ minLevel: "ERROR" })

    const first = createServerContext(config, logger)
    const session = first.sessions.create({ directory, agent: "pi" })
    const user = first.messages.createUserMessage(session.id, "pi")
    const assistant = first.messages.createAssistantMessage(session.id, user.id, "pi")
    first.messages.createPart(session.id, assistant.id, "reasoning", {
      text: "partial reasoning",
      time: { start: Date.now() },
    })
    first.messages.createPart(session.id, assistant.id, "tool", {
      callID: "call_restart",
      tool: "bash",
      state: {
        status: "running",
        input: { command: "printf completed-before-restart" },
        metadata: { partialOutput: "completed-before-restart" },
        time: { start: Date.now() },
      },
    })
    const completedUser = first.messages.createUserMessage(session.id, "pi")
    const completedAssistant = first.messages.createAssistantMessage(session.id, completedUser.id, "pi")
    first.messages.createPart(session.id, completedAssistant.id, "tool", {
      callID: "call_legacy_completed_message",
      tool: "read",
      state: {
        status: "running",
        input: { path: join(directory, "package.json"), filePath: join(directory, "package.json") },
        time: { start: Date.now() },
      },
    })
    // Simulate the inconsistent shape written by an older adapter: the
    // assistant message ended but its tool part never received a terminal event.
    first.db.prepare("UPDATE messages SET completed_at = ? WHERE id = ?").run(Date.now(), completedAssistant.id)
    first.sessions.setStatus(session.id, "busy")
    first.db
      .prepare(
        "INSERT INTO permissions (id, session_id, tool, input, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
      )
      .run("perm_restart", session.id, "extension", "{}", Date.now(), Date.now() + 60_000)
    await first.agentService.closeAll()
    first.events.close()
    first.db.close()

    const recovered = createServerContext(config, logger)
    try {
      expect(recovered.sessions.get(session.id)?.status).toBe("idle")
      const message = recovered.messages.getMessage(assistant.id)
      expect(message?.role).toBe("assistant")
      if (!message || message.role !== "assistant") throw new Error("Expected recovered assistant message")
      expect(message.time.completed).toBeNumber()
      expect(message.error?.data.message).toContain("server restarted")
      const parts = recovered.messages.listParts(assistant.id)
      const reasoning = parts.find((part) => part.type === "reasoning")
      expect(reasoning?.type === "reasoning" ? reasoning.time?.end : undefined).toBeNumber()
      const tool = parts.find((part) => part.type === "tool")
      expect(tool?.type === "tool" ? tool.state : undefined).toMatchObject({
        status: "error",
        input: { command: "printf completed-before-restart" },
        metadata: { recovered: true },
      })
      expect(tool?.type === "tool" ? tool.state.time?.end : undefined).toBeNumber()
      const legacyTool = recovered.messages.listParts(completedAssistant.id).find((part) => part.type === "tool")
      expect(legacyTool?.type === "tool" ? legacyTool.state : undefined).toMatchObject({
        status: "error",
        input: { filePath: join(directory, "package.json") },
        metadata: { recovered: true },
      })
      expect(legacyTool?.type === "tool" ? legacyTool.state.time?.end : undefined).toBeNumber()
      const permission = recovered.db
        .prepare("SELECT status, responded_at FROM permissions WHERE id = ?")
        .get("perm_restart") as { status: string; responded_at: number | null }
      expect(permission.status).toBe("deny")
      expect(permission.responded_at).toBeNumber()
    } finally {
      await recovered.agentService.closeAll()
      recovered.events.close()
      recovered.db.close()
    }
  })
})
