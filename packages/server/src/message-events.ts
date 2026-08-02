/**
 * Message bus events — emit when session messages are persisted.
 */

import type { SessionMessage } from "@butterfly/session"
import type { EventBus } from "./bus"

/** Emit message.added for a single persisted message. */
export function emitMessageAdded(bus: EventBus, sessionId: string, message: SessionMessage): void {
  bus.emit({
    kind: "message.added",
    sessionId,
    data: {
      messageId: message.id,
      role: message.role,
      content: message.content,
      parts: message.parts,
      toolCallId: "toolCallId" in message ? message.toolCallId : undefined,
      timestamp: message.timestamp,
    },
  })
}

/** Emit message.added for all messages added since `prevCount`. */
export function emitNewMessages(
  bus: EventBus,
  sessionId: string,
  messages: SessionMessage[],
  prevCount: number,
): void {
  for (let i = prevCount; i < messages.length; i++) {
    emitMessageAdded(bus, sessionId, messages[i])
  }
}
