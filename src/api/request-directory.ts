import { resolve } from "node:path"

interface RequestWithDirectory {
  query(name: string): string | undefined
  header(name: string): string | undefined
}

function decodeHeaderDirectory(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * OpenCode's SDK scopes GET requests with a query parameter and POST requests
 * with an URL-encoded x-opencode-directory header.
 */
export function explicitRequestDirectory(request: RequestWithDirectory): string | undefined {
  const query = request.query("directory") ?? request.query("location[directory]")
  if (query?.trim()) return resolve(query)

  const header = request.header("x-opencode-directory")
  if (header?.trim()) return resolve(decodeHeaderDirectory(header))
  return undefined
}

export function requestDirectory(request: RequestWithDirectory, fallback = process.cwd()): string {
  return explicitRequestDirectory(request) ?? resolve(fallback)
}
