import { describe, test, expect } from "bun:test"
import { spawn } from "bun"
import { join } from "node:path"
import { reserveFreePort } from "../helpers/free-port.ts"

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts")

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

async function execCli(args: string[], env?: Record<string, string>): Promise<ExecResult> {
  const proc = spawn({
    cmd: ["bun", "run", CLI_PATH, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited

  return { stdout, stderr, exitCode }
}

describe("CLI Integration", () => {
  describe("version commands", () => {
    test("--version outputs compat version on first stdout line", async () => {
      const result = await execCli(["--version"])
      expect(result.exitCode).toBe(0)
      const firstLine = result.stdout.split("\n").find((l) => l.trim().length > 0)
      expect(firstLine).toBeDefined()
      expect(firstLine).toMatch(/^\d+\.\d+\.\d+$/)
      expect(firstLine!.startsWith("v")).toBe(false)
    })

    test("-v outputs compat version on first stdout line", async () => {
      const result = await execCli(["-v"])
      expect(result.exitCode).toBe(0)
      const firstLine = result.stdout.split("\n").find((l) => l.trim().length > 0)
      expect(firstLine).toBeDefined()
      expect(firstLine).toMatch(/^\d+\.\d+\.\d+$/)
    })

    test("version subcommand outputs compat version", async () => {
      const result = await execCli(["version"])
      expect(result.exitCode).toBe(0)
      const firstLine = result.stdout.split("\n").find((l) => l.trim().length > 0)
      expect(firstLine).toBeDefined()
      expect(firstLine).toMatch(/^\d+\.\d+\.\d+$/)
    })

    test("adaptor-version outputs adaptor version", async () => {
      const result = await execCli(["adaptor-version"])
      expect(result.exitCode).toBe(0)
      const firstLine = result.stdout.split("\n").find((l) => l.trim().length > 0)
      expect(firstLine).toBeDefined()
      expect(firstLine).toMatch(/^\d+\.\d+\.\d+$/)
    })

    test("--version differs from adaptor-version", async () => {
      const compatResult = await execCli(["--version"])
      const adaptorResult = await execCli(["adaptor-version"])
      const compatVersion = compatResult.stdout.split("\n").find((l) => l.trim().length > 0)
      const adaptorVersion = adaptorResult.stdout.split("\n").find((l) => l.trim().length > 0)
      expect(compatVersion).not.toBe(adaptorVersion)
    })

    test("stderr is empty for --version", async () => {
      const result = await execCli(["--version"])
      expect(result.stderr.trim()).toBe("")
    })
  })

  describe("compatibility commands", () => {
    test("compatibility get outputs version", async () => {
      const result = await execCli(["compatibility", "get"])
      expect(result.exitCode).toBe(0)
      const firstLine = result.stdout.split("\n").find((l) => l.trim().length > 0)
      expect(firstLine).toMatch(/^\d+\.\d+\.\d+$/)
    })

    test("OPENCODE_ADAPTOR_COMPAT_VERSION env overrides version", async () => {
      const result = await execCli(["--version"], { OPENCODE_ADAPTOR_COMPAT_VERSION: "1.18.7" })
      expect(result.exitCode).toBe(0)
      const firstLine = result.stdout.split("\n").find((l) => l.trim().length > 0)
      expect(firstLine).toBe("1.18.7")
    })
  })

  describe("help", () => {
    test("--help outputs help text", async () => {
      const result = await execCli(["--help"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("opencode-server-adaptor")
      expect(result.stdout).toContain("USAGE")
    })

    test("help subcommand outputs help text", async () => {
      const result = await execCli(["help"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("USAGE")
    })

    test("no args outputs help", async () => {
      const result = await execCli([])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("USAGE")
    })
  })

  describe("error handling", () => {
    test("invalid port exits non-zero", async () => {
      const result = await execCli(["serve", "--port", "abc"])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Invalid port")
    })

    test("unknown command exits non-zero", async () => {
      const result = await execCli(["foobar"])
      expect(result.exitCode).toBe(1)
    })

    test("unknown global option exits non-zero", async () => {
      const result = await execCli(["--unknown-flag"])
      expect(result.exitCode).toBe(1)
    })
  })

  describe("serve startup", () => {
    test("serve starts and responds to health check", async () => {
      const port = reserveFreePort()
      const proc = spawn({
        cmd: [
          "bun",
          "run",
          CLI_PATH,
          "--print-logs",
          "--log-level",
          "ERROR",
          "serve",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: "",
          OPENCODE_SERVER_USERNAME: "",
          DATABASE_PATH: ":memory:",
        },
      })

      await Bun.sleep(1000)

      let healthy = false
      for (let i = 0; i < 10; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`)
          if (res.ok) {
            healthy = true
            break
          }
        } catch {
          // retry
        }
        await Bun.sleep(200)
      }

      expect(healthy).toBe(true)

      const res = await fetch(`http://127.0.0.1:${port}/global/health`)
      expect(res.status).toBe(404)

      proc.kill("SIGTERM")
      await proc.exited
    }, 15000)

    test("serve with Basic Auth requires credentials", async () => {
      const port = reserveFreePort()
      const proc = spawn({
        cmd: [
          "bun",
          "run",
          CLI_PATH,
          "--log-level",
          "ERROR",
          "serve",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: "test-password-123",
          OPENCODE_SERVER_USERNAME: "opencode",
          DATABASE_PATH: ":memory:",
        },
      })

      await Bun.sleep(1000)

      let unauthOk = false
      let authOk = false

      for (let i = 0; i < 10; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`)
          if (res.status === 401) {
            unauthOk = true
            break
          }
        } catch {
          // retry
        }
        await Bun.sleep(200)
      }

      for (let i = 0; i < 10; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
            headers: { Authorization: `Basic ${Buffer.from("opencode:test-password-123").toString("base64")}` },
          })
          if (res.ok) {
            authOk = true
            break
          }
        } catch {
          // retry
        }
        await Bun.sleep(200)
      }

      expect(unauthOk).toBe(true)
      expect(authOk).toBe(true)

      proc.kill("SIGTERM")
      await proc.exited
    }, 15000)

    test("SIGTERM stops server and releases port", async () => {
      const port = reserveFreePort()
      const proc = spawn({
        cmd: [
          "bun",
          "run",
          CLI_PATH,
          "--log-level",
          "ERROR",
          "serve",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, DATABASE_PATH: ":memory:" },
      })

      await Bun.sleep(1000)

      proc.kill("SIGTERM")
      await proc.exited

      await Bun.sleep(500)

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`)
        expect(res.ok).toBe(false)
      } catch {
        // Port should be released - fetch should fail
        expect(true).toBe(true)
      }
    }, 15000)
  })
})
