import {
  readConfigFile,
  writeConfigFile,
  resolveCompatibilityVersion,
  isSupportedVersion,
} from "../config/index.ts"

export function getCompatibilityVersion(): string {
  return resolveCompatibilityVersion()
}

export function setCompatibilityVersion(version: string): void {
  if (!isSupportedVersion(version)) {
    throw new Error(
      `Invalid version format: ${version}\nExpected a version in N.N.N format (e.g. 1.18.7).`,
    )
  }

  const config = readConfigFile()
  config.compatibilityVersion = version
  writeConfigFile(config)
}

export function printCompatibilityVersion(): void {
  process.stdout.write(getCompatibilityVersion() + "\n")
}
