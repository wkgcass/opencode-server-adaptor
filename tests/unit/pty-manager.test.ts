import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PtyManager, type PtySocketData } from "../../src/api/pty-manager.ts"
import { EventBus } from "../../src/event/index.ts"
import { Logger } from "../../src/logging/index.ts"

const DIRECTORY = mkdtempSync(join(tmpdir(), "pty-idle-test-"))

function setup(idleTimeoutMs: number) {
  const logger = new Logger()
  const events = new EventBus(logger)
  // disablePtyTokenCheck = true so the WS harness can upgrade without a ticket
  const ptys = new PtyManager(events, logger, true, idleTimeoutMs)
  const server = Bun.serve<PtySocketData>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (req.method === "GET" && /^\/api\/pty\/[^/]+\/connect$/.test(url.pathname)) {
        return ptys.tryUpgrade(req, srv, url.searchParams.get("location[directory]") ?? DIRECTORY)
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open(s) {
        ptys.open(s)
      },
      message(s, m) {
        ptys.message(s, m)
      },
      close(s) {
        ptys.closeSocket(s)
      },
    },
  })
  return { ptys, events, server }
}

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.binaryType = "arraybuffer"
    ws.addEventListener("open", () => resolve(ws))
    ws.addEventListener("error", () => reject(new Error("websocket open failed")))
  })
}

describe("PtyManager idle reaping", () => {
  test("reaps a PTY with no subscriber after the idle timeout", async () => {
    const { ptys, events, server } = setup(250)
    const deleted: string[] = []
    events.subscribeInternal((e) => {
      if (e.type === "pty.deleted") deleted.push((e.properties as { id: string }).id)
    })
    try {
      const info = await ptys.create({ command: "bash", directory: DIRECTORY, cwd: DIRECTORY, title: "idle" })
      expect(ptys.get(info.id, DIRECTORY)).toBeDefined()
      await Bun.sleep(700) // well past the 250ms timeout + 50ms sweep
      expect(ptys.get(info.id, DIRECTORY)).toBeUndefined()
      expect(deleted).toContain(info.id)
    } finally {
      ptys.close()
      server.stop(true)
    }
  })

  test("does not reap a PTY while a client is subscribed", async () => {
    const { ptys, server } = setup(400)
    try {
      const info = await ptys.create({ command: "bash", directory: DIRECTORY, cwd: DIRECTORY, title: "live" })
      const wsUrl = `ws://localhost:${server.port}/api/pty/${info.id}/connect?location[directory]=${encodeURIComponent(DIRECTORY)}`
      const ws = await openWebSocket(wsUrl)
      await Bun.sleep(1000) // well past the 400ms timeout
      expect(ptys.get(info.id, DIRECTORY)?.status).toBe("running")
      ws.close()
    } finally {
      ptys.close()
      server.stop(true)
    }
  })

  test("reaps a PTY after the subscriber disconnects", async () => {
    const { ptys, server } = setup(400)
    try {
      const info = await ptys.create({ command: "bash", directory: DIRECTORY, cwd: DIRECTORY, title: "disc" })
      const wsUrl = `ws://localhost:${server.port}/api/pty/${info.id}/connect?location[directory]=${encodeURIComponent(DIRECTORY)}`
      const ws = await openWebSocket(wsUrl)
      await Bun.sleep(150) // subscribed, not idle
      ws.close()
      await Bun.sleep(200) // closeSocket registered idleSince; not yet reaped (< 400ms)
      expect(ptys.get(info.id, DIRECTORY)?.status).toBe("running")
      await Bun.sleep(600) // now past the idle timeout since disconnect
      expect(ptys.get(info.id, DIRECTORY)).toBeUndefined()
    } finally {
      ptys.close()
      server.stop(true)
    }
  })

  test("idle timeout disabled when idleTimeoutMs is 0", async () => {
    const { ptys, server } = setup(0)
    try {
      const info = await ptys.create({ command: "bash", directory: DIRECTORY, cwd: DIRECTORY, title: "forever" })
      await Bun.sleep(300)
      expect(ptys.get(info.id, DIRECTORY)?.status).toBe("running")
    } finally {
      ptys.close()
      server.stop(true)
    }
  })

  test("reaps an already-exited PTY session after the idle timeout", async () => {
    const { ptys, events, server } = setup(400)
    const deleted: string[] = []
    events.subscribeInternal((e) => {
      if (e.type === "pty.deleted") deleted.push((e.properties as { id: string }).id)
    })
    try {
      // A shell that exits immediately. The session record stays in memory as "exited".
      const info = await ptys.create({
        command: "bash",
        args: ["-c", "exit 0"],
        directory: DIRECTORY,
        cwd: DIRECTORY,
        title: "short-lived",
      })
      // Wait for the process to exit and the pty.exited event to be published.
      await Bun.sleep(150)
      expect(ptys.get(info.id, DIRECTORY)?.status).toBe("exited")
      // Not yet reaped (under the idle timeout).
      await Bun.sleep(150)
      expect(ptys.get(info.id, DIRECTORY)?.status).toBe("exited")
      // Past the idle timeout → the exited session record is removed.
      await Bun.sleep(400)
      expect(ptys.get(info.id, DIRECTORY)).toBeUndefined()
      expect(deleted).toContain(info.id)
    } finally {
      ptys.close()
      server.stop(true)
    }
  })
})
