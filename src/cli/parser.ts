export type ParsedLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

export interface GlobalOptions {
  printLogs: boolean
  logLevel: ParsedLogLevel | null
  verbose: boolean
  help: boolean
  version: boolean
}

export interface ServeOptions {
  hostname: string
  port: number
  cors: string[]
  mdns: boolean
  mdnsDomain: string | null
  verbose: boolean
  disablePtyTokenCheck: boolean
}

export type Subcommand =
  | { type: "version" }
  | { type: "adaptor-version" }
  | { type: "serve"; options: ServeOptions }
  | { type: "compatibility"; action: "get" | "set"; version?: string }
  | { type: "help" }
  | { type: "unknown"; command: string }

export interface ParsedArgs {
  global: GlobalOptions
  subcommand: Subcommand | null
}

function isFlag(arg: string): boolean {
  return arg.startsWith("-")
}

function parseLogLevelValue(value: string): ParsedLogLevel | null {
  const upper = value.toUpperCase()
  if (upper === "DEBUG" || upper === "INFO" || upper === "WARN" || upper === "ERROR") {
    return upper
  }
  return null
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ParseError"
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const global: GlobalOptions = {
    printLogs: false,
    logLevel: null,
    verbose: false,
    help: false,
    version: false,
  }

  let i = 0
  const args = argv.slice(2)

  while (i < args.length) {
    const arg = args[i]
    if (!arg) {
      i++
      continue
    }

    if (!isFlag(arg)) {
      break
    }

    switch (arg) {
      case "--help":
      case "-h":
        global.help = true
        i++
        break
      case "--version":
      case "-v":
        global.version = true
        i++
        break
      case "--print-logs":
        global.printLogs = true
        i++
        break
      case "--verbose":
        global.verbose = true
        i++
        break
      case "--log-level": {
        const value = args[i + 1]
        if (value === undefined) {
          throw new ParseError("--log-level requires a value: DEBUG|INFO|WARN|ERROR")
        }
        const level = parseLogLevelValue(value)
        if (level === null) {
          throw new ParseError(`Invalid log level: ${value}. Expected DEBUG, INFO, WARN, or ERROR`)
        }
        global.logLevel = level
        i += 2
        break
      }
      default:
        if (arg.startsWith("--log-level=")) {
          const value = arg.slice("--log-level=".length)
          const level = parseLogLevelValue(value)
          if (level === null) {
            throw new ParseError(`Invalid log level: ${value}. Expected DEBUG, INFO, WARN, or ERROR`)
          }
          global.logLevel = level
          i++
          break
        }
        throw new ParseError(`Unknown global option: ${arg}`)
    }
  }

  const remaining = args.slice(i)

  if (remaining.length === 0) {
    return { global, subcommand: null }
  }

  const command = remaining[0]
  if (!command) {
    return { global, subcommand: null }
  }
  const commandArgs = remaining.slice(1)

  let subcommand: Subcommand

  switch (command) {
    case "version":
    case "v":
      subcommand = { type: "version" }
      break
    case "adaptor-version":
      subcommand = { type: "adaptor-version" }
      break
    case "serve":
      subcommand = { type: "serve", options: parseServeOptions(commandArgs) }
      break
    case "compatibility":
      subcommand = parseCompatibilityCommand(commandArgs)
      break
    case "help":
      subcommand = { type: "help" }
      break
    default:
      subcommand = { type: "unknown", command }
  }

  return { global, subcommand }
}

function parseServeOptions(args: string[]): ServeOptions {
  const options: ServeOptions = {
    hostname: "127.0.0.1",
    port: 4096,
    cors: [],
    mdns: false,
    mdnsDomain: null,
    verbose: false,
    disablePtyTokenCheck: false,
  }

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (!arg) {
      i++
      continue
    }

    switch (arg) {
      case "--hostname": {
        const value = args[i + 1]
        if (value === undefined) {
          throw new ParseError("--hostname requires a value")
        }
        options.hostname = value
        i += 2
        break
      }
      case "--port": {
        const value = args[i + 1]
        if (value === undefined) {
          throw new ParseError("--port requires a value")
        }
        const port = parseInt(value, 10)
        if (isNaN(port) || port < 0 || port > 65535) {
          throw new ParseError(`Invalid port: ${value}. Must be a number between 0 and 65535`)
        }
        options.port = port
        i += 2
        break
      }
      case "--cors": {
        const value = args[i + 1]
        if (value === undefined) {
          throw new ParseError("--cors requires a value")
        }
        options.cors.push(value)
        i += 2
        break
      }
      case "--mdns":
        options.mdns = true
        i++
        break
      case "--verbose":
        options.verbose = true
        i++
        break
      case "--disable-pty-token-check":
        options.disablePtyTokenCheck = true
        i++
        break
      case "--mdns-domain": {
        const value = args[i + 1]
        if (value === undefined) {
          throw new ParseError("--mdns-domain requires a value")
        }
        options.mdnsDomain = value
        i += 2
        break
      }
      case "--help":
      case "-h":
        i++
        break
      default:
        if (arg.startsWith("--hostname=")) {
          options.hostname = arg.slice("--hostname=".length)
          i++
          break
        }
        if (arg.startsWith("--port=")) {
          const value = arg.slice("--port=".length)
          const port = parseInt(value, 10)
          if (isNaN(port) || port < 0 || port > 65535) {
            throw new ParseError(`Invalid port: ${value}. Must be a number between 0 and 65535`)
          }
          options.port = port
          i++
          break
        }
        if (arg.startsWith("--cors=")) {
          options.cors.push(arg.slice("--cors=".length))
          i++
          break
        }
        throw new ParseError(`Unknown serve option: ${arg}`)
    }
  }

  return options
}

function parseCompatibilityCommand(args: string[]): Subcommand {
  if (args.length === 0) {
    return { type: "compatibility", action: "get" }
  }

  const action = args[0]
  switch (action) {
    case "get":
      return { type: "compatibility", action: "get" }
    case "set": {
      if (args.length < 2) {
        throw new ParseError("compatibility set requires a version argument")
      }
      return { type: "compatibility", action: "set", version: args[1] }
    }
    default:
      throw new ParseError(`Unknown compatibility action: ${action}. Expected get or set`)
  }
}

export function formatHelp(): string {
  return [
    "opencode-server-adaptor",
    "",
    "USAGE:",
    "  opencode [GLOBAL OPTIONS] <COMMAND> [COMMAND OPTIONS]",
    "  opencode-server-adaptor [GLOBAL OPTIONS] <COMMAND> [COMMAND OPTIONS]",
    "",
    "GLOBAL OPTIONS:",
    "  --print-logs              Print structured logs to stderr",
    "  --verbose                 Print HTTP requests and debug logs to stderr",
    "  --log-level <LEVEL>      Minimum log level: DEBUG|INFO|WARN|ERROR",
    "  --version, -v            Print OpenCode compatibility version and exit",
    "  --help, -h               Show this help message",
    "",
    "COMMANDS:",
    "  version                  Print OpenCode compatibility version",
    "  adaptor-version          Print the adaptor's own version",
    "  serve                    Start the HTTP server",
    "  compatibility get        Print the current OpenCode compatibility version",
    "  compatibility set <VER>  Set the OpenCode compatibility version",

    "  help                     Show this help message",
    "",
    "SERVE OPTIONS:",
    "  --hostname <HOST>        Bind address (default: 127.0.0.1)",
    "  --port <PORT>            Listen port (default: 4096)",
    "  --cors <ORIGIN>          Allowed CORS origin (repeatable)",
    "  --verbose                Print HTTP requests and debug logs to stderr",
    "  --mdns                   Enable mDNS (not yet implemented, prints warning)",
    "  --mdns-domain <DOMAIN>   mDNS domain (not yet implemented)",
    "  --disable-pty-token-check  Skip the PTY WebSocket connect-ticket check",
    "",
    "ENVIRONMENT:",
    "  OPENCODE_SERVER_USERNAME    HTTP Basic Auth username",
    "  OPENCODE_SERVER_PASSWORD    HTTP Basic Auth password (enables auth)",
    "  OPENCODE_ADAPTOR_COMPAT_VERSION  Override OpenCode compatibility version",
    "  XDG_STATE_HOME              State data directory",
    "  XDG_CONFIG_HOME             Config directory",
    "",
  ].join("\n")
}
