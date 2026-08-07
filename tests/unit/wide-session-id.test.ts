import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseService } from "../../src/db/index.ts"
import { createEvent, EventBus } from "../../src/event/index.ts"
import { SessionEventStore } from "../../src/event/session-event-store.ts"
import { createMessageId } from "../../src/id/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { MessageRepository } from "../../src/message/index.ts"
import { SessionRepository } from "../../src/session/index.ts"

describe("session-scoped wide ordered IDs", () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  test("persists the policy and applies it to messages, parts, events, and child sessions", () => {
    const directory = mkdtempSync(join(tmpdir(), "wide-session-id-"))
    directories.push(directory)
    const databasePath = join(directory, "adaptor.db")
    const logger = new Logger({ minLevel: "ERROR" })
    const db = new DatabaseService(databasePath, logger)
    const sessions = new SessionRepository(db)
    const messages = new MessageRepository(db, sessions)
    const parent = sessions.create({ directory })
    expect(parent.id.startsWith("ses_")).toBe(true)

    const clientMessageId = createMessageId(undefined, "wide")
    expect(sessions.enableWideIds(parent.id)).toBe(true)
    const user = messages.createUserMessage(parent.id, "pi", undefined, clientMessageId)
    const userPart = messages.createPart(parent.id, user.id, "text", {
      text: "wide",
      time: { start: Date.now() },
    })
    const assistant = messages.createAssistantMessage(parent.id, user.id, "pi")
    const assistantPart = messages.createPart(parent.id, assistant.id, "text", {
      text: "response",
      time: { start: Date.now() },
    })

    expect(user.id).toBe(clientMessageId)
    expect(assistant.id).toMatch(/^msg_-[0-9a-f]{14}[0-9A-Za-z]{14}$/)
    expect(assistant.id > user.id).toBe(true)
    expect(userPart.id).toMatch(/^prt_-[0-9a-f]{14}[0-9A-Za-z]{14}$/)
    expect(assistantPart.id).toMatch(/^prt_-[0-9a-f]{14}[0-9A-Za-z]{14}$/)

    const durable = new SessionEventStore(db, logger, sessions).append(parent.id, "session.next.prompted", {})
    expect(durable.id).toMatch(/^evt_-[0-9a-f]{14}[0-9A-Za-z]{14}$/)

    let liveEventId = ""
    const events = new EventBus(logger, undefined, (event) => {
      const sessionID = (event.properties as { sessionID?: string }).sessionID
      return sessionID ? sessions.getIdFormat(sessionID) : "legacy"
    })
    events.subscribeInternal((event) => (liveEventId = event.id))
    events.publish(createEvent("message.updated", { sessionID: parent.id, info: assistant }))
    expect(liveEventId).toMatch(/^evt_-[0-9a-f]{14}[0-9A-Za-z]{14}$/)

    const child = sessions.create({
      directory,
      parentId: parent.id,
      idFormat: sessions.getIdFormat(parent.id),
    })
    expect(messages.createUserMessage(child.id, "pi").id.startsWith("msg_-")).toBe(true)
    db.close()

    const reopened = new DatabaseService(databasePath, logger)
    const reopenedSessions = new SessionRepository(reopened)
    const reopenedMessages = new MessageRepository(reopened, reopenedSessions)
    expect(reopenedSessions.getIdFormat(parent.id)).toBe("wide")
    expect(reopenedSessions.getIdFormat(child.id)).toBe("wide")
    expect(reopenedMessages.createUserMessage(parent.id, "pi").id.startsWith("msg_-")).toBe(true)
    reopened.close()
  })

  test("legacy sessions keep legacy identifiers", () => {
    const directory = mkdtempSync(join(tmpdir(), "legacy-session-id-"))
    directories.push(directory)
    const logger = new Logger({ minLevel: "ERROR" })
    const db = new DatabaseService(join(directory, "adaptor.db"), logger)
    const sessions = new SessionRepository(db)
    const messages = new MessageRepository(db, sessions)
    const session = sessions.create({ directory })
    const user = messages.createUserMessage(session.id, "pi")
    const part = messages.createPart(session.id, user.id, "text", { text: "legacy", time: { start: Date.now() } })

    expect(user.id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(part.id).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    db.close()
  })

  test("caches routing fields together and keeps them consistent through updates and recursive deletion", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-routing-cache-"))
    const movedDirectory = join(directory, "moved")
    directories.push(directory)
    const logger = new Logger({ minLevel: "ERROR" })
    const db = new DatabaseService(join(directory, "adaptor.db"), logger)
    const sessions = new SessionRepository(db)
    const parent = sessions.create({ directory })
    const child = sessions.create({ directory, parentId: parent.id })

    const coldRepository = new SessionRepository(db)
    const prepare = spyOn(db, "prepare")
    const before = prepare.mock.calls.length
    expect(coldRepository.getDirectory(parent.id)).toBe(directory)
    const afterFirstRead = prepare.mock.calls.length
    expect(afterFirstRead).toBe(before + 1)
    expect(coldRepository.getIdFormat(parent.id)).toBe("legacy")
    expect(coldRepository.getDirectory(parent.id)).toBe(directory)
    expect(prepare.mock.calls.length).toBe(afterFirstRead)
    prepare.mockRestore()

    sessions.update(parent.id, { directory: movedDirectory })
    expect(sessions.getDirectory(parent.id)).toBe(movedDirectory)
    expect(sessions.enableWideIds(parent.id)).toBe(true)
    expect(sessions.getRoutingContext(parent.id)).toEqual({ directory: movedDirectory, idFormat: "wide" })

    expect(sessions.delete(parent.id)).toBe(true)
    expect(sessions.getRoutingContext(parent.id)).toBeNull()
    expect(sessions.getRoutingContext(child.id)).toBeNull()
    db.close()
  })
})
