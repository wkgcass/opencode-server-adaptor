import { describe, expect, test } from "bun:test"
import { SessionQueue } from "../../src/runtime/session-queue.ts"

describe("SessionQueue", () => {
  test("serializes one session and releases its bookkeeping", async () => {
    const queue = new SessionQueue()
    const order: string[] = []
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })

    const first = queue.run("session-1", async () => {
      order.push("first:start")
      await firstGate
      order.push("first:end")
    })
    const second = queue.run("session-1", async () => {
      order.push("second:start")
      await secondGate
      order.push("second:end")
    })

    await Bun.sleep(5)
    expect(order).toEqual(["first:start"])
    expect(queue.hasPending("session-1")).toBe(true)
    expect(queue.pendingCount("session-1")).toBe(2)

    releaseFirst()
    await first
    expect(queue.pendingCount("session-1")).toBe(1)
    await Bun.sleep(0)
    expect(order).toEqual(["first:start", "first:end", "second:start"])
    releaseSecond()
    await second
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"])
    expect(queue.hasPending("session-1")).toBe(false)
    expect(queue.pendingCount("session-1")).toBe(0)
  })

  test("a failed operation does not poison later work", async () => {
    const queue = new SessionQueue()
    const failed = queue.run("session-1", async () => {
      throw new Error("expected")
    })
    const next = queue.run("session-1", async () => 42)

    await expect(failed).rejects.toThrow("expected")
    expect(await next).toBe(42)
    expect(queue.hasPending("session-1")).toBe(false)
  })

  test("different sessions run independently", async () => {
    const queue = new SessionQueue()
    let secondRan = false
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = queue.run("session-1", () => gate)
    await queue.run("session-2", async () => {
      secondRan = true
    })
    expect(secondRan).toBe(true)
    releaseFirst()
    await first
  })
})
