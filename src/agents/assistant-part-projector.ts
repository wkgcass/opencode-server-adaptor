import type { AssistantMessage, MessageRepository, Part } from "../message/index.ts"

interface MessageGroup {
  rootMessageId: string
  sessionId: string
  messageIds: string[]
}

export interface AssistantPartProjectorOptions {
  encapsulateParts?: boolean
}

/**
 * Projects backend parts onto OpenCode assistant messages.
 *
 * By default, consecutive assistant parts of the same type are grouped into
 * sibling messages while retaining the original user message as parent. Part
 * encapsulation mode keeps every part on the single assistant message admitted
 * for the prompt. Message completion remains an execution-level boundary: all
 * siblings are closed together, and only the terminal sibling owns
 * finish/usage/error.
 */
export class AssistantPartProjector {
  private readonly encapsulateParts: boolean
  private readonly groups = new Map<string, MessageGroup>()
  private readonly rootByMessage = new Map<string, string>()
  private readonly rootsBySession = new Map<string, Set<string>>()

  constructor(
    private readonly messages: MessageRepository,
    options?: AssistantPartProjectorOptions,
  ) {
    this.encapsulateParts = options?.encapsulateParts ?? false
  }

  isEnabled(): boolean {
    return this.encapsulateParts
  }

  createPart(
    sessionId: string,
    rootMessageId: string,
    type: Part["type"],
    data: Omit<Part, "id" | "sessionID" | "messageID" | "type">,
    requestedId?: string,
  ): Part {
    if (this.encapsulateParts) return this.messages.createPart(sessionId, rootMessageId, type, data, requestedId)

    const group = this.requireGroup(sessionId, rootMessageId)
    let targetMessageId = group.messageIds.at(-1)!
    const previousPart = this.messages.listParts(targetMessageId).at(-1)
    if (previousPart && previousPart.type !== type) {
      const root = this.requireAssistant(group.rootMessageId)
      const sibling = this.messages.createAssistantMessage(
        sessionId,
        root.parentID,
        root.agent,
        { providerID: root.providerID, modelID: root.modelID },
        targetMessageId,
      )
      group.messageIds.push(sibling.id)
      this.rootByMessage.set(sibling.id, group.rootMessageId)
      targetMessageId = sibling.id
    }

    return this.messages.createPart(sessionId, targetMessageId, type, data, requestedId)
  }

  messageIds(messageId: string): string[] {
    if (this.encapsulateParts) return [messageId]
    const root = this.rootByMessage.get(messageId) ?? messageId
    return [...(this.groups.get(root)?.messageIds ?? [messageId])]
  }

  terminalMessageId(messageId: string): string {
    const ids = this.messageIds(messageId)
    for (let index = ids.length - 1; index >= 0; index--) {
      const id = ids[index]!
      if (this.messages.listParts(id).length > 0) return id
    }
    return ids.at(-1) ?? messageId
  }

  complete(
    messageId: string,
    finish: string,
    usage?: Parameters<MessageRepository["updateMessageUsage"]>[1],
  ): { messageIds: string[]; terminalMessageId: string } {
    const messageIds = this.messageIds(messageId)
    const terminalMessageId = this.terminalMessageId(messageId)
    if (usage) this.messages.updateMessageUsage(terminalMessageId, usage)
    for (const id of messageIds) {
      this.messages.completeMessage(id, id === terminalMessageId ? finish : undefined)
    }
    return { messageIds, terminalMessageId }
  }

  fail(
    messageId: string,
    error: { type?: string; name?: string; message: string },
    usage?: Parameters<MessageRepository["updateMessageUsage"]>[1],
  ): { messageIds: string[]; terminalMessageId: string } {
    const messageIds = this.messageIds(messageId)
    const terminalMessageId = this.terminalMessageId(messageId)
    if (usage) this.messages.updateMessageUsage(terminalMessageId, usage)
    for (const id of messageIds) {
      if (id === terminalMessageId) this.messages.setMessageError(id, error)
      else this.messages.completeMessage(id)
    }
    return { messageIds, terminalMessageId }
  }

  releaseSession(sessionId: string): void {
    const roots = this.rootsBySession.get(sessionId)
    if (!roots) return
    for (const root of roots) {
      const group = this.groups.get(root)
      if (!group) continue
      for (const messageId of group.messageIds) this.rootByMessage.delete(messageId)
      this.groups.delete(root)
    }
    this.rootsBySession.delete(sessionId)
  }

  clear(): void {
    this.groups.clear()
    this.rootByMessage.clear()
    this.rootsBySession.clear()
  }

  private requireGroup(sessionId: string, messageId: string): MessageGroup {
    const knownRoot = this.rootByMessage.get(messageId)
    if (knownRoot) return this.groups.get(knownRoot)!

    const root = this.requireAssistant(messageId)
    if (root.sessionID !== sessionId) {
      throw new Error(`Assistant message '${messageId}' does not belong to session '${sessionId}'`)
    }
    const group = { rootMessageId: root.id, sessionId, messageIds: [root.id] }
    this.groups.set(root.id, group)
    this.rootByMessage.set(root.id, root.id)
    let roots = this.rootsBySession.get(sessionId)
    if (!roots) {
      roots = new Set()
      this.rootsBySession.set(sessionId, roots)
    }
    roots.add(root.id)
    return group
  }

  private requireAssistant(messageId: string): AssistantMessage {
    const message = this.messages.getMessage(messageId)
    if (!message || message.role !== "assistant") {
      throw new Error(`Assistant message not found: ${messageId}`)
    }
    return message
  }
}
