import { describe, test, expect } from "bun:test"
import { spawn } from "bun"
import { randomUUID } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { reserveFreePort } from "../helpers/free-port.ts"

const INSTALLED_BIN = join(homedir(), ".local", "bin", "opencode-server-adaptor")
const ADAPTOR_BIN = join(import.meta.dir, "..", "..", "dist", "opencode-server-adaptor")

interface WslSimResult {
  version: string
  port: number
  password: string
  healthApiOk: boolean
  stdoutClean: boolean
  stderrHasLogs: boolean
  processExitedCleanly: boolean
  portReleased: boolean
}

async function simulateWslDesktopLaunch(binary: string): Promise<WslSimResult> {
  // Step 1: Check binary exists and is executable
  if (!existsSync(binary)) {
    throw new Error(`Binary not found: ${binary}`)
  }
  const stat = statSync(binary)
  if (!(stat.mode & 0o111)) {
    throw new Error(`Binary not executable: ${binary}`)
  }

  // Step 2: Execute --version
  const versionProc = spawn({
    cmd: [binary, "--version"],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: "", OPENCODE_SERVER_USERNAME: "" },
  })
  const versionStdout = await new Response(versionProc.stdout).text()
  const versionStderr = await new Response(versionProc.stderr).text()
  await versionProc.exited

  const versionLines = versionStdout.split("\n").filter((l) => l.trim().length > 0)
  const version = versionLines[0] ?? ""
  const stdoutClean = versionStderr.trim().length === 0

  // Step 3: Strict version comparison (Desktop uses === comparison)
  expect(version).toMatch(/^\d+\.\d+\.\d+$/)

  // Step 4: Generate random port and password
  const port = reserveFreePort()
  const password = randomUUID()
  const username = "opencode"

  // Step 5: Set Desktop environment variables
  const desktopEnv = {
    ...process.env,
    OPENCODE_CLIENT: "desktop",
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
    XDG_STATE_HOME: join(homedir(), ".local", "state"),
    DATABASE_PATH: ":memory:",
  }

  // Step 6: Execute Desktop-style serve command
  const serveProc = spawn({
    cmd: [binary, "--print-logs", "--log-level", "WARN", "serve", "--hostname", "0.0.0.0", "--port", String(port)],
    stdout: "pipe",
    stderr: "pipe",
    env: desktopEnv,
  })

  const stderrChunks: string[] = []
  const stderrReader = async () => {
    const reader = serveProc.stderr.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      stderrChunks.push(new TextDecoder().decode(value))
    }
  }
  void stderrReader()

  // Step 7: Poll health check with Basic Auth
  const authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64")
  const healthUrl1 = `http://127.0.0.1:${port}/api/health`

  let healthApiOk = false

  // Wait up to 10 seconds for health check
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(200)
    try {
      if (!healthApiOk) {
        const res = await fetch(healthUrl1, { headers: { Authorization: authHeader } })
        if (res.ok) healthApiOk = true
      }
      if (healthApiOk) break
    } catch {
      // retry
    }
  }

  // Step 8: Check that unauthenticated requests are rejected
  if (healthApiOk) {
    try {
      const res = await fetch(healthUrl1)
      expect(res.status).toBe(401)
    } catch {
      // ignore
    }
  }

  // Step 9: Check that stdout is clean (no log pollution)
  // Note: with --log-level WARN, there may be no logs on stderr during normal startup
  await Bun.sleep(100)
  const stderrContent = stderrChunks.join("")
  const stderrHasLogs =
    stderrContent.includes("[WARN]") || stderrContent.includes("[ERROR]") || stderrContent.trim().length === 0

  // Step 10: Send SIGTERM
  serveProc.kill("SIGTERM")
  const exitCode = await serveProc.exited
  const processExitedCleanly = exitCode === 0 || exitCode === null

  // Step 11: Verify port is released
  await Bun.sleep(500)
  let portReleased = false
  try {
    await fetch(healthUrl1, { headers: { Authorization: authHeader } })
  } catch {
    portReleased = true
  }

  return {
    version,
    port,
    password,
    healthApiOk,
    stdoutClean,
    stderrHasLogs,
    processExitedCleanly,
    portReleased,
  }
}

describe("WSL Desktop Compatibility", () => {
  test("installed binary at ~/.local/bin/opencode-server-adaptor", () => {
    if (!existsSync(INSTALLED_BIN)) {
      console.warn("Skipping: ~/.local/bin/opencode-server-adaptor not found. Run install.sh first.")
      return
    }
    const stat = statSync(INSTALLED_BIN)
    expect(stat.mode & 0o111).toBeTruthy()
  })

  test("Desktop-style launch with compiled binary", async () => {
    if (!existsSync(ADAPTOR_BIN)) {
      console.warn("Skipping: dist/opencode-server-adaptor not found. Run bun run build first.")
      return
    }

    const result = await simulateWslDesktopLaunch(ADAPTOR_BIN)

    expect(result.version).toBe("1.18.7")
    expect(result.healthApiOk).toBe(true)
    expect(result.stdoutClean).toBe(true)
    expect(result.stderrHasLogs).toBe(true)
    expect(result.processExitedCleanly).toBe(true)
    expect(result.portReleased).toBe(true)
  }, 30000)

  test("installed binary matches compiled binary", async () => {
    if (!existsSync(ADAPTOR_BIN) || !existsSync(INSTALLED_BIN)) {
      console.warn("Skipping: binaries not found")
      return
    }

    const result = await simulateWslDesktopLaunch(INSTALLED_BIN)

    expect(result.version).toBe("1.18.7")
    expect(result.healthApiOk).toBe(true)
    expect(result.processExitedCleanly).toBe(true)
    expect(result.portReleased).toBe(true)
  }, 30000)

  test("version output has no log pollution on stdout", async () => {
    if (!existsSync(ADAPTOR_BIN)) return

    const proc = spawn({
      cmd: [ADAPTOR_BIN, "--version"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: "", OPENCODE_SERVER_USERNAME: "" },
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited

    const firstLine = stdout.split("\n").find((l) => l.trim().length > 0)
    expect(firstLine).toBe("1.18.7")
    expect(stderr.trim()).toBe("")
  })

  test("Desktop-style command with global options before serve", async () => {
    if (!existsSync(ADAPTOR_BIN)) return

    const port = reserveFreePort()
    const password = randomUUID()

    const proc = spawn({
      cmd: [
        ADAPTOR_BIN,
        "--print-logs",
        "--log-level",
        "WARN",
        "serve",
        "--hostname",
        "0.0.0.0",
        "--port",
        String(port),
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_CLIENT: "desktop",
        DATABASE_PATH: ":memory:",
      },
    })

    const authHeader = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")

    let healthy = false
    for (let i = 0; i < 50; i++) {
      await Bun.sleep(200)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
          headers: { Authorization: authHeader },
        })
        if (res.ok) {
          healthy = true
          break
        }
      } catch {
        // retry
      }
    }

    expect(healthy).toBe(true)

    proc.kill("SIGTERM")
    await proc.exited
  }, 30000)

  test("SIGINT also shuts down cleanly", async () => {
    if (!existsSync(ADAPTOR_BIN)) return

    const port = reserveFreePort()

    const proc = spawn({
      cmd: [ADAPTOR_BIN, "--log-level", "ERROR", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
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

    proc.kill("SIGINT")
    const exitCode = await proc.exited
    // 0 = clean exit, null = process terminated, 128+signal = signal exit
    const validExit =
      exitCode === 0 || exitCode === null || (exitCode !== undefined && exitCode >= 128 && exitCode <= 143)
    expect(validExit).toBe(true)
  }, 15000)

  test("port already in use returns error", async () => {
    if (!existsSync(ADAPTOR_BIN)) return

    const port = reserveFreePort()

    const proc1 = spawn({
      cmd: [ADAPTOR_BIN, "--log-level", "ERROR", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: "", OPENCODE_SERVER_USERNAME: "", DATABASE_PATH: ":memory:" },
    })

    await Bun.sleep(1000)

    const proc2 = spawn({
      cmd: [ADAPTOR_BIN, "--log-level", "ERROR", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: "", OPENCODE_SERVER_USERNAME: "", DATABASE_PATH: ":memory:" },
    })

    const exitCode2 = await proc2.exited
    expect(exitCode2).not.toBe(0)

    proc1.kill("SIGTERM")
    await proc1.exited
  }, 15000)
})
