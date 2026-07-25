#!/usr/bin/env bun
import { parseArgs, ParseError, formatHelp } from "./cli/parser.ts"
import { printCompatVersion, printAdaptorVersion } from "./cli/version.ts"
import {
  getCompatibilityVersion,
  setCompatibilityVersion,
  printCompatibilityVersion,
} from "./cli/compatibility.ts"
import { runServe } from "./cli/serve.ts"
import { getLogger } from "./logging/index.ts"

async function main(): Promise<void> {
  let parsed
  try {
    parsed = parseArgs(process.argv)
  } catch (err) {
    if (err instanceof ParseError) {
      process.stderr.write(`Error: ${err.message}\n`)
      process.stderr.write(formatHelp())
      process.exit(1)
    }
    throw err
  }

  const { global, subcommand } = parsed

  if (global.help && !subcommand) {
    process.stdout.write(formatHelp())
    return
  }

  if (global.version && !subcommand) {
    printCompatVersion()
    return
  }

  if (!subcommand) {
    process.stdout.write(formatHelp())
    return
  }

  switch (subcommand.type) {
    case "version":
      printCompatVersion()
      return

    case "adaptor-version":
      printAdaptorVersion()
      return

    case "help":
      process.stdout.write(formatHelp())
      return

    case "compatibility":
      switch (subcommand.action) {
        case "get":
          printCompatibilityVersion()
          return
        case "set":
          try {
            setCompatibilityVersion(subcommand.version!)
            process.stdout.write(`Compatibility version set to: ${getCompatibilityVersion()}\n`)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            process.stderr.write(`Error: ${msg}\n`)
            process.exit(1)
          }
          return
      }
      return

    case "serve": {
      const result = await runServe(subcommand.options, {
        printLogs: global.printLogs,
        logLevel: global.logLevel,
        verbose: global.verbose || subcommand.options.verbose,
      })
      await new Promise<void>((resolve) => {
        const cleanup = async () => {
          await result.handle.close()
          resolve()
        }
        process.on("SIGTERM", () => void cleanup())
        process.on("SIGINT", () => void cleanup())
      })
      return
    }

    case "unknown": {
      const cmd = subcommand.command
      if (cmd === "--help" || cmd === "-h") {
        process.stdout.write(formatHelp())
        return
      }
      if (cmd === "--version" || cmd === "-v") {
        printCompatVersion()
        return
      }
      process.stderr.write(`Unknown command: ${cmd}\n`)
      process.stderr.write(formatHelp())
      process.exit(1)
      return
    }
  }
}

main().catch((err) => {
  const logger = getLogger()
  logger.error("Fatal error", { error: err instanceof Error ? err.message : String(err) })
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
