import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseService } from "../../src/db/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { MessageRepository } from "../../src/message/index.ts"
import { SessionRepository } from "../../src/session/index.ts"

describe("compaction message projection", () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  test("persists the marker, summary, and visible assistant message across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "compaction-message-"))
    directories.push(directory)
    const databasePath = join(directory, "adaptor.db")
    const logger = new Logger({ minLevel: "ERROR" })
    const db = new DatabaseService(databasePath, logger)
    const sessions = new SessionRepository(db)
    const session = sessions.create({
      directory,
      agent: "pi",
      model: { providerID: "test", id: "model" },
    })
    const messages = new MessageRepository(db, sessions)

    const started = messages.startCompactionProjection({
      sessionId: session.id,
      agent: "pi",
      model: { providerID: "test", modelID: "model" },
      reason: "manual",
    })
    const completed = messages.completeCompactionProjection(started.compaction.id, {
      summary: "Saved compaction summary",
      usage: { input: 10, output: 4, total: 14, cost: 0.01 },
    })
    expect(completed?.assistant.parentID).toBe(started.synthetic.id)
    db.close()

    const reopened = new DatabaseService(databasePath, logger)
    const restored = new MessageRepository(reopened).listMessages(session.id)
    expect(restored.map((message) => message.info.role)).toEqual(["synthetic", "compaction", "assistant"])
    expect(restored[1]?.info).toMatchObject({
      role: "compaction",
      status: "completed",
      reason: "manual",
      summary: "Saved compaction summary",
    })
    expect(restored[2]?.parts).toEqual([expect.objectContaining({ type: "text", text: "Saved compaction summary" })])
    expect(restored[2]?.info).toMatchObject({
      role: "assistant",
      mode: "compaction",
      metadata: { compaction: { messageID: started.compaction.id } },
    })
    expect(restored[2]?.parts[0]).toMatchObject({
      metadata: { compaction: { messageID: started.compaction.id } },
    })
    reopened.close()
  })
})
