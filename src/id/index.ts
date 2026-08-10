import { randomBytes } from "node:crypto"

const PREFIXES = {
  session: "ses",
  message: "msg",
  part: "prt",
  event: "evt",
} as const

const RANDOM_LENGTH = 14
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const WIDE_TIMESTAMP_BITS = 44n
const WIDE_COUNTER_BITS = 12n
const WIDE_COUNTER_SCALE = 1n << WIDE_COUNTER_BITS
const WIDE_COUNTER_MAX = WIDE_COUNTER_SCALE - 1n
const WIDE_TIMESTAMP_MAX = (1n << WIDE_TIMESTAMP_BITS) - 1n
const WIDE_SORT_HEX_LENGTH = 14
const WIDE_SORT_MAX = (1n << (WIDE_TIMESTAMP_BITS + WIDE_COUNTER_BITS)) - 1n
const WIDE_SEPARATOR = "-"

export type OrderedIdFormat = "legacy" | "wide"

let lastTimestamp = 0
let counter = 0
let lastWideTimestamp = 0n
let wideCounter = 0n

function randomBase62(length: number): string {
  const bytes = randomBytes(length)
  let result = ""
  for (let index = 0; index < length; index++) {
    result += BASE62[bytes[index]! % BASE62.length]
  }
  return result
}

function encodeHex(value: bigint, bytes: number): string {
  let encoded = ""
  for (let index = 0; index < bytes; index++) {
    encoded += Number((value >> BigInt(8 * (bytes - index - 1))) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  }
  return encoded
}

function legacyOrdered(prefix: string, direction: "ascending" | "descending", timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++

  let value = BigInt(timestamp) * 0x1000n + BigInt(counter)
  if (direction === "descending") value = ~value
  return `${prefix}_${encodeHex(value, 6)}${randomBase62(RANDOM_LENGTH)}`
}

function wideOrdered(
  prefix: string,
  direction: "ascending" | "descending",
  timestamp = Date.now(),
  minimumExclusive?: bigint,
): string {
  const requested = BigInt(timestamp)
  let logicalTimestamp: bigint
  let nextCounter: bigint

  if (requested > lastWideTimestamp) {
    logicalTimestamp = requested
    nextCounter = 1n
  } else {
    logicalTimestamp = lastWideTimestamp
    nextCounter = wideCounter + 1n
  }

  if (nextCounter > WIDE_COUNTER_MAX) {
    logicalTimestamp++
    nextCounter = 0n
  }

  let value = logicalTimestamp * WIDE_COUNTER_SCALE + nextCounter
  if (minimumExclusive !== undefined && value <= minimumExclusive) {
    logicalTimestamp = minimumExclusive >> WIDE_COUNTER_BITS
    nextCounter = (minimumExclusive & WIDE_COUNTER_MAX) + 1n
    if (nextCounter > WIDE_COUNTER_MAX) {
      logicalTimestamp++
      nextCounter = 0n
    }
    value = logicalTimestamp * WIDE_COUNTER_SCALE + nextCounter
  }

  if (logicalTimestamp > WIDE_TIMESTAMP_MAX) throw new Error("Wide ordered ID timestamp exceeds 44-bit range")
  lastWideTimestamp = logicalTimestamp
  wideCounter = nextCounter

  const sortable = direction === "descending" ? WIDE_SORT_MAX ^ value : value
  return `${prefix}${WIDE_SEPARATOR}${sortable.toString(16).padStart(WIDE_SORT_HEX_LENGTH, "0")}${randomBase62(RANDOM_LENGTH)}`
}

function ordered(
  prefix: string,
  direction: "ascending" | "descending",
  timestamp = Date.now(),
  format: OrderedIdFormat = "legacy",
): string {
  return format === "wide" ? wideOrdered(prefix, direction, timestamp) : legacyOrdered(prefix, direction, timestamp)
}

function wideSortableValue(id: string, prefix: string): bigint | undefined {
  const marker = `${prefix}${WIDE_SEPARATOR}`
  if (!id.startsWith(marker)) return undefined
  const body = id.slice(marker.length)
  if (!/^[0-9a-f]{14}[0-9A-Za-z]{14}$/.test(body)) return undefined
  const encoded = body.slice(0, WIDE_SORT_HEX_LENGTH)
  return BigInt(`0x${encoded}`)
}

/** Advance the process-local wide timestamp/counter past an accepted external ID. */
export function observeOrderedId(id: string): void {
  for (const prefix of [PREFIXES.message, PREFIXES.part, PREFIXES.event]) {
    const value = wideSortableValue(id, prefix)
    if (value === undefined) continue
    const observedTimestamp = value >> WIDE_COUNTER_BITS
    const observedCounter = value & WIDE_COUNTER_MAX
    const currentValue = lastWideTimestamp * WIDE_COUNTER_SCALE + wideCounter
    if (value > currentValue) {
      lastWideTimestamp = observedTimestamp
      wideCounter = observedCounter
    }
  }
}

export function createSessionId(timestamp?: number): string {
  return ordered(PREFIXES.session, "descending", timestamp)
}

export function createMessageId(timestamp?: number, format: OrderedIdFormat = "legacy"): string {
  return ordered(PREFIXES.message, "ascending", timestamp, format)
}

export function createMessageIdAfter(afterId: string, format: OrderedIdFormat = orderedIdFormat(afterId)): string {
  if (format === "wide") {
    const after = wideSortableValue(afterId, PREFIXES.message)
    return wideOrdered(PREFIXES.message, "ascending", Date.now(), after)
  }

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

export function createPartId(timestamp?: number, format: OrderedIdFormat = "legacy"): string {
  return ordered(PREFIXES.part, "ascending", timestamp, format)
}

export function createEventId(timestamp?: number, format: OrderedIdFormat = "legacy"): string {
  return ordered(PREFIXES.event, "ascending", timestamp, format)
}

export function orderedIdFormat(id: string | undefined): OrderedIdFormat {
  if (!id) return "legacy"
  return [PREFIXES.message, PREFIXES.part, PREFIXES.event].some((prefix) =>
    id.startsWith(`${prefix}${WIDE_SEPARATOR}`),
  )
    ? "wide"
    : "legacy"
}

export function isOrderedId(id: string, prefix: keyof typeof PREFIXES): boolean {
  const valuePrefix = PREFIXES[prefix]
  const legacyMarker = `${valuePrefix}_`
  if (id.startsWith(legacyMarker)) {
    const body = id.slice(legacyMarker.length)
    return /^[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(body)
  }

  const wideMarker = `${valuePrefix}${WIDE_SEPARATOR}`
  return id.startsWith(wideMarker) && /^[0-9a-f]{14}[0-9A-Za-z]{14}$/.test(id.slice(wideMarker.length))
}
