import type { ServeOptions } from "./parser.ts"
import type { ParsedLogLevel } from "./parser.ts"
import { getLogger, parseLogLevel } from "../logging/index.ts"
import { loadConfig } from "../config/index.ts"
import { startServer, type ServerHandle } from "../server.ts"

export interface ServeResult {
  handle: ServerHandle
}

export async function runServe(
  serveOptions: ServeOptions,
  globalOptions: { printLogs: boolean; logLevel: ParsedLogLevel | null; verbose: boolean },
): Promise<ServeResult> {
  const config = loadConfig()

  const hostname = serveOptions.hostname
  const port = serveOptions.port

  const verbose = globalOptions.verbose
  const logLevel = globalOptions.logLevel ?? (verbose ? "DEBUG" : (parseLogLevel(config.logLevel) ?? "INFO"))
  const printLogs = globalOptions.printLogs || verbose

  const logger = getLogger()
  logger.configure({ minLevel: logLevel, printLogs, verbose })

  logger.info("Starting opencode-server-adaptor", {
    hostname,
    port,
    logLevel,
    printLogs,
    verbose,
    compatVersion: config.compatibilityVersion,
    adaptorVersion: "0.1.0",
  })

  if (serveOptions.mdns) {
    logger.warn("--mdns flag received but mDNS is not yet implemented")
  }
  if (serveOptions.mdnsDomain) {
    logger.warn("--mdns-domain flag received but mDNS is not yet implemented")
  }
  if (serveOptions.disablePtyTokenCheck) {
    logger.warn(
      "PTY connect-token check is disabled (--disable-pty-token-check); PTY WebSocket clients can connect without a ticket",
    )
  }

  logger.info("Configuration loaded", {
    defaultAgent: config.defaultAgent,
    databasePath: config.databasePath,
    authEnabled: config.serverPassword !== null,
    opencodeClient: config.opencodeClient,
  })

  const handle = await startServer({
    hostname,
    port,
    cors: serveOptions.cors,
    verbose,
    disablePtyTokenCheck: serveOptions.disablePtyTokenCheck,
    config,
    logger,
  })

  return { handle }
}
