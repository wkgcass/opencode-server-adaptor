export class SessionQueue {
  private queues = new Map<string, Promise<void>>()
  private pending = new Map<string, number>()

  async run<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    this.pending.set(sessionId, (this.pending.get(sessionId) ?? 0) + 1)
    const previous = this.queues.get(sessionId) ?? Promise.resolve()

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const current = previous.catch(() => undefined).then(() => gate)
    this.queues.set(sessionId, current)

    await previous.catch(() => undefined)

    try {
      return await fn()
    } finally {
      release()
      if (this.queues.get(sessionId) === current) {
        this.queues.delete(sessionId)
      }
      const remaining = (this.pending.get(sessionId) ?? 1) - 1
      if (remaining > 0) this.pending.set(sessionId, remaining)
      else this.pending.delete(sessionId)
    }
  }

  hasPending(sessionId: string): boolean {
    return this.queues.has(sessionId)
  }

  pendingCount(sessionId: string): number {
    return this.pending.get(sessionId) ?? 0
  }

  clear(sessionId: string): void {
    this.queues.delete(sessionId)
    this.pending.delete(sessionId)
  }

  clearAll(): void {
    this.queues.clear()
    this.pending.clear()
  }
}
