import { getAdaptorVersion, resolveCompatibilityVersion } from "../config/index.ts"

export function getOpenCodeCompatVersion(): string {
  return resolveCompatibilityVersion()
}

export function getAdaptorVersionString(): string {
  return getAdaptorVersion()
}

export function printCompatVersion(): void {
  const version = getOpenCodeCompatVersion()
  process.stdout.write(version + "\n")
}

export function printAdaptorVersion(): void {
  const version = getAdaptorVersionString()
  process.stdout.write(version + "\n")
}

export function printVersionDetail(): void {
  process.stdout.write(`Adaptor Version: ${getAdaptorVersionString()}\n`)
  process.stdout.write(`OpenCode Compatibility Version: ${getOpenCodeCompatVersion()}\n`)
}
