import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseService } from "../../src/db/index.ts"
import { Logger } from "../../src/logging/index.ts"
import { PermissionRepository } from "../../src/permission/index.ts"
import { SessionRepository } from "../../src/session/index.ts"

describe("PermissionRepository", () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  test("owns the pending, reply, and startup-recovery permission lifecycle", () => {
    const directory = mkdtempSync(join(tmpdir(), "permission-repository-"))
    directories.push(directory)
    const db = new DatabaseService(join(directory, "adaptor.db"), new Logger({ minLevel: "ERROR" }))
    const sessions = new SessionRepository(db)
    const permissions = new PermissionRepository(db)
    const session = sessions.create({ directory })

    const first = permissions.create({
      id: "per_first",
      sessionId: session.id,
      tool: "write",
      input: { resources: ["one.txt"] },
      createdAt: 10,
      expiresAt: 20,
    })
    expect(first.status).toBe("pending")
    expect(permissions.listPendingByDirectory(session.directory).map((row) => row.id)).toEqual(["per_first"])
    expect(permissions.listPendingBySession(session.id).map((row) => row.id)).toEqual(["per_first"])

    expect(permissions.resolve(first.id, "allow")).toBe(true)
    expect(permissions.resolve(first.id, "deny")).toBe(false)
    expect(permissions.get(first.id)?.status).toBe("allow")

    permissions.create({ id: "per_second", sessionId: session.id, tool: "bash", input: {} })
    expect(permissions.denyAllPending("Server restarted", 30)).toBe(1)
    expect(permissions.get("per_second")).toMatchObject({ status: "deny", respondedAt: 30 })
    db.close()
  })
})
