import { describe, expect, test } from "bun:test"
import { AssistantPartProjector } from "../../src/agents/assistant-part-projector.ts"
import { DatabaseService } from "../../src/db/index.ts"
import { EventBus } from "../../src/event/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { MessageRepository } from "../../src/message/index.ts"
import { SessionRepository } from "../../src/session/index.ts"

describe("assistant part projector", () => {
  test("groups consecutive part types into sibling messages by default", () => {
    const logger = new Logger({ minLevel: "ERROR" })
    const db = new DatabaseService(":memory:", logger)
    const sessions = new SessionRepository(db)
    const messages = new MessageRepository(db, sessions)
    const events = new EventBus(logger)
    const projector = new AssistantPartProjector(messages)

    try {
      const session = sessions.create({ directory: process.cwd(), agent: "test" })
      const user = messages.createUserMessage(session.id, "test")
      const assistant = messages.createAssistantMessage(session.id, user.id, "test")

      projector.createPart(session.id, assistant.id, "text", { text: "first" })
      projector.createPart(session.id, assistant.id, "text", { text: "second" })
      projector.createPart(session.id, assistant.id, "reasoning", { text: "thinking" })
      projector.complete(assistant.id, "stop")

      const projected = messages.listMessages(session.id).filter((message) => message.info.role === "assistant")
      expect(projected.map((message) => message.parts.map((part) => part.type))).toEqual([
        ["text", "text"],
        ["reasoning"],
      ])
      expect(projected.map((message) => (message.info.role === "assistant" ? message.info.finish : undefined))).toEqual(
        [undefined, "stop"],
      )
    } finally {
      db.close()
    }
  })
})
