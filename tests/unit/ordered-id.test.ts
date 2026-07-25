import { describe, expect, test } from "bun:test"
import {
  createMessageId,
  createMessageIdAfter,
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
})
