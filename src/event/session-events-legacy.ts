import { createEvent, type EventBus } from "./index.ts"

/**
 * Desktop notifications that do not yet have a current-protocol replacement.
 * Keep their wire names and payloads isolated here so current event projection
 * code cannot accidentally grow new dependencies on the legacy envelope.
 */

export function publishSessionIdleLegacy(events: EventBus, sessionID: string, directory?: string): void {
  publishSessionStatusLegacy(events, sessionID, { type: "idle" }, directory)
  events.publish(createEvent("session.idle", { sessionID }), directory)
}

export function publishSessionStatusLegacy(
  events: EventBus,
  sessionID: string,
  status: { type: "busy" | "idle" } | { type: "retry"; attempt: number; message: string; next: number },
  directory?: string,
): void {
  events.publish(createEvent("session.status", { sessionID, status }), directory)
}

export function publishSessionErrorLegacy(
  events: EventBus,
  input: {
    sessionID: string
    messageID?: string
    error: {
      name: string
      data: { message: string; [key: string]: unknown }
    }
  },
  directory?: string,
): void {
  events.publish(createEvent("session.error", input), directory)
}

export function publishMessageRemovedLegacy(
  events: EventBus,
  sessionID: string,
  messageID: string,
  directory?: string,
): void {
  events.publish(createEvent("message.removed", { sessionID, messageID }), directory)
}

export function publishSessionCompactedLegacy(events: EventBus, sessionID: string, directory?: string): void {
  events.publish(createEvent("session.compacted", { sessionID }), directory)
}
