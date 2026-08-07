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

  test("removes an exited PTY session immediately and publishes pty.exited once", async () => {
    const { ptys, events, server } = setup(400)
    const exited: string[] = []
    const deleted: string[] = []
    events.subscribeInternal((e) => {
      if (e.type === "pty.exited") exited.push((e.properties as { id: string }).id)
      if (e.type === "pty.deleted") deleted.push((e.properties as { id: string }).id)
    })
    try {
      // A shell that exits immediately.
      const info = await ptys.create({
        command: "bash",
        args: ["-c", "exit 0"],
        directory: DIRECTORY,
        cwd: DIRECTORY,
        title: "short-lived",
      })
      // Wait for the process to exit and onExit to run.
      await Bun.sleep(150)
      // The session record is gone immediately (GET /api/pty/:id would 404),
      // so the OpenCode client's reconnect check gives up instead of looping.
      expect(ptys.get(info.id, DIRECTORY)).toBeUndefined()
      // pty.exited published exactly once; no retransmission, no pty.deleted
      // (that event is only for explicit DELETE).
      expect(exited.filter((id) => id === info.id).length).toBe(1)
      expect(deleted).not.toContain(info.id)
    } finally {
      ptys.close()
      server.stop(true)
    }
  })
})

describe("PtyManager exit signaling", () => {
  test("arms 404, publishes pty.exited, then closes the subscribed WebSocket with 1000", async () => {
    const { ptys, events, server } = setup(0)
    const exited: string[] = []
    events.subscribeInternal((e) => {
      if (e.type === "pty.exited") exited.push((e.properties as { id: string }).id)
    })
    try {
      // A shell that stays alive long enough for a client to subscribe, then
      // exits on its own.
      const info = await ptys.create({
        command: "bash",
        args: ["-c", "sleep 0.3; exit 0"],
        directory: DIRECTORY,
        cwd: DIRECTORY,
        title: "subscribed-exit",
      })
      const wsUrl = `ws://localhost:${server.port}/api/pty/${info.id}/connect?location[directory]=${encodeURIComponent(DIRECTORY)}`
      const ws = await openWebSocket(wsUrl)

      // Wait for the shell to exit; the server closes the WebSocket.
      const closeEvent = await new Promise<CloseEvent>((resolve) => {
        ws.addEventListener("close", (ev) => resolve(ev as CloseEvent))
      })
      // Closed with 1000 so the client does not reconnect.
      expect(closeEvent.code).toBe(1000)
      // The session record is already gone (GET would 404), so even if the
      // close had been non-1000 the client's reconnect check would give up.
      expect(ptys.get(info.id, DIRECTORY)).toBeUndefined()
      // pty.exited published exactly once (no retransmission).
      expect(exited.filter((id) => id === info.id).length).toBe(1)
    } finally {
      ptys.close()
      server.stop(true)
    }
  })

  test("a reconnect attempt to an exited PTY sees 404 (no reconnect loop)", async () => {
    const { ptys, server } = setup(0)
    try {
      const info = await ptys.create({
        command: "bash",
        args: ["-c", "exit 0"],
        directory: DIRECTORY,
        cwd: DIRECTORY,
        title: "gone",
      })
      await Bun.sleep(150) // let it exit and be removed
      expect(ptys.get(info.id, DIRECTORY)).toBeUndefined()

      // A WebSocket connect to the now-deleted session fails the upgrade with
      // 404 (session not found). The client sees an abnormal close, checks
      // GET for 404, and gives up instead of looping.
      const wsUrl = `ws://localhost:${server.port}/api/pty/${info.id}/connect?location[directory]=${encodeURIComponent(DIRECTORY)}`
      const closeEvent = await new Promise<CloseEvent>((resolve) => {
        const ws = new WebSocket(wsUrl)
        ws.binaryType = "arraybuffer"
        ws.addEventListener("close", (ev) => resolve(ev as CloseEvent))
        ws.addEventListener("error", () => {
          /* close will follow */
        })
      })
      // Upgrade rejected → abnormal close (1006), never 1000. The point is
      // that GET is 404 so the client stops here.
      expect(closeEvent.code).not.toBe(1000)
    } finally {
      ptys.close()
      server.stop(true)
    }
  })
})
