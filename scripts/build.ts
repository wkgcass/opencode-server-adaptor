#!/usr/bin/env bun
/**
 * Build script for opencode-server-adaptor
 * Produces a single-file Linux executable using Bun compile
 */

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"

const OUTDIR = "dist"
const ENTRY = "src/cli.ts"
const OUTPUT = `${OUTDIR}/opencode-server-adaptor`

const targets: Array<{ name: string; target: string }> = [
  { name: "linux-x64-baseline", target: "bun-linux-x64-baseline" },
  { name: "linux-x64-modern", target: "bun-linux-x64-modern" },
  { name: "linux-arm64", target: "bun-linux-arm64" },
]

async function build() {
  if (!existsSync(OUTDIR)) {
    mkdirSync(OUTDIR, { recursive: true })
  }

  const defaultTarget = "bun-linux-x64-baseline"

  console.log(`Building ${ENTRY} -> ${OUTPUT} (${defaultTarget})`)

  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir: OUTDIR,
    compile: defaultTarget as Bun.Build.CompileTarget,
    minify: true,
    sourcemap: "none",
  })

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log)
    }
    process.exit(1)
  }

  // Bun compile names the output after the entrypoint (cli), rename it
  const compiledDefault = join(OUTDIR, "cli")
  if (existsSync(compiledDefault)) {
    if (existsSync(OUTPUT)) {
      rmSync(OUTPUT)
    }
    renameSync(compiledDefault, OUTPUT)
  }

  console.log(`Build complete: ${OUTPUT}`)

  if (process.env.BUILD_ALL_TARGETS === "1") {
    for (const t of targets) {
      const outFile = `${OUTDIR}/opencode-server-adaptor-${t.name}`
      console.log(`Building ${outFile} (${t.target})`)
      const r = await Bun.build({
        entrypoints: [ENTRY],
        outdir: OUTDIR,
        compile: t.target as Bun.Build.CompileTarget,
        minify: true,
        sourcemap: "none",
      })
      if (!r.success) {
        for (const log of r.logs) {
          console.error(log)
        }
        process.exit(1)
      }
      // Rename from cli to target-specific name
      const compiledFile = join(OUTDIR, "cli")
      if (existsSync(compiledFile)) {
        if (existsSync(outFile)) {
          rmSync(outFile)
        }
        renameSync(compiledFile, outFile)
      }
      console.log(`Build complete: ${outFile}`)
    }
  }
}

build()
