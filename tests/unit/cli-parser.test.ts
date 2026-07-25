import { describe, test, expect } from "bun:test"
import { parseArgs, ParseError, formatHelp } from "../../src/cli/parser.ts"

describe("CLI Parser", () => {
  describe("version flags", () => {
    test("--version sets global.version", () => {
      const result = parseArgs(["node", "opencode", "--version"])
      expect(result.global.version).toBe(true)
      expect(result.subcommand).toBe(null)
    })

    test("-v sets global.version", () => {
      const result = parseArgs(["node", "opencode", "-v"])
      expect(result.global.version).toBe(true)
      expect(result.subcommand).toBe(null)
    })

    test("version subcommand", () => {
      const result = parseArgs(["node", "opencode", "version"])
      expect(result.subcommand).toEqual({ type: "version" })
    })

    test("v subcommand alias", () => {
      const result = parseArgs(["node", "opencode", "v"])
      expect(result.subcommand).toEqual({ type: "version" })
    })
  })

  describe("help flags", () => {
    test("--help sets global.help", () => {
      const result = parseArgs(["node", "opencode", "--help"])
      expect(result.global.help).toBe(true)
      expect(result.subcommand).toBe(null)
    })

    test("-h sets global.help", () => {
      const result = parseArgs(["node", "opencode", "-h"])
      expect(result.global.help).toBe(true)
    })

    test("help subcommand", () => {
      const result = parseArgs(["node", "opencode", "help"])
      expect(result.subcommand).toEqual({ type: "help" })
    })
  })

  describe("adaptor-version", () => {
    test("adaptor-version subcommand", () => {
      const result = parseArgs(["node", "opencode", "adaptor-version"])
      expect(result.subcommand).toEqual({ type: "adaptor-version" })
    })
  })

  describe("global options before serve", () => {
    test("--print-logs before serve", () => {
      const result = parseArgs(["node", "opencode", "--print-logs", "serve", "--port", "4096"])
      expect(result.global.printLogs).toBe(true)
      expect(result.subcommand).toEqual({
        type: "serve",
        options: {
          hostname: "127.0.0.1",
          port: 4096,
          cors: [],
          mdns: false,
          mdnsDomain: null,
          verbose: false,
          disablePtyTokenCheck: false,
        },
      })
    })

    test("--print-logs --log-level WARN before serve", () => {
      const result = parseArgs([
        "node",
        "opencode",
        "--print-logs",
        "--log-level",
        "WARN",
        "serve",
        "--hostname",
        "0.0.0.0",
        "--port",
        "4096",
      ])
      expect(result.global.printLogs).toBe(true)
      expect(result.global.logLevel).toBe("WARN")
      expect(result.subcommand).toEqual({
        type: "serve",
        options: {
          hostname: "0.0.0.0",
          port: 4096,
          cors: [],
          mdns: false,
          mdnsDomain: null,
          verbose: false,
          disablePtyTokenCheck: false,
        },
      })
    })

    test("Desktop-style command: --print-logs --log-level WARN serve --hostname 0.0.0.0 --port <port>", () => {
      const result = parseArgs([
        "node",
        "opencode",
        "--print-logs",
        "--log-level",
        "WARN",
        "serve",
        "--hostname",
        "0.0.0.0",
        "--port",
        "9999",
      ])
      expect(result.global.printLogs).toBe(true)
      expect(result.global.logLevel).toBe("WARN")
      expect(result.subcommand?.type).toBe("serve")
      if (result.subcommand?.type === "serve") {
        expect(result.subcommand.options.hostname).toBe("0.0.0.0")
        expect(result.subcommand.options.port).toBe(9999)
      }
    })

    test("--log-level=ERROR equals sign syntax", () => {
      const result = parseArgs(["node", "opencode", "--log-level=ERROR", "serve"])
      expect(result.global.logLevel).toBe("ERROR")
    })

    test("--log-level DEBUG (case insensitive)", () => {
      const result = parseArgs(["node", "opencode", "--log-level", "debug", "serve"])
      expect(result.global.logLevel).toBe("DEBUG")
    })

    test("--verbose before serve", () => {
      const result = parseArgs(["node", "opencode", "--verbose", "serve", "--port", "4096"])
      expect(result.global.verbose).toBe(true)
      expect(result.subcommand?.type).toBe("serve")
    })

    test("--verbose --print-logs combined", () => {
      const result = parseArgs(["node", "opencode", "--verbose", "--print-logs", "serve"])
      expect(result.global.verbose).toBe(true)
      expect(result.global.printLogs).toBe(true)
    })
  })

  describe("serve options", () => {
    test("serve with defaults", () => {
      const result = parseArgs(["node", "opencode", "serve"])
      expect(result.subcommand).toEqual({
        type: "serve",
        options: {
          hostname: "127.0.0.1",
          port: 4096,
          cors: [],
          mdns: false,
          mdnsDomain: null,
          verbose: false,
          disablePtyTokenCheck: false,
        },
      })
    })

    test("serve with --port", () => {
      const result = parseArgs(["node", "opencode", "serve", "--port", "8080"])
      expect(result.subcommand?.type).toBe("serve")
      if (result.subcommand?.type === "serve") {
        expect(result.subcommand.options.port).toBe(8080)
      }
    })

    test("serve with --hostname", () => {
      const result = parseArgs(["node", "opencode", "serve", "--hostname", "0.0.0.0"])
      expect(result.subcommand?.type).toBe("serve")
      if (result.subcommand?.type === "serve") {
        expect(result.subcommand.options.hostname).toBe("0.0.0.0")
      }
    })

    test("serve with --port= equals syntax", () => {
      const result = parseArgs(["node", "opencode", "serve", "--port=3000"])
      expect(result.subcommand?.type).toBe("serve")
      if (result.subcommand?.type === "serve") {
        expect(result.subcommand.options.port).toBe(3000)
      }
    })

    test("serve with --hostname= equals syntax", () => {
      const result = parseArgs(["node", "opencode", "serve", "--hostname=localhost"])
      expect(result.subcommand?.type).toBe("serve")
      if (result.subcommand?.type === "serve") {
        expect(result.subcommand.options.hostname).toBe("localhost")
      }
    })

    test("serve with --cors (repeatable)", () => {
      const result = parseArgs([
        "node",
        "opencode",
        "serve",
        "--cors",
        "http://localhost:3000",
        "--cors",
        "https://example.com",
      ])
      expect(result.subcommand?.type).toBe("serve")
      if (result.subcommand?.type === "serve") {
        expect(result.subcommand.options.cors).toEqual(["http://localhost:3000", "https://example.com"])
      }
    })

    test("serve with --mdns", () => {
      const result = parseArgs(["node", "opencode", "serve", "--mdns"])
      expect(result.subcommand?.type).toBe("serve")
      if (result.subcommand?.type === "serve") {
        expect(result.subcommand.options.mdns).toBe(true)
      }
    })

    test("serve with --verbose (after serve)", () => {
      const result = parseArgs(["node", "opencode", "serve", "--verbose", "--port", "8080"])
      expect(result.subcommand?.type).toBe("serve")
      if (result.subcommand?.type === "serve") {
        expect(result.subcommand.options.verbose).toBe(true)
        expect(result.subcommand.options.port).toBe(8080)
      }
    })

    test("--verbose before serve and after serve both work", () => {
      const r1 = parseArgs(["node", "opencode", "--verbose", "serve"])
      const r2 = parseArgs(["node", "opencode", "serve", "--verbose"])
      expect(r1.global.verbose).toBe(true)
      if (r2.subcommand?.type === "serve") {
        expect(r2.subcommand.options.verbose).toBe(true)
      }
    })

    test("serve with --mdns-domain", () => {
      const result = parseArgs(["node", "opencode", "serve", "--mdns-domain", "local"])
      expect(result.subcommand?.type).toBe("serve")
      if (result.subcommand?.type === "serve") {
        expect(result.subcommand.options.mdnsDomain).toBe("local")
      }
    })

    test("serve with --disable-pty-token-check", () => {
      const result = parseArgs(["node", "opencode", "serve", "--disable-pty-token-check"])
      expect(result.subcommand?.type).toBe("serve")
      if (result.subcommand?.type === "serve") {
        expect(result.subcommand.options.disablePtyTokenCheck).toBe(true)
      }
    })

    test("serve defaults disablePtyTokenCheck to false", () => {
      const result = parseArgs(["node", "opencode", "serve"])
      if (result.subcommand?.type === "serve") {
        expect(result.subcommand.options.disablePtyTokenCheck).toBe(false)
      }
    })
  })

  describe("compatibility subcommand", () => {
    test("compatibility get (default)", () => {
      const result = parseArgs(["node", "opencode", "compatibility"])
      expect(result.subcommand).toEqual({ type: "compatibility", action: "get" })
    })

    test("compatibility get explicit", () => {
      const result = parseArgs(["node", "opencode", "compatibility", "get"])
      expect(result.subcommand).toEqual({ type: "compatibility", action: "get" })
    })

    test("compatibility set", () => {
      const result = parseArgs(["node", "opencode", "compatibility", "set", "1.18.7"])
      expect(result.subcommand).toEqual({ type: "compatibility", action: "set", version: "1.18.7" })
    })

    test("compatibility set without version throws", () => {
      expect(() => parseArgs(["node", "opencode", "compatibility", "set"])).toThrow(ParseError)
    })
  })

  describe("error handling", () => {
    test("invalid port throws", () => {
      expect(() => parseArgs(["node", "opencode", "serve", "--port", "abc"])).toThrow(ParseError)
    })

    test("negative port throws", () => {
      expect(() => parseArgs(["node", "opencode", "serve", "--port", "-1"])).toThrow(ParseError)
    })

    test("port too large throws", () => {
      expect(() => parseArgs(["node", "opencode", "serve", "--port", "99999"])).toThrow(ParseError)
    })

    test("invalid log level throws", () => {
      expect(() => parseArgs(["node", "opencode", "--log-level", "VERBOSE", "serve"])).toThrow(ParseError)
    })

    test("missing --port value throws", () => {
      expect(() => parseArgs(["node", "opencode", "serve", "--port"])).toThrow(ParseError)
    })

    test("missing --hostname value throws", () => {
      expect(() => parseArgs(["node", "opencode", "serve", "--hostname"])).toThrow(ParseError)
    })

    test("missing --log-level value throws", () => {
      expect(() => parseArgs(["node", "opencode", "--log-level"])).toThrow(ParseError)
    })

    test("unknown global option throws", () => {
      expect(() => parseArgs(["node", "opencode", "--unknown-flag", "serve"])).toThrow(ParseError)
    })

    test("unknown serve option throws", () => {
      expect(() => parseArgs(["node", "opencode", "serve", "--unknown"])).toThrow(ParseError)
    })

    test("removed API version option is rejected", () => {
      expect(() => parseArgs(["node", "opencode", "serve", "--api-version=v2"])).toThrow(
        "Unknown serve option: --api-version=v2",
      )
    })

    test("unknown command", () => {
      const result = parseArgs(["node", "opencode", "foobar"])
      expect(result.subcommand).toEqual({ type: "unknown", command: "foobar" })
    })
  })

  describe("formatHelp", () => {
    test("returns non-empty string", () => {
      const help = formatHelp()
      expect(help.length).toBeGreaterThan(0)
      expect(help).toContain("opencode-server-adaptor")
      expect(help).toContain("USAGE")
      expect(help).toContain("serve")
      expect(help).toContain("version")
      expect(help).toContain("--print-logs")
      expect(help).toContain("--verbose")
      expect(help).not.toContain("--api-version")
    })
  })
})
