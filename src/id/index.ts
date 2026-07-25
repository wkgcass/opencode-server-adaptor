import { randomBytes } from "node:crypto"

const PREFIXES = {
  session: "ses",
  message: "msg",
  part: "prt",
  event: "evt",
} as const

const RANDOM_LENGTH = 14
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

let lastTimestamp = 0
let counter = 0

function randomBase62(length: number): string {
  const bytes = randomBytes(length)
  let result = ""
  for (let index = 0; index < length; index++) {
    result += BASE62[bytes[index]! % BASE62.length]
  }
  return result
}

function ordered(prefix: string, direction: "ascending" | "descending", timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++

  let value = BigInt(timestamp) * 0x1000n + BigInt(counter)
  if (direction === "descending") value = ~value

  let encodedTime = ""
  for (let index = 0; index < 6; index++) {
    encodedTime += Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  }
  return `${prefix}_${encodedTime}${randomBase62(RANDOM_LENGTH)}`
}

export function createSessionId(timestamp?: number): string {
  return ordered(PREFIXES.session, "descending", timestamp)
}

export function createMessageId(timestamp?: number): string {
  return ordered(PREFIXES.message, "ascending", timestamp)
}

export function createMessageIdAfter(afterId: string): string {
  let timestamp = Date.now()
  let candidate = createMessageId(timestamp)
  if (!isOrderedId(afterId, "message") || candidate > afterId) return candidate

  // A client-generated parent can have a larger same-millisecond counter than
  // this process. Moving one millisecond forward guarantees the assistant ID
  // follows it without trying to decode the intentionally truncated time field.
  timestamp++
  candidate = createMessageId(timestamp)
  return candidate
}

export function createPartId(timestamp?: number): string {
  return ordered(PREFIXES.part, "ascending", timestamp)
}

export function createEventId(timestamp?: number): string {
  return ordered(PREFIXES.event, "ascending", timestamp)
}

export function isOrderedId(id: string, prefix: keyof typeof PREFIXES): boolean {
  const expectedPrefix = `${PREFIXES[prefix]}_`
  if (!id.startsWith(expectedPrefix) || id.length !== expectedPrefix.length + 26) return false
  return /^[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id.slice(expectedPrefix.length))
}
