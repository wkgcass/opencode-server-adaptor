import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseService } from "../../src/db/index.ts"
import { SessionEventStore } from "../../src/event/session-event-store.ts"
import { Logger } from "../../src/logging/index.ts"
import { SessionRepository } from "../../src/session/index.ts"

describe("SessionEventStore", () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("persists ordered durable events, paginates, and publishes live events", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-event-store-"))
    directories.push(directory)
    const databasePath = join(directory, "adaptor.db")
    const logger = new Logger({ minLevel: "ERROR" })
    const db = new DatabaseService(databasePath, logger)
    const sessions = new SessionRepository(db)
    const session = sessions.create({ directory })
    const store = new SessionEventStore(db, logger)
    const live: string[] = []
    const unsubscribe = store.subscribe(session.id, (event) => live.push(event.id))

    const first = store.append(
      session.id,
      "session.input.admitted",
      { sessionID: session.id, inputID: "msg_1", input: { type: "user", data: { text: "one" } } },
      { directory },
    )
    const second = store.append(
      session.id,
      "session.tool.success",
      { sessionID: session.id, assistantMessageID: "msg_2", callID: "call_1", content: [] },
      { directory },
      { version: 2 },
    )
    unsubscribe()

    expect(first.durable.seq).toBe(1)
    expect(second.durable.seq).toBe(2)
    expect(first.durable.version).toBe(1)
    expect(second.durable.version).toBe(2)
    expect(live).toEqual([first.id, second.id])
    expect(store.list(session.id, 0, 1)).toEqual({ events: [first], hasMore: true })
    db.close()

    const reopened = new DatabaseService(databasePath, logger)
    const restored = new SessionEventStore(reopened, logger).list(session.id, 1, 10)
    expect(restored.events).toEqual([second])
    expect(restored.hasMore).toBe(false)
    reopened.close()
  })
})
