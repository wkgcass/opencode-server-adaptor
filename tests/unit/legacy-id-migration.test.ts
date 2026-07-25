import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseService } from "../../src/db/index.ts"
import { isOrderedId } from "../../src/id/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { MessageRepository } from "../../src/message/index.ts"
import { SessionRepository } from "../../src/session/index.ts"

describe("legacy identifier migration", () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("rewrites a whole affected session and preserves message/part order and references", () => {
    const directory = mkdtempSync(join(tmpdir(), "legacy-id-migration-"))
    directories.push(directory)
    const databasePath = join(directory, "adaptor.db")
    const logger = new Logger({ minLevel: "ERROR" })

    const initial = new DatabaseService(databasePath, logger)
    const session = new SessionRepository(initial).create({ directory })
    const created = 1_750_000_000_000
    const legacyUser = "msg_aaaaaaaaaaaaaaaaaaaaaaaa"
    const legacyAssistant = "msg_bbbbbbbbbbbbbbbbbbbbbbbb"
    initial
      .prepare(
        `INSERT INTO messages
       (id, session_id, role, created_at, completed_at, parent_id, model_id, provider_id, agent, data)
       VALUES (?, ?, 'user', ?, NULL, NULL, 'model', 'provider', 'pi', '{}')`,
      )
      .run(legacyUser, session.id, created)
    initial
      .prepare(
        `INSERT INTO messages
       (id, session_id, role, created_at, completed_at, parent_id, model_id, provider_id, agent, data)
       VALUES (?, ?, 'assistant', ?, ?, ?, 'model', 'provider', 'pi', '{}')`,
      )
      .run(legacyAssistant, session.id, created, created + 10, legacyUser)

    // Deliberately choose legacy IDs whose lexical order is the reverse of insertion order.
    initial
      .prepare(
        "INSERT INTO parts (id, session_id, message_id, type, data, created_at) VALUES (?, ?, ?, 'reasoning', ?, ?)",
      )
      .run("prt_ffffffffffffffffffffffff", session.id, legacyAssistant, JSON.stringify({ text: "thought" }), created)
    initial
      .prepare("INSERT INTO parts (id, session_id, message_id, type, data, created_at) VALUES (?, ?, ?, 'text', ?, ?)")
      .run("prt_000000000000000000000000", session.id, legacyAssistant, JSON.stringify({ text: "answer" }), created)
    initial.close()

    const migrated = new DatabaseService(databasePath, logger)
    const messages = new MessageRepository(migrated).listMessages(session.id)
    expect(messages.map((message) => message.info.role)).toEqual(["user", "assistant"])
    expect(messages.map((message) => message.info.id).every((id) => isOrderedId(id, "message"))).toBe(true)

    const assistant = messages[1]!
    expect(assistant.info.role).toBe("assistant")
    if (assistant.info.role !== "assistant") throw new Error("Expected assistant message")
    expect(assistant.info.parentID).toBe(messages[0]!.info.id)
    expect(assistant.parts.map((part) => part.type)).toEqual(["reasoning", "text"])
    expect(assistant.parts.map((part) => part.id).every((id) => isOrderedId(id, "part"))).toBe(true)
    expect(assistant.parts[0]!.type === "reasoning" ? assistant.parts[0]!.time : undefined).toEqual({
      start: created,
    })
    migrated.close()
  })
})
