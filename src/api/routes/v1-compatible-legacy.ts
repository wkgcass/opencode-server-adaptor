import { Hono } from "hono"
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import type { AppConfig } from "../../config/index.ts"
import type { ProviderConfigStore } from "../../config/provider-config.ts"
import type { SessionService } from "../../session/session-service.ts"
import { SessionServiceError } from "../../session/session-service.ts"
import { requestDirectory } from "../request-directory.ts"
import { loadProviderConfigObject } from "../provider.ts"

const MAX_FILE_SIZE = 10 * 1024 * 1024

/**
 * Containment check without realpath resolution so it also accepts paths that
 * do not exist yet. Mirrors the OpenCode server's FSUtil.contains behaviour
 * used by the legacy /file/content route.
 */
function withinBase(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function getMimeType(filePath: string): string | undefined {
  const ext = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase()
  const mimeMap: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    js: "text/javascript",
    ts: "text/typescript",
    html: "text/html",
    css: "text/css",
    xml: "text/xml",
    yaml: "text/yaml",
    yml: "text/yaml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    pdf: "application/pdf",
  }
  return mimeMap[ext]
}

async function runProcess(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  try {
    const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" })
    const timeout = setTimeout(() => {
      try {
        proc.kill("SIGTERM")
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    clearTimeout(timeout)
    return { stdout, stderr, code }
  } catch {
    return { stdout: "", stderr: "process not available", code: -1 }
  }
}

/** Best-effort gitignore lookup; falls back to "nothing ignored". */
async function checkIgnored(directory: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0 || !existsSync(join(directory, ".git"))) return new Set()
  const result = await runProcess(["git", "check-ignore", "--no-index", "--", ...names], directory, 3000)
  const ignored = new Set<string>()
  if (result.code === 0) {
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim().replace(/\/+$/, "")
      if (trimmed) ignored.add(trimmed)
    }
  }
  return ignored
}

export function createV1CompatibleLegacyRoutes(options: {
  config: AppConfig
  providerConfig: ProviderConfigStore
  sessionService: SessionService
}): Hono {
  const app = new Hono()

  app.delete("/session/:sessionID", async (c) => {
    try {
      await options.sessionService.delete(c.req.param("sessionID"))
      return c.json(true, 200)
    } catch (error) {
      return v1Error(c, error)
    }
  })

  app.get("/config", (c) => {
    const file = options.providerConfig.snapshot()
    return c.json({
      $schema: undefined,
      logLevel: options.config.logLevel as "DEBUG" | "INFO" | "WARN" | "ERROR",
      share: "manual" as const,
      autoshare: false,
      autoupdate: "notify" as const,
      model: file.model,
      small_model: undefined,
      default_agent: options.config.defaultAgent,
      username: undefined,
      provider: loadProviderConfigObject(options.providerConfig),
      mcp: {},
      formatter: undefined,
      lsp: undefined,
      instructions: [],
      permission: undefined,
      tools: {},
      experimental: {
        disable_paste_summary: false,
        batch_tool: false,
        openTelemetry: false,
        primary_tools: [],
        continue_loop_on_deny: false,
      },
      compaction: {
        auto: true,
        prune: true,
        tail_turns: 0,
        preserve_recent_tokens: 0,
        reserved: 0,
      },
    })
  })

  // ===== Legacy filesystem routes (v1 SDK File/Find classes) =====
  // The OpenCode desktop client drives its file tree through the v1 SDK
  // client.file.list / client.file.read / client.find.files calls, which hit
  // /file, /file/content and /find/file. These endpoints have no v2
  // counterpart, so — like GET /config and DELETE /session/:id — they are
  // mounted in both api versions. Response shapes follow the OpenCode
  // server's legacy FileApi (FileNode / FileContent).
  //
  // The remaining v1 SDK File/Find methods (file.status, find.text,
  // find.symbols) are not used by the desktop client and are intentionally
  // omitted; they fall through to the 404 catch-all.
  app.get("/file", async (c) => {
    const base = requestDirectory(c.req, options.config.defaultWorkspace)
    const target = resolve(base, c.req.query("path") ?? ".")
    if (!withinBase(base, target)) return c.json({ error: "Path traversal not allowed" }, 403)
    if (!existsSync(target)) return c.json({ error: "Path not found" }, 404)
    if (!statSync(target).isDirectory()) return c.json([])

    let entries: string[]
    try {
      entries = readdirSync(target)
    } catch {
      return c.json([])
    }
    const ignoredSet = await checkIgnored(base, entries)
    const nodes: Array<{
      name: string
      path: string
      absolute: string
      type: "file" | "directory"
      ignored: boolean
    }> = []
    for (const name of entries) {
      const entryPath = join(target, name)
      let entryStat: ReturnType<typeof statSync> | undefined
      try {
        entryStat = statSync(entryPath)
      } catch {
        continue
      }
      if (!entryStat) continue
      const relativePath = relative(base, entryPath)
      nodes.push({
        name,
        path: relativePath,
        absolute: entryPath,
        type: entryStat.isDirectory() ? "directory" : "file",
        ignored: ignoredSet.has(name) || ignoredSet.has(relativePath),
      })
    }
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return c.json(nodes)
  })

  app.get("/file/content", (c) => {
    const base = requestDirectory(c.req, options.config.defaultWorkspace)
    const target = resolve(base, c.req.query("path") ?? ".")
    if (!withinBase(base, target)) return c.json({ error: "Path traversal not allowed" }, 403)
    if (!existsSync(target)) return c.json({ type: "text" as const, content: "" })
    const fileStat = statSync(target)
    if (fileStat.isDirectory()) return c.json({ error: "Path is a directory" }, 400)
    if (fileStat.size > MAX_FILE_SIZE) return c.json({ error: "File too large", maxSize: MAX_FILE_SIZE }, 413)

    const data = readFileSync(target)
    const mimeType = getMimeType(target)
    if (data.includes(0)) {
      return c.json({
        type: "binary" as const,
        content: data.toString("base64"),
        encoding: "base64" as const,
        mimeType,
      })
    }
    let decoded: string
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(data)
    } catch {
      return c.json({
        type: "binary" as const,
        content: data.toString("base64"),
        encoding: "base64" as const,
        mimeType,
      })
    }
    return c.json({ type: "text" as const, content: decoded.trim() })
  })

  app.get("/find/file", (c) => {
    const base = requestDirectory(c.req, options.config.defaultWorkspace)
    const query = c.req.query("query") ?? c.req.query("q") ?? ""
    if (!query) return c.json({ error: "Query parameter 'query' is required" }, 400)
    const typeParam = c.req.query("type")
    const dirs = c.req.query("dirs")
    const type = typeParam === "file" || typeParam === "directory" ? typeParam : dirs === "false" ? "file" : undefined
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "10", 10) || 10, 1), 200)
    const results: string[] = []
    const walk = (directory: string, depth: number) => {
      if (depth > 5 || results.length >= limit) return
      let entries: string[]
      try {
        entries = readdirSync(directory)
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === ".git") continue
        const fullPath = join(directory, entry)
        let entryStat: ReturnType<typeof lstatSync> | undefined
        try {
          entryStat = lstatSync(fullPath)
        } catch {
          continue
        }
        if (!entryStat) continue
        if (entryStat.isSymbolicLink()) continue
        const isDir = entryStat.isDirectory()
        const entryType = isDir ? "directory" : "file"
        if ((!type || type === entryType) && entry.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
          results.push(relative(base, fullPath))
          if (results.length >= limit) return
        }
        if (isDir) walk(fullPath, depth + 1)
      }
    }
    walk(base, 0)
    return c.json(results)
  })
  return app
}

function v1Error(c: { json(value: unknown, status?: number): Response }, error: unknown): Response {
  const serviceError =
    error instanceof SessionServiceError
      ? error
      : new SessionServiceError("invalid_request", error instanceof Error ? error.message : String(error))
  if (serviceError.code === "not_found" || serviceError.code === "message_not_found") {
    return c.json({ name: "NotFoundError", data: { message: serviceError.message } }, 404)
  }
  return c.json({ name: "BadRequest", data: { message: serviceError.message } }, 400)
}
