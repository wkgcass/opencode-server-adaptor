import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseService } from "../../src/db/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { MessageRepository } from "../../src/message/index.ts"
import { SessionRepository } from "../../src/session/index.ts"

describe("tool part finalization", () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function createRepositories() {
    const directory = mkdtempSync(join(tmpdir(), "message-finalization-"))
    directories.push(directory)
    const logger = new Logger()
    const db = new DatabaseService(join(directory, "adaptor.db"), logger)
    const sessions = new SessionRepository(db)
    const messages = new MessageRepository(db)
    const session = sessions.create({ directory, agent: "pi" })
    const user = messages.createUserMessage(session.id, "pi")
    const assistant = messages.createAssistantMessage(session.id, user.id, "pi")
    return { db, messages, session, assistant }
  }

  test("completing a message does not overwrite an aborted tool part", () => {
    const { db, messages, session, assistant } = createRepositories()
    try {
      const part = messages.createPart(session.id, assistant.id, "tool", {
        callID: "call_aborted",
        tool: "task",
        state: {
          status: "aborted",
          input: { description: "Long task" },
          error: "Delegated task was aborted",
          time: { start: Date.now(), end: Date.now() },
        },
      })

      messages.completeMessage(assistant.id, "error")

      const persisted = messages.getPart(part.id)
      expect(persisted?.type).toBe("tool")
      if (persisted?.type !== "tool") throw new Error("Expected a tool part")
      expect(persisted.state.status).toBe("aborted")
      expect(persisted.state.error).toBe("Delegated task was aborted")
    } finally {
      db.close()
    }
  })

  test("startup recovery ignores an already-aborted tool part", () => {
    const { db, messages, session, assistant } = createRepositories()
    try {
      const part = messages.createPart(session.id, assistant.id, "tool", {
        callID: "call_aborted",
        tool: "task",
        state: {
          status: "aborted",
          input: { description: "Long task" },
          error: "Delegated task was aborted",
          time: { start: Date.now(), end: Date.now() },
        },
      })

      expect(messages.recoverOpenToolParts("Server restarted")).toBe(0)

      const persisted = messages.getPart(part.id)
      expect(persisted?.type).toBe("tool")
      if (persisted?.type !== "tool") throw new Error("Expected a tool part")
      expect(persisted.state.status).toBe("aborted")
      expect(persisted.state.error).toBe("Delegated task was aborted")
    } finally {
      db.close()
    }
  })
})
