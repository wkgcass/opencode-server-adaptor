import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseService } from "../../src/db/index.ts"
import { Logger } from "../../src/logging/index.ts"

describe("session schema", () => {
  const cleanup: string[] = []

  afterEach(() => {
    for (const directory of cleanup.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("creates only the database tables used by the runtime", () => {
    const directory = mkdtempSync(join(tmpdir(), "session-schema-"))
    cleanup.push(directory)
    const db = new DatabaseService(join(directory, "adaptor.db"), new Logger({ minLevel: "ERROR" }))

    const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).not.toContain("agent_session_reference")
    expect(tables.map((table) => table.name).sort()).toEqual([
      "messages",
      "parts",
      "permissions",
      "session_events",
      "sessions",
    ])

    db.close()
  })
})
