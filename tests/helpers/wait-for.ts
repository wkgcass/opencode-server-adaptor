interface WaitForOptions {
  timeoutMs?: number
  intervalMs?: number
  description?: string
}

export async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  options: WaitForOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const intervalMs = options.intervalMs ?? 25
  const deadline = Date.now() + timeoutMs
  let last: T

  while (true) {
    last = await read()
    if (predicate(last)) return last
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${options.description ?? "condition"} after ${timeoutMs}ms`)
    }
    await Bun.sleep(intervalMs)
  }
}

export async function waitForSessionIdle(
  baseUrl: string,
  authorization: string,
  sessionID: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (true) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error(`Timed out waiting for session ${sessionID} to become idle after ${timeoutMs}ms`)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), remainingMs)
    try {
      const response = await fetch(`${baseUrl}/api/session/${sessionID}/wait`, {
        method: "POST",
        headers: { Authorization: authorization },
        signal: controller.signal,
      })
      if (response.ok) return
      if (response.status !== 503) {
        throw new Error(`Waiting for session ${sessionID} failed with HTTP ${response.status}`)
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Timed out waiting for session ${sessionID} to become idle after ${timeoutMs}ms`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}
