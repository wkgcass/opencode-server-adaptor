import { describe, expect, test } from "bun:test"
import {
  createMessageId,
  createMessageIdAfter,
  createEventId,
  createPartId,
  createSessionId,
  isOrderedId,
} from "../../src/id/index.ts"

describe("OpenCode-compatible ordered identifiers", () => {
  test("message and part IDs sort in creation order within one millisecond", () => {
    const timestamp = 1_750_000_000_000
    const message = [createMessageId(timestamp), createMessageId(timestamp), createMessageId(timestamp)]
    const parts = [createPartId(timestamp), createPartId(timestamp), createPartId(timestamp)]

    expect([...message].sort()).toEqual(message)
    expect([...parts].sort()).toEqual(parts)
    expect(message.every((id) => isOrderedId(id, "message"))).toBe(true)
    expect(parts.every((id) => isOrderedId(id, "part"))).toBe(true)
    expect(createMessageIdAfter(message.at(-1)!) > message.at(-1)!).toBe(true)
  })

  test("descending session IDs put newer sessions first", () => {
    const older = createSessionId(1_750_000_000_000)
    const newer = createSessionId(1_750_000_000_001)

    expect([older, newer].sort()).toEqual([newer, older])
    expect(isOrderedId(older, "session")).toBe(true)
    expect(isOrderedId("sess_1234567890abcdef12345678", "session")).toBe(false)
  })

  test("wide IDs pack a 44-bit timestamp and 12-bit counter across same-time generation and clock rollback", () => {
    const timestamp = Date.now() + 1_000_000
    const ids = [
      createMessageId(timestamp, "wide"),
      createPartId(timestamp, "wide"),
      createEventId(timestamp - 1_000, "wide"),
      createMessageId(timestamp - 2_000, "wide"),
    ]

    expect(ids[0]).toMatch(/^msg_-[0-9a-f]{14}[0-9A-Za-z]{14}$/)
    expect(ids[1]).toMatch(/^prt_-[0-9a-f]{14}[0-9A-Za-z]{14}$/)
    expect(ids[2]).toMatch(/^evt_-[0-9a-f]{14}[0-9A-Za-z]{14}$/)

    const values = ids.map((id) => BigInt(`0x${id.slice(5, 19)}`))
    expect(values.map((value) => value >> 12n)).toEqual(Array(4).fill(BigInt(timestamp)))
    expect(values.map((value) => value & 0xfffn)).toEqual([1n, 2n, 3n, 4n])
    expect(values).toEqual([...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)))
    expect(isOrderedId(ids[0]!, "message")).toBe(true)
    expect(isOrderedId(ids[1]!, "part")).toBe(true)
    expect(isOrderedId(ids[2]!, "event")).toBe(true)
  })

  test("wide assistant IDs advance past a wide parent ID", () => {
    const parent = createMessageId(1_760_000_000_000, "wide")
    const assistant = createMessageIdAfter(parent, "wide")

    expect(assistant.startsWith("msg_-")).toBe(true)
    expect(assistant > parent).toBe(true)
  })

  test("wide IDs carry into the logical millisecond after the 12-bit counter is exhausted", () => {
    const timestamp = Date.now() + 2_000_000
    const ids = Array.from({ length: 4_095 }, () => createMessageId(timestamp, "wide"))
    const carried = createMessageId(timestamp, "wide")
    const afterCarry = createMessageId(timestamp, "wide")
    const firstValue = BigInt(`0x${ids[0]!.slice(5, 19)}`)
    const lastValue = BigInt(`0x${ids.at(-1)!.slice(5, 19)}`)
    const carriedValue = BigInt(`0x${carried.slice(5, 19)}`)
    const afterCarryValue = BigInt(`0x${afterCarry.slice(5, 19)}`)

    expect(firstValue).toBe(BigInt(timestamp) * 4_096n + 1n)
    expect(firstValue >> 12n).toBe(BigInt(timestamp))
    expect(firstValue & 0xfffn).toBe(1n)
    expect(lastValue & 0xfffn).toBe(0xfffn)
    expect(carriedValue >> 12n).toBe(BigInt(timestamp + 1))
    expect(carriedValue & 0xfffn).toBe(0n)
    expect(carriedValue).toBe(lastValue + 1n)
    expect(afterCarryValue).toBe(carriedValue + 1n)
  })
})
